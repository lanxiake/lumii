import { ScopeAlreadyDisposedError } from "./errors.js";

export interface DisposeResult {
  ok: boolean;
  /** 每个失败 disposer 的下标与异常；ok=true 时为 undefined */
  errors?: Array<{ index: number; error: unknown }>;
}

/**
 * 插件作用域：登记所有可逆副作用，卸载时按 LIFO 撤销。
 *
 * 三条不变量（都有单测覆盖）：
 * 1. 后注册的先清理；
 * 2. 异步 disposer 串行 await —— 并发清理会导致「依赖先于提供者销毁」；
 * 3. 中途失败不中断，继续清理完，最后一次性返回失败清单。
 */
export class PluginScope {
  private disposers: Array<() => void | Promise<void>> = [];
  private disposed = false;
  private disposing: Promise<DisposeResult> | null = null;
  private teardownCount = 0;

  constructor(private readonly pluginId: string) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  get size(): number {
    return this.disposers.length;
  }

  /**
   * 业务 teardown 的数量（不含服务注册自带的清理）。
   *
   * 为什么要分开数：`provide()` 也会注册一个「从容器移除」的清理器，但它不是
   * 业务资源。混在一起会让 `effects=2` 看起来像「有两个清理器」，掩盖了
   * 「这个扩展其实没为定时器/监听器登记 teardown」这类真问题。
   */
  get teardowns(): number {
    return this.teardownCount;
  }

  /**
   * @param kind `teardown` 计入业务清理数；`internal` 是框架自身的簿记（如 provide）
   */
  effect(dispose: () => void | Promise<void>, kind: "teardown" | "internal" = "teardown"): void {
    if (this.disposed) throw new ScopeAlreadyDisposedError(this.pluginId);
    if (kind === "teardown") this.teardownCount++;
    this.disposers.push(dispose);
  }

  /** 幂等：重复调用返回同一个 Promise。 */
  dispose(): Promise<DisposeResult> {
    this.disposing ??= this.runDispose();
    return this.disposing;
  }

  private async runDispose(): Promise<DisposeResult> {
    this.disposed = true;
    const errors: Array<{ index: number; error: unknown }> = [];

    for (let i = this.disposers.length - 1; i >= 0; i--) {
      const disposer = this.disposers[i];
      if (!disposer) continue;
      try {
        await disposer();
      } catch (error) {
        errors.push({ index: i, error });
      }
    }

    this.disposers.length = 0;
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  }
}
