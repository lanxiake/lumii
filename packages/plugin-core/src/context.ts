import type { EventBus, EventMap, Listener, WaterfallListener } from "./events.js";
import { DuplicateServiceError, MissingServiceError } from "./errors.js";
import type { PluginScope } from "./scope.js";
import type { PluginLogger, ServiceKey } from "./types.js";

/**
 * 服务容器：跨插件共享，插件卸载时移除自己 provide 的项。
 *
 * 工厂形态（`provide(key, () => value)`）只在首次 `get/require` 时求值一次。
 */
export class ServiceContainer {
  private readonly values = new Map<string, unknown>();
  private readonly factories = new Map<string, () => unknown>();

  provide<T>(key: ServiceKey<T>, value: T | (() => T)): void {
    const name = key as string;
    if (this.values.has(name) || this.factories.has(name)) {
      throw new DuplicateServiceError("service", name);
    }
    if (typeof value === "function") this.factories.set(name, value as () => T);
    else this.values.set(name, value);
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
    this.values.delete(name);
    this.factories.delete(name);
  }
}

export interface PluginContext<E extends EventMap = EventMap> {
  readonly pluginId: string;
  readonly log: PluginLogger;

  /** 注册服务；随插件卸载自动移除。 */
  provide<T>(key: ServiceKey<T>, value: T | (() => T)): void;
  get<T>(key: ServiceKey<T>): T | undefined;
  require<T>(key: ServiceKey<T>): T;

  /** 注册可逆副作用；dispose 按 LIFO 执行。 */
  effect(dispose: () => void | Promise<void>): void;

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
}

export function createPluginContext<E extends EventMap>(
  deps: ContextDeps<E>,
): PluginContext<E> {
  const { pluginId, container, eventBus, scope, logger } = deps;

  return {
    pluginId,
    log: logger,

    provide<T>(key: ServiceKey<T>, value: T | (() => T)): void {
      container.provide(key, value);
      scope.effect(() => container.remove(key));
    },

    get<T>(key: ServiceKey<T>): T | undefined {
      return container.get(key);
    },

    require<T>(key: ServiceKey<T>): T {
      return container.require(key, pluginId);
    },

    effect(dispose: () => void | Promise<void>): void {
      scope.effect(dispose);
    },

    on(name, listener) {
      const off = eventBus.on(name, listener);
      scope.effect(off);
    },

    onWaterfall(name, listener) {
      const off = eventBus.onWaterfall(name, listener);
      scope.effect(off);
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
}
