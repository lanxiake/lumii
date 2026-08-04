/**
 * AskUserQuestionController — Agent 向用户结构化提问的请求/响应管理
 *
 * 职责：维护 pending 的 ask_user_question 请求 Map，提供 wait/resolve 机制。
 * 与 PermissionController 设计一致（单次请求 × requestId 关联），
 * 对齐 claude-code-rev/src/tools/AskUserQuestionTool 的 userEnv.submitAnswer 语义。
 *
 * 超时行为：超时后返回 `{ cancelled: true }`，让工具结果文本保持"用户未应答"。
 */

import type { AskUserQuestionContextResult } from '@mtbot/agent-runtime'

const log = {
  info: (...args: unknown[]) => console.log('[AskUserQuestionController]', ...args),
}

interface PendingAskResolver {
  resolve: (result: AskUserQuestionContextResult) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

export class AskUserQuestionController {
  private readonly pending = new Map<string, PendingAskResolver>()

  /**
   * 等待用户对指定 requestId 的回答
   *
   * @param requestId - 请求 ID（推荐使用 toolCallId 保持一一对应）
   * @param timeoutMs - 超时毫秒数，超时返回 `{ cancelled: true }`；传 0 表示永不超时
   */
  waitForAnswer(requestId: string, timeoutMs: number): Promise<AskUserQuestionContextResult> {
    return new Promise((resolve) => {
      const timeoutHandle =
        timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.has(requestId)) {
                log.info(`[waitForAnswer] requestId=${requestId} timed out → cancelled`)
                this.pending.delete(requestId)
                resolve({ answers: {}, cancelled: true })
              }
            }, timeoutMs)
          : setTimeout(() => {}, 0) // 占位

      this.pending.set(requestId, { resolve, timeoutHandle })
    })
  }

  /**
   * 处理来自渲染进程的用户回答
   */
  resolveAnswer(requestId: string, result: AskUserQuestionContextResult): void {
    const entry = this.pending.get(requestId)
    if (!entry) {
      log.info(`[resolveAnswer] requestId=${requestId} not found (already resolved or timed out)`)
      return
    }
    clearTimeout(entry.timeoutHandle)
    this.pending.delete(requestId)
    log.info(
      `[resolveAnswer] requestId=${requestId} → declined=${Boolean(result.declined)} cancelled=${Boolean(
        result.cancelled,
      )}`,
    )
    entry.resolve(result)
  }

  /**
   * 以 cancelled=true 拒绝所有挂起请求（destroyAll 或重启时调用）
   */
  clearAll(): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timeoutHandle)
      entry.resolve({ answers: {}, cancelled: true })
      log.info(`[clearAll] cancelled pending ask: ${requestId}`)
    }
    this.pending.clear()
  }

  /** 暴露给外部诊断的当前挂起请求数 */
  get pendingCount(): number {
    return this.pending.size
  }
}
