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

  constructor(private readonly pluginId: string) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  get size(): number {
    return this.disposers.length;
  }

  effect(dispose: () => void | Promise<void>): void {
    if (this.disposed) throw new ScopeAlreadyDisposedError(this.pluginId);
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
