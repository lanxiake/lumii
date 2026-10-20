/**
 * 事件负载映射的约束。
 *
 * 用 `object` 而不是 `Record<string, unknown>`：后者要求索引签名，
 * 会让 `interface MyEvents { tick: {...} }` 这种正常写法编译不过。
 */
export type EventMap = object;

export type Listener<T> = (payload: T) => unknown;
export type WaterfallListener<T> = (payload: T, next: () => Promise<T>) => Promise<T>;

export interface EventBusOptions {
  /** 监听器抛错时的落点；默认 console.error */
  onListenerError?: (event: string, error: unknown) => void;
}

/**
 * 事件总线。
 *
 * 四种派发方式，模式由**调用方**决定（注册侧不用声明）：
 * - `emit`      fire-and-forget，监听器异常被吞并记录，绝不打断发射方；
 * - `waterfall` 环绕中间件，监听器拿 (payload, next)，不调 next 即短路，可改 payload；
 * - `serial`    按注册顺序 await，值依次传递；
 * - `parallel`  全部并发 await，任一失败最后抛 AggregateError（但不会中断其他监听器）。
 *
 * 事件名与负载由泛型 E 决定，plugin-core 本身不含任何业务事件。
 */
export class EventBus<E extends EventMap = EventMap> {
  private readonly listeners = new Map<string, Listener<unknown>[]>();
  private readonly waterfallListeners = new Map<string, WaterfallListener<unknown>[]>();
  private readonly onListenerError: (event: string, error: unknown) => void;

  constructor(options: EventBusOptions = {}) {
    this.onListenerError =
      options.onListenerError ?? ((event, error) => console.error(`[event:${event}] 监听器异常`, error));
  }

  on<K extends keyof E & string>(name: K, listener: Listener<E[K]>): () => void {
    return this.add(this.listeners, name, listener as Listener<unknown>);
  }

  onWaterfall<K extends keyof E & string>(name: K, listener: WaterfallListener<E[K]>): () => void {
    return this.add(this.waterfallListeners, name, listener as WaterfallListener<unknown>);
  }

  listenerCount(name: keyof E & string): number {
    return (this.listeners.get(name)?.length ?? 0) + (this.waterfallListeners.get(name)?.length ?? 0);
  }

  emit<K extends keyof E & string>(name: K, payload: E[K]): void {
    for (const listener of this.snapshot(this.listeners, name)) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) result.catch((error) => this.onListenerError(name, error));
      } catch (error) {
        this.onListenerError(name, error);
      }
    }
  }

  async waterfall<K extends keyof E & string>(name: K, payload: E[K]): Promise<E[K]> {
    const chain = this.snapshot(this.waterfallListeners, name);
    let index = 0;
    let current = payload;

    const next = async (): Promise<E[K]> => {
      const listener = chain[index++];
      if (!listener) return current;
      return listener(current, next) as Promise<E[K]>;
    };

    return next();
  }

  async serial<K extends keyof E & string>(name: K, payload: E[K]): Promise<E[K]> {
    let current = payload;
    for (const listener of this.snapshot(this.listeners, name)) {
      const result = await listener(current);
      if (result !== undefined) current = result as E[K];
    }
    return current;
  }

  async parallel<K extends keyof E & string>(name: K, payload: E[K]): Promise<void> {
    const listeners = this.snapshot(this.listeners, name);
    if (listeners.length === 0) return;

    const results = await Promise.allSettled(listeners.map((listener) => listener(payload)));
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        this.onListenerError(name, result.reason);
        errors.push(result.reason);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `事件 ${String(name)} 有 ${errors.length} 个监听器失败`);
    }
  }

  private add<T>(map: Map<string, T[]>, name: string, listener: T): () => void {
    const list = map.get(name);
    if (list) list.push(listener);
    else map.set(name, [listener]);

    return () => {
      const current = map.get(name);
      if (!current) return;
      const index = current.indexOf(listener);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) map.delete(name);
    };
  }

  /** 取快照：监听器在派发过程中增删不影响本轮。 */
  private snapshot<T>(map: Map<string, T[]>, name: string): T[] {
    const list = map.get(name);
    return list ? [...list] : [];
  }
}
