import { createPluginContext, ServiceContainer, type PluginContext } from "./context.js";
import { PluginDependencyCycleError, PluginError } from "./errors.js";
import { EventBus, type EventMap } from "./events.js";
import { PluginScope, type DisposeResult } from "./scope.js";
import { createPluginLogger, type LoggerSink } from "./types.js";

export interface PluginDefinition<E extends EventMap = EventMap> {
  id: string;
  /** 必需的服务 key；缺失时插件停在 pending，服务出现后自动激活 */
  inject?: string[];
  /** 可选服务 key；缺失照常激活（插件自己 get 判空） */
  injectOptional?: string[];
  /** 本插件会提供的服务 key；决定激活顺序 */
  provides?: string[];
  /**
   * `apply` 的执行时限（ms），超时判 failed 并清理已登记的作用域。
   * 缺省用宿主级 `activationTimeoutMs`（默认 10s）。
   *
   * 存在的理由：Agent 自举写的插件里一个 `while(true)` 会卡死主进程，
   * 而这类代码不可能靠静态检查挡住。
   */
  activationTimeoutMs?: number;
  apply(ctx: PluginContext<E>): void | Promise<void>;
}

/**
 * 插件生命周期状态。
 *
 * `pending` 与 `failed` 的区别是本内核的核心语义：
 * - `pending`：**依赖还没到**，等着，服务一出现就自动激活（不是错误）；
 * - `failed`：**自己坏了**（apply 抛错 / 激活超时），需要人或新版本介入。
 *
 * 混为一谈会让「先启插件、后提供依赖」这种正常时序变成一片红灯。
 */
export type PluginState =
  | "registered"
  | "pending"
  | "activating"
  | "active"
  | "failed"
  | "stopped";

export interface LoadedPlugin {
  id: string;
  definition: PluginDefinition;
  state: PluginState;
  scope?: PluginScope;
  activationMs?: number;
  error?: unknown;
  /** 停在 pending 的原因：缺哪些服务 */
  missingServices?: string[];
}

export interface StartReport {
  activated: string[];
  failed: Array<{ id: string; error: unknown }>;
  /** 缺依赖没起来的（不是失败，是等待） */
  pending: string[];
}

export interface PluginStateChange {
  id: string;
  from: PluginState;
  to: PluginState;
  activationMs?: number;
  error?: unknown;
  missingServices?: string[];
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
  /** `apply` 默认时限（ms）；插件可在自己的 definition 里覆盖 */
  activationTimeoutMs?: number;
}

const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;

/**
 * 最小插件宿主：注册 → 拓扑排序 → 按依赖激活 → 支持单独停止与依赖联动。
 *
 * 三条核心语义（对齐 Cordis 的对应部分，均为自研实现）：
 *
 * 1. **依赖驱动**：缺必需服务的插件停在 `pending`；服务出现时自动激活。
 * 2. **级联停用**：提供的服务消失时，依赖它的 active 插件一起停回 `pending`。
 * 3. **可嵌套作用域**：插件用 `ctx.fork()` 按实体开子作用域，随父作用域清理。
 *
 * 不做隔离、不做权限（自用客户端，插件与主进程同权限）。
 */
export class PluginHost<E extends EventMap = EventMap> {
  readonly eventBus: EventBus<E>;
  readonly container: ServiceContainer;

  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly loggerSink?: LoggerSink;
  private readonly ipcRegistry?: PluginHostOptions<E>['ipcRegistry'];
  private readonly defaultTimeoutMs: number;
  private readonly stateListeners = new Set<(change: PluginStateChange) => void>();

  /** 依赖联动可能递归（stop → 服务移除 → 再 stop），用闸门收敛成一次处理 */
  private reconciling = false;
  private reconcileAgain = false;
  /** 用户显式排除的插件（运行期禁用）不参与自动激活 */
  private excluded = new Set<string>();

  constructor(options: PluginHostOptions<E> = {}) {
    this.eventBus = options.eventBus ?? new EventBus<E>();
    this.container = options.container ?? new ServiceContainer();
    this.loggerSink = options.loggerSink;
    this.ipcRegistry = options.ipcRegistry;
    this.defaultTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;

    // 服务出现/消失 → 重新评估所有等待中的插件、级联停用失去依赖的插件
    this.container.onChange((change) => {
      if (change.type === 'remove') void this.reconcile(change.key);
      else void this.reconcile();
    });
  }

  /** 订阅状态迁移；返回退订函数。 */
  onStateChange(listener: (change: PluginStateChange) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
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
   * 按依赖顺序激活已注册插件。
   *
   * 单个插件失败只标记 failed 并继续，不拖垮宿主；
   * 依赖成环直接抛错 —— 那是编排错误，不该带病运行。
   *
   * `exclude` 里的插件**保持 registered、不激活、也不参与自动激活**：
   * 它们仍然登记在宿主里，之后可以随时 `activate(id)` 起来（运行时启用的前提）。
   */
  async start(options: { exclude?: ReadonlySet<string> } = {}): Promise<StartReport> {
    const order = this.resolveOrder();
    this.excluded = new Set(options.exclude ?? []);
    const report: StartReport = { activated: [], failed: [], pending: [] };

    for (const id of order) {
      if (this.excluded.has(id)) continue;
      const entry = this.plugins.get(id);
      if (!entry || !this.isStartable(entry.state)) continue;

      const error = await this.activate(id);
      if (error) report.failed.push({ id, error });
      else if (entry.state === "pending") report.pending.push(id);
      else report.activated.push(id);
    }

    return report;
  }

  /**
   * 激活单个插件。
   *
   * - 缺必需服务 → 进 `pending`，**返回 undefined**（不是失败，是等待）；
   * - `apply` 抛错或超时 → 进 `failed`，返回错误。
   *
   * 返回 undefined 的 pending 语义很重要：设置页把插件打开时依赖可能还没就绪，
   * 这时应当显示「等待依赖」而不是「失败」。
   */
  async activate(id: string): Promise<unknown | undefined> {
    const entry = this.plugins.get(id);
    if (!entry || entry.state === "active" || entry.state === "activating") return undefined;

    const missing = this.missingFor(entry.definition);
    if (missing.length > 0) {
      this.transition(entry, "pending", { missingServices: missing });
      return undefined;
    }

    const startedAt = performance.now();
    this.transition(entry, "activating", { missingServices: undefined });

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

    const timeoutMs = entry.definition.activationTimeoutMs ?? this.defaultTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const applied = Promise.resolve().then(() => entry.definition.apply(ctx));
    // 超时后 apply 仍可能在跑：必须挂上 catch，否则是一个静默的 unhandled rejection
    applied.catch(() => undefined);

    try {
      await Promise.race([
        applied,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PluginError(id, `激活超时（>${timeoutMs}ms）`)),
            timeoutMs,
          );
        }),
      ]);
      entry.activationMs = performance.now() - startedAt;
      this.transition(entry, "active", { activationMs: entry.activationMs });
      return undefined;
    } catch (error) {
      await scope.dispose();
      this.dropServices(entry.definition.provides);
      this.transition(entry, "failed", { error });
      return error;
    } finally {
      if (timer) clearTimeout(timer);
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

  /**
   * 停止单个插件：逆序清理作用域，并移除它提供的服务。
   *
   * 移除服务会触发容器变更 → 依赖它的插件自动级联停回 `pending`（见 `reconcile`）。
   * 这是正确语义：提供方都不在了，依赖方继续拿着失效引用只会更糟。
   */
  async stop(id: string): Promise<DisposeResult> {
    const entry = this.plugins.get(id);
    if (!entry) return { ok: true };
    if (entry.state !== "active" && entry.state !== "activating") return { ok: true };

    const result = (await entry.scope?.dispose()) ?? { ok: true };
    entry.scope = undefined;
    this.dropServices(entry.definition.provides);
    this.transition(entry, "stopped", { missingServices: undefined });
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

  /**
   * 重新评估所有 pending 插件；并（服务消失时）级联停用失去依赖的 active 插件。
   *
   * 递归可能来自 stop() 里移除服务再次触发本函数，用闸门收敛成一轮。
   */
  private async reconcile(removedKey?: string): Promise<void> {
    if (this.reconciling) {
      this.reconcileAgain = true;
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.reconcileAgain = false;
        await this.cascadeStop(removedKey);
        removedKey = undefined;

        // 依赖顺序激活：只要容器里有变化，就按拓扑序补一轮。
        //
        // **只有 `pending` 会被自动拉起**。`stopped` 是用户显式关掉的，
        // `registered` 还没开始、`failed` 得等人修——把它们也顺带激活，
        // 就会出现「用户刚关掉提供方，依赖联动又把它打开了」。
        for (const id of this.resolveOrder()) {
          const entry = this.plugins.get(id);
          if (!entry || entry.state !== "pending") continue;
          if (this.excluded.has(id)) continue;
          if (this.missingFor(entry.definition).length > 0) continue;
          await this.activate(id);
        }
      } while (this.reconcileAgain);
    } finally {
      this.reconciling = false;
    }
  }

  /** 服务消失后，把所有依赖它的 active 插件停回 pending（按激活逆序，先停下游）。 */
  private async cascadeStop(removedKey?: string): Promise<void> {
    if (!removedKey) return;
    const dependents = [...this.plugins.values()]
      .filter((entry) => entry.state === "active" && (entry.definition.inject ?? []).includes(removedKey))
      .reverse();

    for (const entry of dependents) {
      await entry.scope?.dispose();
      entry.scope = undefined;
      this.transition(entry, "pending", { missingServices: this.missingFor(entry.definition) });
    }
  }

  private isStartable(state: PluginState): boolean {
    return state !== "active" && state !== "activating";
  }

  private missingFor(definition: PluginDefinition): string[] {
    return (definition.inject ?? []).filter((key) => !this.container.has(key));
  }

  private transition(
    entry: LoadedPlugin,
    to: PluginState,
    extra: Partial<Pick<LoadedPlugin, "activationMs" | "error" | "missingServices">> = {},
  ): void {
    const from = entry.state;
    entry.state = to;
    if (extra.activationMs !== undefined) entry.activationMs = extra.activationMs;
    if ("error" in extra) entry.error = extra.error;
    if ("missingServices" in extra) entry.missingServices = extra.missingServices;
    if (from === to) return;

    for (const listener of [...this.stateListeners]) {
      try {
        listener({
          id: entry.id,
          from,
          to,
          activationMs: entry.activationMs,
          error: entry.error,
          missingServices: entry.missingServices,
        });
      } catch {
        // 观察者抛错不影响宿主
      }
    }
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
