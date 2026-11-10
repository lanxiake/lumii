import type { EventBus, EventMap, Listener, WaterfallListener } from "./events.js";
import { DuplicateServiceError, MissingServiceError } from "./errors.js";
import type { EffectValue, PluginScope } from "./scope.js";
import type { PluginLogger, ServiceKey } from "./types.js";

/**
 * 服务容器：跨插件共享，插件卸载时移除自己 provide 的项。
 *
 * 工厂形态（`provide(key, () => value)`）只在首次 `get/require` 时求值一次。
 *
 * `onChange` 是依赖驱动的唯一信号源：宿主要知道「哪个 key 变成了可用/不可用」，
 * 才能在服务出现时激活 PENDING 插件、在服务消失时级联停用依赖方。
 * 只用「容器最终状态」判断是不够的——需要知道变化的方向。
 */
export class ServiceContainer {
  private readonly values = new Map<string, unknown>();
  private readonly factories = new Map<string, () => unknown>();
  private readonly listeners = new Set<(change: ServiceChange) => void>();

  /** 订阅容器变更；返回退订函数。监听器异常不影响提供方。 */
  onChange(listener: (change: ServiceChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(change: ServiceChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        // 通知方不该因为某个订阅者抛错而中断提供/移除
      }
    }
  }

  provide<T>(key: ServiceKey<T>, value: T | (() => T), owner = "unknown"): void {
    const name = key as string;
    if (this.values.has(name) || this.factories.has(name)) {
      // owner 必须是发起方，否则冲突日志会写成 `[service] service "x" 已被注册`，
      // 谁也看不出是谁撞了谁
      throw new DuplicateServiceError(owner, name);
    }
    if (typeof value === "function") this.factories.set(name, value as () => T);
    else this.values.set(name, value);
    this.notify({ type: "provide", key: name, owner });
  }

  get<T>(key: ServiceKey<T>): T | undefined {
    const name = key as string;
    if (this.values.has(name)) return this.values.get(name) as T;

    const factory = this.factories.get(name);
    if (!factory) return undefined;

    const value = factory() as T;
    this.values.set(name, value);
    this.factories.delete(name);
    return value;
  }

  require<T>(key: ServiceKey<T>, requester = "kernel"): T {
    const value = this.get(key);
    if (value === undefined) throw new MissingServiceError(requester, key as string);
    return value;
  }

  has(key: ServiceKey<unknown>): boolean {
    const name = key as string;
    return this.values.has(name) || this.factories.has(name);
  }

  keys(): string[] {
    return [...new Set([...this.values.keys(), ...this.factories.keys()])];
  }

  remove(key: ServiceKey<unknown>): void {
    const name = key as string;
    const existed = this.values.has(name) || this.factories.has(name);
    this.values.delete(name);
    this.factories.delete(name);
    if (existed) this.notify({ type: "remove", key: name });
  }
}

/** 容器变更：`provide` = 新服务可用；`remove` = 服务消失（依赖方应级联停用）。 */
export interface ServiceChange {
  type: "provide" | "remove";
  key: string;
  /** provide 时是提供方插件 id */
  owner?: string;
}

export interface PluginContext<E extends EventMap = EventMap> {
  readonly pluginId: string;
  readonly log: PluginLogger;

  /** 注册服务；随插件卸载自动移除。 */
  provide<T>(key: ServiceKey<T>, value: T | (() => T)): void;
  get<T>(key: ServiceKey<T>): T | undefined;
  require<T>(key: ServiceKey<T>): T;

  /** 注册可逆副作用；dispose 按 LIFO 执行。 */
  effect(dispose: EffectValue): void;

  /**
   * 开一个**子作用域**：随本插件作用域销毁；也可以在调用方提前 dispose。
   *
   * 用于按实体登记资源（每个会话的工具、每个窗口的监听器）：
   * 实体消失时只拆那一棵子树，插件本体继续服务其余实体。
   *
   * 子上下文共享同一服务容器与事件总线，只有作用域是新的。
   */
  fork(name?: string): PluginContext<E>;

  /**
   * 注册 IPC 处理器（仅主进程可用）。
   *
   * 插件卸载时自动 `removeHandler`；重复注册同一通道会先摘掉旧的。
   * 渲染层不支持此 API（调用时静默 no-op）。
   *
   * @param channel - IPC 通道名（约定：扩展自有通道用 `ext:<id>:*` 前缀避免冲突）
   * @param handler - 处理函数，签名与 `ipcMain.handle` 一致
   */
  registerIpc?(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  /**
   * 注册单向 IPC 监听（对应 `ipcMain.on`）：随插件作用域移除。
   * 插件**不要**直接碰 ipcMain——那样停用摘不掉。
   */
  registerIpcListener?(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;

  on<K extends keyof E & string>(name: K, listener: Listener<E[K]>): void;
  onWaterfall<K extends keyof E & string>(name: K, listener: WaterfallListener<E[K]>): void;
  emit<K extends keyof E & string>(name: K, payload: E[K]): void;
  waterfall<K extends keyof E & string>(name: K, payload: E[K]): Promise<E[K]>;
  serial<K extends keyof E & string>(name: K, payload: E[K]): Promise<E[K]>;
  parallel<K extends keyof E & string>(name: K, payload: E[K]): Promise<void>;
}

export interface ContextDeps<E extends EventMap> {
  pluginId: string;
  container: ServiceContainer;
  eventBus: EventBus<E>;
  scope: PluginScope;
  logger: PluginLogger;
  /** 可选：主进程 IPC 注册器（渲染层不提供） */
  ipcRegistry?: {
    register(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
    unregister(channel: string): void;
    registerListener?(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
    unregisterListener?(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  };
}

export function createPluginContext<E extends EventMap>(
  deps: ContextDeps<E>,
): PluginContext<E> {
  const { pluginId, container, eventBus, scope, logger, ipcRegistry } = deps;

  const build = (current: PluginScope, label?: string): PluginContext<E> => {
    const ctx: PluginContext<E> = {
      pluginId,
      log: label ? { ...logger, info: (m, d) => logger.info(`[${label}] ${m}`, d) } : logger,

      provide<T>(key: ServiceKey<T>, value: T | (() => T)): void {
        container.provide(key, value, pluginId);
        // internal：这行清理是容器簿记，不是扩展登记的 teardown
        current.effect(() => container.remove(key), "internal");
      },

      get<T>(key: ServiceKey<T>): T | undefined {
        return container.get(key);
      },

      require<T>(key: ServiceKey<T>): T {
        return container.require(key, pluginId);
      },

      effect(dispose: EffectValue): void {
        current.effect(dispose);
      },

      fork(name?: string): PluginContext<E> {
        return build(current.fork(), name ?? "sub");
      },

      on(name, listener) {
        const off = eventBus.on(name, listener);
        current.effect(off);
      },

      onWaterfall(name, listener) {
        const off = eventBus.onWaterfall(name, listener);
        current.effect(off);
      },

      emit(name, payload) {
        eventBus.emit(name, payload);
      },

      waterfall(name, payload) {
        return eventBus.waterfall(name, payload);
      },

      serial(name, payload) {
        return eventBus.serial(name, payload);
      },

      parallel(name, payload) {
        return eventBus.parallel(name, payload);
      },
    };

    // 主进程才有 IPC 注册能力
    if (ipcRegistry) {
      ctx.registerIpc = (channel, handler) => {
        ipcRegistry.register(channel, handler);
        current.effect(() => ipcRegistry.unregister(channel));
      };
      ctx.registerIpcListener = (channel, listener) => {
        ipcRegistry.registerListener?.(channel, listener);
        current.effect(() => ipcRegistry.unregisterListener?.(channel, listener));
      };
    }

    return ctx;
  };

  return build(scope);
}
