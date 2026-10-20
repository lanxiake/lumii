/**
 * 给 Promise 加超时兜底。
 *
 * 超时只 reject 竞速结果，**不取消**原 Promise——调用方负责 destroy 实例等清理。
 * 用在「不 settle 就会永久占着单飞锁」的地方（同步冲突、宠物目标）。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
