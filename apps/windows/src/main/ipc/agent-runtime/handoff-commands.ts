/**
 * 转交确认执行（F2）：handoff:confirm
 *
 * 用户在转交卡片上点击确认后：取出提案 → 新建或复用灵栖开发会话 →
 * 把背景包作为任务消息发出。发送复用 handleUserSend 的完整路径
 * （落库 + 广播 + 开发上下文解析 + ACP 直达 / pi 兜底分流），不重复实现路由。
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { consumeHandoff } from '../../agent-runtime/handoff-store'
import { handleConversationCreate, handleConversationList } from './conversation-commands'
import { handleUserSend } from './user-commands'

const log = {
  info: (...args: unknown[]) => console.log('[AgentRuntime:IPC]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime:IPC]', ...args),
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

const CODE_DEV_AGENT_ID = 'code-dev'

/** 由摘要生成会话标题（单行、截断） */
function titleFromSummary(summary: string): string {
  const one = summary.replace(/\s+/g, ' ').trim()
  if (!one) return '开发任务'
  return one.length > 24 ? `${one.slice(0, 24)}…` : one
}

export async function handleHandoffConfirm(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'handoff:confirm' }>,
): Promise<{ ok: boolean; sessionKey?: string; title?: string; runId?: string; error?: string }> {
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

  // 1. 目标会话：recent=灵栖开发最近的用户会话；否则新开（标题取摘要）
  let targetSk: string | undefined
  let title: string | undefined
  if (handoff.sessionMode === 'recent') {
    try {
      const recent = handleConversationList(bridge)
        .filter(
          (c) =>
            c.agentId === CODE_DEV_AGENT_ID &&
            !c.id.startsWith('evolution:') &&
            !c.id.startsWith('cron:'),
        )
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]
      if (recent) {
        targetSk = recent.sessionKey
        title = recent.title
        log.info(`[handoff:confirm] 复用最近会话 ${targetSk}（${title}）`)
      }
    } catch (err) {
      log.warn(`[handoff:confirm] 查找最近会话失败，回退新开: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  try {
    if (!targetSk) {
      const created = await handleConversationCreate(bridge, {
        type: 'conversation:create',
        title: titleFromSummary(handoff.summary),
        agentId: CODE_DEV_AGENT_ID,
      })
      targetSk = created.sessionKey
      title = titleFromSummary(handoff.summary)
      log.info(`[handoff:confirm] 新建开发会话 ${targetSk}（${title}）`)
    }

    // 2. 复用用户消息路径发起：落库 + 广播 + 开发上下文解析 + ACP/pi 分流
    const { runId } = await handleUserSend(bridge, {
      type: 'user:send',
      sessionKey: targetSk,
      content: handoff.task,
      agentId: CODE_DEV_AGENT_ID,
    })
    log.info(`[handoff:confirm] 已转交 handoffId=${handoff.id} → sessionKey=${targetSk} runId=${runId}`)
    return { ok: true, sessionKey: targetSk, title, runId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`[handoff:confirm] 执行失败 handoffId=${handoff.id}: ${message}`)
    return { ok: false, error: `转交执行失败：${message}` }
  }
}
