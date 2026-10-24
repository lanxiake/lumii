/**
 * 瞬时故障重试。
 *
 * 只对**可能自己恢复**的错误重试（连接抖动、超时、5xx）；参数错误、权限拒绝、
 * 用户取消重试只会让用户多等。分类交给调用方给的 `retryable`，缺省按网络类错误判。
 */

export interface RetryConfig {
  /** 总尝试次数（含首次） */
  readonly maxAttempts: number
  /** 首次退避毫秒 */
  readonly backoffMs: number
  readonly backoffMultiplier: number
  readonly maxBackoffMs: number
  readonly retryable: (err: Error) => boolean
}

const DEFAULT_RETRYABLE = (err: Error): boolean =>
  /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|timeout|502|503|504/i.test(err.message)

/** 可被 signal 打断的等待 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 第 n 次失败后的退避时长（n 从 1 开始） */
export function retryDelay(attempt: number, cfg: Pick<RetryConfig, 'backoffMs' | 'backoffMultiplier' | 'maxBackoffMs'>): number {
  return Math.min(cfg.backoffMs * Math.pow(cfg.backoffMultiplier, attempt - 1), cfg.maxBackoffMs)
}

/**
 * 执行并在可重试错误上退避重试。
 *
 * @param onRetry 每次决定重试时回调（供任务卡显示「第 2/3 次重试」）
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: Partial<RetryConfig> & {
    signal?: AbortSignal
    onRetry?: (attempt: number, delayMs: number, error: Error) => void
  } = {},
): Promise<T> {
  const cfg: RetryConfig = {
    maxAttempts: 3,
    backoffMs: 1000,
    backoffMultiplier: 2,
    maxBackoffMs: 30_000,
    retryable: DEFAULT_RETRYABLE,
    ...options,
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (options.signal?.aborted) throw error
      if (attempt >= cfg.maxAttempts || !cfg.retryable(error)) throw error

      const delayMs = retryDelay(attempt, cfg)
      options.onRetry?.(attempt, delayMs, error)
      await wait(delayMs, options.signal)
    }
  }
}
