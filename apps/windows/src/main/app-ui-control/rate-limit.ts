export interface SlidingWindowRateLimiterOptions {
  limit: number
  windowMs: number
  now?: () => number
}

export interface SlidingWindowRateLimiter {
  /** 尝试占用一次配额；超限返回 false */
  tryConsume: () => boolean
}

/**
 * 创建滑动窗口速率限制器（记录时间戳队列，剔除窗口外样本）。
 * CLI 无 turn 概念，per-turn 配额（bridge-app-ui-tools.ts 的 turnQuotas）不适用，
 * 控制口用这个独立限制 HTTP 请求速率。
 */
export function createSlidingWindowRateLimiter(
  opts: SlidingWindowRateLimiterOptions,
): SlidingWindowRateLimiter {
  const timestamps: number[] = []
  const now = opts.now ?? Date.now
  return {
    tryConsume() {
      const t = now()
      const cutoff = t - opts.windowMs
      while (timestamps.length > 0 && timestamps[0]! <= cutoff) {
        timestamps.shift()
      }
      if (timestamps.length >= opts.limit) return false
      timestamps.push(t)
      return true
    },
  }
}
