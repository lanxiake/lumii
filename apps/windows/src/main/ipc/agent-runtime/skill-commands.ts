/**
 * Skill 命令处理器（skill:*）
 *
 * 技能自进化：确认草稿、拒绝草稿、废弃技能
 */

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'

const log = {
  info: (...args: unknown[]) => console.log('[agent-runtime-ipc/skill]', ...args),
  error: (...args: unknown[]) => console.error('[agent-runtime-ipc/skill]', ...args),
}

export async function handleSkillConfirmDraft(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'skill:confirm_draft' }>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const engine = bridge.getSkillEvolutionEngine()
    if (!engine) throw new Error('SkillEvolutionEngine 未初始化')
    await engine.confirmDraft(command.draft.id, command.draft as import('../../skill-evolution/types').SkillDraft)
    log.info(`[skill:confirm_draft] 草稿已确认: draftId=${command.draft.id}`)
    return { ok: true }
  } catch (err) {
    log.error('[skill:confirm_draft] 失败:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function handleSkillRejectDraft(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'skill:reject_draft' }>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const engine = bridge.getSkillEvolutionEngine()
    if (!engine) throw new Error('SkillEvolutionEngine 未初始化')
    await engine.rejectDraft(command.draftId)
    log.info(`[skill:reject_draft] 草稿已拒绝: draftId=${command.draftId}`)
    return { ok: true }
  } catch (err) {
    log.error('[skill:reject_draft] 失败:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function handleSkillDeprecate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'skill:deprecate' }>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const engine = bridge.getSkillEvolutionEngine()
    if (!engine) throw new Error('SkillEvolutionEngine 未初始化')
    await engine.deprecateSkill(command.skillName)
    log.info(`[skill:deprecate] 技能已废弃: skillName=${command.skillName}`)
    return { ok: true }
  } catch (err) {
    log.error('[skill:deprecate] 失败:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
