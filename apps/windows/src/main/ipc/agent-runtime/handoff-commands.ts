/**
 * 转交确认执行（F2）：handoff:confirm
 *
 * 用户在转交卡片上点确认后：取出提案 → runDevHandoff 把任务发到「灵栖开发」的开发会话
 * （新建/复用最近），完成后异步把结果汇报回本（主助手）会话——保证原会话知道任务结果。
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { consumeHandoff } from '../../agent-runtime/handoff-store'
import { reportToOriginSession, runDevHandoff } from './dev-handoff-executor'

const log = {
  info: (...args: unknown[]) => console.log('[AgentRuntime:IPC]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime:IPC]', ...args),
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

// reportToOriginSession 已移入 dev-handoff-executor（执行链的收尾动作，自动转交也要用）。
// 这里 re-export，保持既有 import 点（测试与调用方）不变。
export { reportToOriginSession }

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
      // 项目名进开发会话的 dev-context → resolveDevContext 命中 → cwd 落在项目目录
      ...(handoff.projectName ? { projectName: handoff.projectName } : {}),
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
