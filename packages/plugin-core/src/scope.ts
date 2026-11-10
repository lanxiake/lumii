import { ScopeAlreadyDisposedError } from "./errors.js";

export interface DisposeResult {
  ok: boolean;
  /** 每个失败 disposer 的下标与异常；ok=true 时为 undefined */
  errors?: Array<{ index: number; error: unknown }>;
}

/**
 * effect 的合法形态：
 *
 * - 单个 disposer（现有 31 个插件都这么用）；
 * - **generator 函数** `function* () { yield disposeA; yield disposeB }` —— 调用它产出若干 disposer，
 *   按产出顺序登记（清理时逆序）；
 * - 一个产出 disposer 的同步可迭代对象。
 *
 * 只接受**同步**可迭代对象：异步迭代器在登记时就得分批 yield，
 * 顺序取决于 await 的节奏，清理顺序就不可预测了。需要异步的请返回一个 async function。
 */
export type EffectValue =
  | void
  | (() => void | Promise<void>)
  | (() => Iterable<void | (() => void | Promise<void>)>)
  | Iterable<void | (() => void | Promise<void>)>;

/** 不调用函数就能确知的 generator 判定（调用普通 disposer 会立刻触发清理副作用）。 */
function isGeneratorFunction(fn: (...args: never[]) => unknown): boolean {
  return Object.prototype.toString.call(fn) === "[object GeneratorFunction]";
}

/**
 * 插件作用域：登记所有可逆副作用，卸载时按 LIFO 撤销。
 *
 * 不变量（都有单测覆盖）：
 * 1. 后注册的先清理；
 * 2. 异步 disposer 串行 await —— 并发清理会导致「依赖先于提供者销毁」；
 * 3. 中途失败不中断，继续清理完，最后一次性返回失败清单；
 * 4. 子作用域随父作用域清理，且**先于**父作用域自己后注册的清理器（嵌套按整体入栈）。
 */
export class PluginScope {
  private disposers: Array<() => void | Promise<void>> = [];
  private children: PluginScope[] = [];
  private disposed = false;
  private disposing: Promise<DisposeResult> | null = null;
  private teardownCount = 0;

  constructor(
    private readonly pluginId: string,
    private readonly label?: string,
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  get size(): number {
    return this.disposers.length;
  }

  /** 子作用域的数量（诊断用：一眼看出哪个插件按实体开了一堆作用域）。 */
  get childCount(): number {
    return this.children.length;
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
   * @param dispose 单个 disposer，或一个产出若干 disposer 的可迭代对象
   * @param kind `teardown` 计入业务清理数；`internal` 是框架自身的簿记（如 provide）
   */
  effect(dispose: EffectValue, kind: "teardown" | "internal" = "teardown"): void {
    if (this.disposed) throw new ScopeAlreadyDisposedError(this.pluginId);
    if (kind === "teardown") this.teardownCount++;

    if (typeof dispose === "function") {
      // generator 函数要先调用才能拿到可迭代对象；普通 disposer 直接登记
      if (isGeneratorFunction(dispose as (...args: never[]) => unknown)) {
        const iterable = (dispose as () => Iterable<void | (() => void | Promise<void>)>)();
        for (const item of iterable) {
          if (typeof item === "function") this.disposers.push(item);
        }
        return;
      }
      this.disposers.push(dispose as () => void | Promise<void>);
      return;
    }
    if (dispose && typeof (dispose as Iterable<unknown>)[Symbol.iterator] === "function") {
      for (const item of dispose as Iterable<void | (() => void | Promise<void>)>) {
        if (typeof item === "function") this.disposers.push(item);
      }
    }
  }

  /** 开一个子作用域：它随父作用域销毁，单独 dispose 也行。 */
  fork(): PluginScope {
    if (this.disposed) throw new ScopeAlreadyDisposedError(this.pluginId);
    const child = new PluginScope(this.pluginId, this.label ? `${this.label}/child` : "child");
    this.children.push(child);
    this.disposers.push(async () => {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      await child.dispose();
    });
    return child;
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
    this.children.length = 0;
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  }
}
