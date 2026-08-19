/**
 * /stop —— 打断当前正在运行的任务
 *
 * 实际执行在 adapter 的插队路径里（tryHandleOutOfBand）：打断必须绕过消息队列，
 * 否则会排在它要打断的那一轮之后。这里只为 /help 列表与兜底保留一份实现。
 */

import type { CommandContext, CommandHandler } from '../types'

export const stopCommand: CommandHandler = {
  description: '打断当前正在运行的任务',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge, sessionManager } = ctx
    const aborted = bridge.abortSession(session.sessionKey)
    sessionManager?.clearLock(session.sessionKey)
    await adapter.sendTextReply(
      session,
      aborted > 0 ? '⏹ 已打断当前任务，可以直接发新消息。' : '当前没有正在运行的任务。',
    )
  },
}
