/**
 * 技能自进化引擎入口 — SkillEvolutionEngine
 */

import { EventEmitter } from 'node:events'
import type { ConversationMessage, SkillDraft, SkillMeta, LLMCaller, EvolutionEvent } from './types'
import { observe, judgeWithLLM } from './conversation-observer'
import { draftSkill } from './skill-drafter'
import { check } from './skill-quality-gate'
import {
  writeNewSkill,
  readMeta,
  readSkillMd,
  updateMeta,
  deprecateSkill as deprecateSkillFile,
  listSkillNames,
  listCategories,
  savePendingDraft,
  removePendingDraft,
  applyPatch,
} from './skill-writer'
import {
  detectSignal,
  recordFeedback,
  shouldAskFeedback,
  shouldSuggestDeprecation,
} from './feedback-manager'
import { proposeImprovement } from './skill-evolver'
import {
  buildFeedbackRequest,
  buildProblemInquiry,
  buildImprovementProposal,
  buildImprovementConfirmed,
  buildDeprecationSuggestion,
  buildSkillSavePrompt,
  buildSkillCreatedNotice,
  buildSkillRejectedAck,
  buildSkillDeprecatedNotice,
} from './user-dialog'
import { createLogger } from '../logger'

const logger = createLogger('skill-evolution/engine')
const elog = {
  info: (...args: unknown[]) => console.log('[SkillEvolution]', ...args),
  error: (...args: unknown[]) => console.error('[SkillEvolution]', ...args),
}

/** 实例级进化状态机 */
type InstanceEvolutionState =
  | { phase: 'idle'; lastUsedSkill?: string }
  | { phase: 'awaiting_skill_confirm'; draft: SkillDraft; lastUsedSkill?: string }
  | { phase: 'awaiting_feedback'; skillName: string; humanTitle: string; lastUsedSkill?: string }
  | { phase: 'awaiting_problem'; skillName: string; humanTitle: string; lastUsedSkill?: string }
  | { phase: 'awaiting_improvement_confirm'; skillName: string; proposal: import('./skill-evolver').ImprovementProposal; lastUsedSkill?: string }

const DEPRECATE_PATTERNS = [
  /把这个(方法|步骤)删掉/,
  /以后别用(这个|这种)了/,
  /这个方法不对.*别用了/,
  /delete this skill/i,
  /stop using this/i,
]

export class SkillEvolutionEngine extends EventEmitter {
  /** instanceId → 当前进化状态 */
  private readonly instanceStates = new Map<string, InstanceEvolutionState>()

  constructor(private readonly callLLM: LLMCaller) {
    super()
  }

  // ─── 内部工具 ──────────────────────────────────────────────────────────────

  private getState(instanceId: string): InstanceEvolutionState {
    return this.instanceStates.get(instanceId) ?? { phase: 'idle' }
  }

  private setState(instanceId: string, state: InstanceEvolutionState): void {
    this.instanceStates.set(instanceId, state)
  }

  private emitEvent(event: EvolutionEvent): void {
    this.emit(event.type, event)
  }

  /** 从 SKILL.md frontmatter 提取 name 字段 */
  private extractSkillName(skillMd: string): string | null {
    const match = skillMd.match(/name:\s*["']?([^\n"']+)["']?/)
    return match ? match[1].trim() : null
  }

  // ─── Bridge 集成点 1：对话轮次结束后调用 ──────────────────────────────────

  async onTurnComplete(instanceId: string, messages: ConversationMessage[]): Promise<void> {
    try {
      // 如果当前实例已在等待用户确认某个技能，不重复触发
      const currentState = this.getState(instanceId)
      if (currentState.phase !== 'idle') return

      elog.info(`[onTurnComplete] 开始分析: instanceId=${instanceId}, 消息数=${messages.length}`)
      const existingNames = await listSkillNames()

      // 阶段1：规则预筛（毫秒级，快速排除明显不值得提取的对话）
      const preFilter = observe(messages, existingNames)
      elog.info(`[onTurnComplete] 规则预筛: worthExtracting=${preFilter.worthExtracting}`)
      if (!preFilter.worthExtracting) return

      // 阶段2：LLM 深度判断（只在预筛通过后调用，避免每轮消耗 token）
      elog.info(`[onTurnComplete] 调用 LLM 判断是否值得提取技能`)
      const judgment = await judgeWithLLM(messages, existingNames, this.callLLM, instanceId)
      elog.info(`[onTurnComplete] LLM 判断: shouldExtract=${judgment.shouldExtract}, reason=${judgment.reason}`)
      if (!judgment.shouldExtract) return

      // 阶段3：生成草稿
      elog.info(`[onTurnComplete] 开始生成技能草稿`)
      const existingCategories = await listCategories()
      const draft = await draftSkill(messages, existingNames, (p) => this.callLLM(p, instanceId), existingCategories)
      const { pass, score } = check(draft.skillMd)
      elog.info(`[onTurnComplete] 质量检查: pass=${pass}, score=${score}, draftId=${draft.id}`)
      if (!pass) return

      await savePendingDraft(draft)

      // 进入等待用户确认状态，通过对话询问用户
      this.setState(instanceId, {
        phase: 'awaiting_skill_confirm',
        draft,
        lastUsedSkill: currentState.lastUsedSkill,
      })

      const { title, scenario, steps } = draft.humanSummary
      this.emit('inject_message', {
        instanceId,
        text: buildSkillSavePrompt(title, scenario, steps),
      })
      elog.info(`[onTurnComplete] 已通过对话询问用户是否保存技能: draftId=${draft.id}`)
    } catch (err) {
      elog.error(`[onTurnComplete] 处理失败: ${(err as Error).message}`, err)
    }
  }

  // ─── Bridge 集成点 2：用户消息到达时调用 ──────────────────────────────────

  /** 返回 true 表示已拦截，不应继续走正常对话流程 */
  async onUserMessage(instanceId: string, message: string): Promise<boolean> {
    const state = this.getState(instanceId)
    logger.debug(`[onUserMessage] instanceId=${instanceId}, phase=${state.phase}, message="${message.slice(0, 50)}"`)

    // 新阶段：等待用户确认是否保存技能草稿
    if (state.phase === 'awaiting_skill_confirm') {
      const signal = detectSignal(message)
      const lowerMsg = message.trim().toLowerCase()
      const isConfirm = signal === 'positive'
        || /^(好的?|保存|是的?|要|确认|ok|yes|save)$/i.test(lowerMsg)
        || lowerMsg.includes('保存') || lowerMsg.includes('好的') || lowerMsg.includes('要的')
      const isReject = signal === 'negative'
        || /^(不用|不要|算了|跳过|no|skip|取消)$/i.test(lowerMsg)
        || lowerMsg.includes('不用') || lowerMsg.includes('不要') || lowerMsg.includes('算了')

      if (isConfirm) {
        try {
          await this.confirmDraft(state.draft.id, state.draft)
          const skillName = this.extractSkillName(state.draft.skillMd) ?? state.draft.humanSummary.title
          this.setState(instanceId, { phase: 'idle', lastUsedSkill: state.lastUsedSkill })
          this.emit('inject_message', {
            instanceId,
            text: buildSkillCreatedNotice(state.draft.humanSummary.title, state.draft.category),
          })
          logger.info(`[onUserMessage] 用户确认保存技能: skillName=${skillName}`)
        } catch (err) {
          logger.error(`[onUserMessage] 保存技能失败: ${(err as Error).message}`)
          this.setState(instanceId, { phase: 'idle', lastUsedSkill: state.lastUsedSkill })
        }
        return true
      }

      if (isReject) {
        await this.rejectDraft(state.draft.id)
        this.setState(instanceId, { phase: 'idle', lastUsedSkill: state.lastUsedSkill })
        this.emit('inject_message', { instanceId, text: buildSkillRejectedAck() })
        logger.info(`[onUserMessage] 用户拒绝保存技能: draftId=${state.draft.id}`)
        return true
      }

      // 用户回复了其他内容，不拦截，让对话正常继续（但保留等待状态）
      return false
    }

    if (state.phase === 'awaiting_feedback') {
      const signal = detectSignal(message)
      logger.info(`[onUserMessage] 反馈信号检测: signal=${signal ?? 'null'}, skillName=${state.skillName}`)
      if (signal === 'positive') {
        await recordFeedback(state.skillName, 'positive')
        this.setState(instanceId, { phase: 'idle' })
        return true
      } else if (signal === 'negative' || signal === 'partial') {
        await recordFeedback(state.skillName, signal)
        this.setState(instanceId, {
          phase: 'awaiting_problem',
          skillName: state.skillName,
          humanTitle: state.humanTitle,
        })
        this.emit('inject_message', { instanceId, text: buildProblemInquiry() })
        return true
      }
      this.setState(instanceId, { phase: 'idle' })
      return false
    }

    if (state.phase === 'awaiting_problem') {
      logger.info(`[onUserMessage] 用户描述问题，开始生成改进方案: skillName=${state.skillName}`)
      try {
        const currentMd = await readSkillMd(state.skillName)
        if (!currentMd) {
          this.setState(instanceId, { phase: 'idle' })
          return false
        }
        const proposal = await proposeImprovement(currentMd, message, (p) => this.callLLM(p, instanceId))
        logger.info(`[onUserMessage] 改进方案已生成: skillName=${state.skillName}`)
        this.setState(instanceId, {
          phase: 'awaiting_improvement_confirm',
          skillName: state.skillName,
          proposal,
        })
        this.emitEvent({
          type: 'improvement_ready',
          skillName: state.skillName,
          naturalLanguageDiff: proposal.naturalLanguageDiff,
        })
        this.emit('inject_message', {
          instanceId,
          text: buildImprovementProposal(proposal.naturalLanguageDiff),
        })
      } catch (err) {
        logger.error(`[onUserMessage] 生成改进方案失败: ${(err as Error).message}`)
        this.setState(instanceId, { phase: 'idle' })
      }
      return true
    }

    if (state.phase === 'awaiting_improvement_confirm') {
      const signal = detectSignal(message)
      if (signal === 'positive') {
        await this.confirmImprovement(instanceId, state.skillName, state.proposal)
        return true
      } else if (signal === 'negative' || signal === 'partial') {
        // 再次追问
        this.setState(instanceId, {
          phase: 'awaiting_problem',
          skillName: state.skillName,
          humanTitle: state.skillName,
        })
        this.emit('inject_message', { instanceId, text: buildProblemInquiry() })
        return true
      }
      this.setState(instanceId, { phase: 'idle' })
      return false
    }

    // 检查自然语言废弃指令
    if (DEPRECATE_PATTERNS.some(p => p.test(message))) {
      // 优先废弃最近使用的技能，其次取第一个 active 技能
      const currentState = this.getState(instanceId)
      const lastUsed = currentState.lastUsedSkill
      let targetName: string | undefined

      if (lastUsed) {
        const meta = await readMeta(lastUsed)
        if (meta?.state === 'active') targetName = lastUsed
      }

      if (!targetName) {
        const names = await listSkillNames()
        for (const name of names) {
          const meta = await readMeta(name)
          if (meta?.state === 'active') {
            targetName = name
            break
          }
        }
      }

      if (targetName) {
        await this.deprecateSkill(targetName, instanceId)
        return true
      }
    }

    return false
  }

  // ─── 用户 UI 操作 ──────────────────────────────────────────────────────────

  async confirmDraft(draftId: string, draft: SkillDraft): Promise<void> {
    const skillName = this.extractSkillName(draft.skillMd)
    if (!skillName) throw new Error('无法从草稿中提取技能名称')

    const meta: SkillMeta = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      sourceType: 'auto_extracted',
      state: 'active',
      trustScore: 0.5,
      useCount: 0,
      feedbackStats: { positive: 0, partial: 0, negative: 0 },
      consecutiveNegative: 0,
      evolutionHistory: [],
    }

    await writeNewSkill(skillName, draft.skillMd, meta, draft.category)
    await removePendingDraft(draftId)
    logger.info(`[confirmDraft] 技能已写入: skillName=${skillName}, category=${draft.category ?? '根目录'}, draftId=${draftId}`)
  }

  async rejectDraft(draftId: string): Promise<void> {
    await removePendingDraft(draftId)
  }

  private async confirmImprovement(
    instanceId: string,
    skillName: string,
    proposal: import('./skill-evolver').ImprovementProposal,
  ): Promise<void> {
    await applyPatch(skillName, proposal.patchOldString, proposal.patchNewString, {
      at: new Date().toISOString(),
      reason: 'user_feedback',
    })
    // 用户确认改进 = 正向反馈
    await recordFeedback(skillName, 'positive')
    this.setState(instanceId, { phase: 'idle' })
    this.emit('inject_message', { instanceId, text: buildImprovementConfirmed() })

    // 检查熔断（recordFeedback 已更新 meta，重新读取）
    const meta = await readMeta(skillName)
    if (meta && shouldSuggestDeprecation(meta)) {
      const humanTitle = draft_humanTitle(meta, skillName)
      // 通过对话告知用户建议废弃，而不是弹窗
      this.emit('inject_message', {
        instanceId,
        text: buildDeprecationSuggestion(humanTitle),
      })
      this.emitEvent({ type: 'deprecation_suggested', skillName, humanTitle })
    }
  }

  async rejectImprovement(instanceId: string): Promise<void> {
    const state = this.getState(instanceId)
    if (state.phase === 'awaiting_improvement_confirm') {
      await recordFeedback(state.skillName, 'negative')
      const meta = await readMeta(state.skillName)
      if (meta && shouldSuggestDeprecation(meta)) {
        this.emitEvent({
          type: 'deprecation_suggested',
          skillName: state.skillName,
          humanTitle: state.skillName,
        })
      }
    }
    this.setState(instanceId, { phase: 'idle' })
  }

  async deprecateSkill(skillName: string, instanceId?: string): Promise<void> {
    await deprecateSkillFile(skillName)
    if (instanceId) {
      this.emit('inject_message', {
        instanceId,
        text: buildSkillDeprecatedNotice(skillName),
      })
    }
  }

  /** 技能被使用后调用（更新 useCount，决定是否询问反馈） */
  async onSkillUsed(instanceId: string, skillName: string, humanTitle: string): Promise<void> {
    const meta = await readMeta(skillName)
    if (!meta || meta.state !== 'active') return

    await updateMeta(skillName, { useCount: meta.useCount + 1 })

    // 记录最近使用的技能，供废弃指令精准定位
    const currentState = this.getState(instanceId)
    this.setState(instanceId, { ...currentState, lastUsedSkill: skillName })

    const ask = await shouldAskFeedback(skillName)
    if (ask) {
      this.setState(instanceId, { phase: 'awaiting_feedback', skillName, humanTitle, lastUsedSkill: skillName })
      this.emitEvent({ type: 'feedback_requested', skillName, humanTitle })
      this.emit('inject_message', { instanceId, text: buildFeedbackRequest(humanTitle) })
    }
  }
}

/** 从 meta 中提取人类可读标题（fallback 到 skillName） */
function draft_humanTitle(_meta: SkillMeta, fallback: string): string {
  return fallback
}
