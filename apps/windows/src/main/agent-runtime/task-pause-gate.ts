/**
 * 后台任务的暂停闸门。
 *
 * 暂停不打断已提交的远端作业（ComfyUI 排队/渲染本来就在服务端跑），
 * 只是让**跟进的轮询**停在原地：不刷日志、不占 IPC。恢复后接着轮询同一个 prompt_id，
 * 不重新提交 —— 这正是暂停最有价值的场景：不浪费 GPU 时间。
 */

export class PauseGate {
  private paused = false
  private waiters: Array<() => void> = []

  pause(): void {
    this.paused = true
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** 暂停中则挂起，恢复或中断时返回 */
  wait(signal: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve()
    if (signal.aborted) return Promise.reject(new Error('aborted'))

    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort)
        const index = this.waiters.indexOf(onResume)
        if (index >= 0) this.waiters.splice(index, 1)
      }
      const onResume = (): void => {
        cleanup()
        resolve()
      }
      const onAbort = (): void => {
        cleanup()
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(onResume)
    })
  }
}
