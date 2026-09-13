/**
 * 转交确认执行（F2）：handoff:confirm
 *
 * 用户在转交卡片上点确认后：取出提案 → runDevHandoff 把任务发到「灵栖开发」的开发会话
 * （新建/复用最近），完成后异步把结果汇报回本（主助手）会话——保证原会话知道任务结果。
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { consumeHandoff } from '../../agent-runtime/handoff-store'
import { formatHandoffReport, runDevHandoff, type DevHandoffReport } from './dev-handoff-executor'

const log = {
  info: (...args: unknown[]) => console.log('[AgentRuntime:IPC]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime:IPC]', ...args),
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

/** 完成后把结果写回原会话（主助手会话），保证「原会话知道任务结果」 */
function reportToOriginSession(
  bridge: AgentRuntimeBridge,
  originSessionKey: string,
  summary: string,
  payload: DevHandoffReport,
): void {
  if (!originSessionKey) return
  const text = formatHandoffReport(summary, payload)
  try {
    const id = bridge.conversationRepo.saveMessage({
      conversationId: originSessionKey,
      role: 'assistant',
      contentJson: { type: 'text', text },
    })
    bridge.forwardIpcEvent({
      type: 'conversation:message:new',
      sessionKey: originSessionKey,
      message: {
        id: String(id),
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      },
    })
    log.info(`[handoff:confirm] 已向原会话汇报结果 sessionKey=${originSessionKey}`)
  } catch (err) {
    log.error(`[handoff:confirm] 原会话汇报失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function handleHandoffConfirm(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'handoff:confirm' }>,
): Promise<{ ok: boolean; sessionKey?: string; title?: string; error?: string }> {
  const handoff = consumeHandoff(command.handoffId)
  if (!handoff) {
    return {
      ok: false,
      error: '转交提案不存在或已被使用（应用重启会使提案失效），请让主助手重新发起。',
    }
  }
  log.info(
    `[handoff:confirm] 确认转交 handoffId=${handoff.id} mode=${handoff.sessionMode} summary="${handoff.summary}"`,
  )

  try {
    const { devSessionKey, title } = await runDevHandoff({
      bridge,
      task: handoff.task,
      sessionMode: handoff.sessionMode,
      title: handoff.summary,
      report: (payload) =>
        reportToOriginSession(bridge, handoff.originSessionKey, handoff.summary, payload),
    })
    log.info(
      `[handoff:confirm] 已转交 handoffId=${handoff.id} → 开发会话 ${devSessionKey}（完成后汇报回原会话）`,
    )
    return { ok: true, sessionKey: devSessionKey, title }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`[handoff:confirm] 执行失败 handoffId=${handoff.id}: ${message}`)
    return { ok: false, error: `转交执行失败：${message}` }
  }
}
