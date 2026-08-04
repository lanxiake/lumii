/**
 * 请求-响应关联表（request/response correlation registry）
 *
 * 背景：WebSocket 是一条双向管道，消息乱序流动，不像 HTTP 那样自动一问一答配对。
 * 客户端发请求时给每条请求编唯一 id，把 resolve/reject 回调登记到一张表里；
 * 服务端回复带回同一 id，客户端据此找回回调并兑现。
 *
 * 本模块是**纯逻辑、无副作用**的：只用两端都有的 setTimeout/clearTimeout，
 * 不碰 WebSocket、UI 状态或日志，因此可被 Node（Electron）与浏览器客户端共享。
 */

/** 单条待处理请求的回调与超时句柄 */
export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** setTimeout 句柄；Node 下为 NodeJS.Timeout，浏览器下为 number，故用 ReturnType 跨环境适配 */
  timeout: ReturnType<typeof setTimeout>;
}

export interface RegisterOptions {
  /** 超时毫秒数 */
  timeoutMs: number;
  /** 超时时用于错误信息的方法名（可选，便于定位） */
  method?: string;
  /** 自定义超时错误工厂；不提供则用默认的 `Request timeout: <method>` */
  onTimeoutError?: (id: string, method?: string) => Error;
}

export interface RequestRegistry {
  /** 生成全局唯一请求 id */
  createId: () => string;
  /**
   * 登记一条待处理请求，返回一个在响应到达时兑现的 Promise。
   * 超时未兑现则自动删除登记并 reject。
   */
  register: <T = unknown>(id: string, options: RegisterOptions) => Promise<T>;
  /**
   * 托管一条**外部已构造**的 pending（含自定义副作用的 resolve/reject 与超时句柄）。
   * 用于握手等「兑现时需附带副作用（如改连接状态）」的请求：调用方自己 new Promise、
   * 自己 setTimeout，把打包好的 pending 交给 registry，纳入同一张表由 settle/rejectAll 统一兑现。
   */
  track: (id: string, pending: PendingRequest) => void;
  /**
   * 按 id 兑现一条响应。找不到（迟到/重复响应）则安全忽略，返回 false。
   * ok=true → resolve(payload)；ok=false → reject(error)。
   */
  settle: (id: string, ok: boolean, payloadOrError: unknown) => boolean;
  /** 拒绝并清空所有待处理请求（断连时调用） */
  rejectAll: (error: Error) => void;
  /**
   * 从表中移除一条 pending **但不兑现**（既不 resolve 也不 reject），并清其超时句柄。
   * 用于「即发即忘」类请求超时后仅需丢弃登记、由调用方另行处理（如关闭连接）的场景。
   * 返回是否命中。
   */
  cancel: (id: string) => boolean;
  /** 当前待处理请求数（便于测试/诊断） */
  readonly size: number;
}

/** 默认 id 生成器：计数器 + 时间戳 + 随机串，三重保唯一 */
function defaultCreateId(counterRef: { n: number }): string {
  counterRef.n += 1;
  return `req_${counterRef.n}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createRequestRegistry(
  options: { createId?: () => string } = {},
): RequestRegistry {
  const pending = new Map<string, PendingRequest>();
  const counterRef = { n: 0 };
  const createId = options.createId ?? (() => defaultCreateId(counterRef));

  return {
    createId,

    register<T = unknown>(id: string, opts: RegisterOptions): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          const error = opts.onTimeoutError
            ? opts.onTimeoutError(id, opts.method)
            : new Error(`Request timeout: ${opts.method ?? id}`);
          reject(error);
        }, opts.timeoutMs);

        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeout,
        });
      });
    },

    track(id: string, entry: PendingRequest): void {
      pending.set(id, entry);
    },

    settle(id: string, ok: boolean, payloadOrError: unknown): boolean {
      const entry = pending.get(id);
      if (!entry) {
        return false;
      }
      clearTimeout(entry.timeout);
      pending.delete(id);
      if (ok) {
        entry.resolve(payloadOrError);
      } else {
        const error =
          payloadOrError instanceof Error
            ? payloadOrError
            : new Error(String(payloadOrError ?? "request failed"));
        entry.reject(error);
      }
      return true;
    },

    rejectAll(error: Error): void {
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout);
        entry.reject(error);
      }
      pending.clear();
    },

    cancel(id: string): boolean {
      const entry = pending.get(id);
      if (!entry) {
        return false;
      }
      clearTimeout(entry.timeout);
      pending.delete(id);
      return true;
    },

    get size(): number {
      return pending.size;
    },
  };
}
