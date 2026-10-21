import { createPluginContext, ServiceContainer, type PluginContext } from "./context.js";
import { PluginDependencyCycleError, PluginError } from "./errors.js";
import { EventBus, type EventMap } from "./events.js";
import { PluginScope, type DisposeResult } from "./scope.js";
import { createPluginLogger, type LoggerSink } from "./types.js";

export interface PluginDefinition<E extends EventMap = EventMap> {
  id: string;
  /** 必需的服务 key；决定激活顺序，缺失则本插件不激活 */
  inject?: string[];
  /** 可选服务 key；缺失照常激活（插件自己 get 判空） */
  injectOptional?: string[];
  /** 本插件会提供的服务 key；决定激活顺序 */
  provides?: string[];
  apply(ctx: PluginContext<E>): void | Promise<void>;
}

export type PluginState = "registered" | "activating" | "active" | "failed" | "stopped";

export interface LoadedPlugin {
  id: string;
  definition: PluginDefinition;
  state: PluginState;
  scope?: PluginScope;
  activationMs?: number;
  error?: unknown;
}

export interface StartReport {
  activated: string[];
  failed: Array<{ id: string; error: unknown }>;
}

export interface PluginHostOptions<E extends EventMap> {
  eventBus?: EventBus<E>;
  container?: ServiceContainer;
  loggerSink?: LoggerSink;
  /** 主进程 IPC 注册器（渲染层不提供） */
  ipcRegistry?: {
    register(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
    unregister(channel: string): void;
  };
}

/**
 * 最小插件宿主：注册 → 拓扑排序 → 逐个激活 → 支持单独停止。
 *
 * 只做顺序与生命周期，不做隔离、不做权限（自用客户端，插件与主进程同权限）。
 */
export class PluginHost<E extends EventMap = EventMap> {
  readonly eventBus: EventBus<E>;
  readonly container: ServiceContainer;

  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly loggerSink?: LoggerSink;
  private readonly ipcRegistry?: PluginHostOptions<E>['ipcRegistry'];

  constructor(options: PluginHostOptions<E> = {}) {
    this.eventBus = options.eventBus ?? new EventBus<E>();
    this.container = options.container ?? new ServiceContainer();
    this.loggerSink = options.loggerSink;
    this.ipcRegistry = options.ipcRegistry;
  }

  register(definition: PluginDefinition<E>): void {
    if (this.plugins.has(definition.id)) {
      throw new PluginError(definition.id, "插件 id 重复注册");
    }
    this.plugins.set(definition.id, { id: definition.id, definition, state: "registered" });
  }

  get(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * 按依赖顺序激活全部已注册插件。
   *
   * 单个插件失败只标记 failed 并继续，不拖垮宿主；
   * 依赖成环直接抛错 —— 那是编排错误，不该带病运行。
   */
  async start(): Promise<StartReport> {
    const order = this.resolveOrder();
    const report: StartReport = { activated: [], failed: [] };

    for (const id of order) {
      const entry = this.plugins.get(id);
      if (!entry || entry.state !== "registered") continue;

      const error = await this.activate(id);
      if (error) report.failed.push({ id, error });
      else report.activated.push(id);
    }

    return report;
  }

  /**
   * 激活单个已注册插件。
   *
   * @returns 成功返回 undefined，失败返回错误（不抛）——调用方多为加载器/热重载，
   *          它们需要的是「这一个失败了」而不是整个流程中断。
   */
  async activate(id: string): Promise<unknown | undefined> {
    const entry = this.plugins.get(id);
    if (!entry || entry.state === "active") return undefined;

    const missing = (entry.definition.inject ?? []).filter((key) => !this.container.has(key));
    if (missing.length > 0) {
      entry.state = "failed";
      entry.error = new PluginError(id, `缺少依赖服务：${missing.join(", ")}`);
      return entry.error;
    }

    const startedAt = performance.now();
    entry.state = "activating";

    const scope = new PluginScope(id);
    entry.scope = scope;
    const ctx = createPluginContext({
      pluginId: id,
      container: this.container,
      eventBus: this.eventBus,
      scope,
      logger: createPluginLogger(id, this.loggerSink),
      ipcRegistry: this.ipcRegistry,
    });

    try {
      await entry.definition.apply(ctx);
      entry.state = "active";
      entry.activationMs = performance.now() - startedAt;
      return undefined;
    } catch (error) {
      entry.state = "failed";
      entry.error = error;
      await scope.dispose();
      this.dropServices(entry.definition.provides);
      return error;
    }
  }

  /**
   * 把已注册插件整个摘掉（停用 + 从宿主移除）。
   *
   * 与 `stop()` 的区别：stop 保留登记，可以再 activate；unregister 之后
   * `get(id)` 拿到的是 undefined，用于外部扩展目录被删除的场景。
   */
  async unregister(id: string): Promise<DisposeResult> {
    const result = await this.stop(id);
    this.plugins.delete(id);
    return result;
  }

  /** 停止单个插件：逆序清理作用域，并移除它提供的服务。 */
  async stop(id: string): Promise<DisposeResult> {
    const entry = this.plugins.get(id);
    if (!entry) return { ok: true };
    if (entry.state !== "active") return { ok: true };

    const result = (await entry.scope?.dispose()) ?? { ok: true };
    entry.state = "stopped";
    this.dropServices(entry.definition.provides);
    return result;
  }

  /** 全部停止：按激活的逆序。 */
  async stopAll(): Promise<Map<string, DisposeResult>> {
    const results = new Map<string, DisposeResult>();
    const active = [...this.plugins.values()]
      .filter((entry) => entry.state === "active")
      .reverse();

    for (const entry of active) {
      results.set(entry.id, await this.stop(entry.id));
    }
    return results;
  }

  private dropServices(keys: string[] | undefined): void {
    for (const key of keys ?? []) this.container.remove(key);
  }

  /** Kahn 拓扑排序；剩余节点即成环，用 DFS 找出具体环路报错。 */
  private resolveOrder(): string[] {
    const providerOf = new Map<string, string>();
    for (const entry of this.plugins.values()) {
      for (const key of entry.definition.provides ?? []) providerOf.set(key, entry.id);
    }

    const edges = new Map<string, Set<string>>();
    const indegree = new Map<string, number>();
    for (const id of this.plugins.keys()) {
      edges.set(id, new Set());
      indegree.set(id, 0);
    }

    for (const entry of this.plugins.values()) {
      for (const key of entry.definition.inject ?? []) {
        const provider = providerOf.get(key);
        if (!provider || provider === entry.id) continue;
        const targets = edges.get(provider);
        if (targets?.has(entry.id)) continue;
        targets?.add(entry.id);
        indegree.set(entry.id, (indegree.get(entry.id) ?? 0) + 1);
      }
    }

    const queue = [...indegree.entries()].filter(([, deg]) => deg === 0).map(([id]) => id);
    const order: string[] = [];

    while (queue.length > 0) {
      const id = queue.shift() as string;
      order.push(id);
      for (const next of edges.get(id) ?? []) {
        const deg = (indegree.get(next) ?? 1) - 1;
        indegree.set(next, deg);
        if (deg === 0) queue.push(next);
      }
    }

    if (order.length !== this.plugins.size) {
      const stuck = [...indegree.entries()].filter(([, deg]) => deg > 0).map(([id]) => id);
      throw new PluginDependencyCycleError(stuck[0] ?? "?", this.findCycle(stuck, edges));
    }

    return order;
  }

  private findCycle(candidates: string[], edges: Map<string, Set<string>>): string[] {
    const start = candidates[0];
    const path: string[] = [];
    const seen = new Set<string>();

    const walk = (id: string): string[] | null => {
      if (seen.has(id)) return [...path.slice(path.indexOf(id)), id];
      seen.add(id);
      path.push(id);
      for (const next of edges.get(id) ?? []) {
        if (candidates.includes(next)) {
          const found = walk(next);
          if (found) return found;
        }
      }
      path.pop();
      return null;
    };

    return start ? (walk(start) ?? candidates) : candidates;
  }
}

/** 恒等函数，只为类型推导。 */
export function definePlugin<E extends EventMap = EventMap>(
  definition: PluginDefinition<E>,
): PluginDefinition<E> {
  return definition;
}
