/**
 * ToolEvolutionEngine — bash 命令工具进化引擎（宿主装配）
 *
 * 管道（设计见 docs/plans/2026-09-08-bash-命令工具进化-design.md）：
 *
 *   runMiningCycle()：bash_command_log → 规则粗聚类 → LLM 精归一化 → LLM 草拟
 *   → 质量门 → 入待审批队列 → 对话内提问
 *
 *   handleUserMessage()：用户回复「启用/不用」→ 注册工具 + 实例失效 / 丢弃草稿
 *
 * 所有 LLM 失败 / 质量门不通过都静默丢弃候选，不影响 Agent 主链路。
 * 每天最多产出 maxCandidatesPerRun 个候选；队列积压超过 maxPendingQueue 时暂停草拟。
 */

import { EventEmitter } from 'node:events'
import {
  BashCommandRepo,
  checkToolDraft,
  draftToolFromPattern,
  mineCommandPatterns,
  normalizeCommand,
  refinePatternWithLLM,
  type CommandSample,
  type TemplateToolDefinition,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from '../bridge-utils'
import {
  loadPendingDrafts,
  savePendingDrafts,
  saveApprovedTool,
  loadApprovedTools,
  newDraftId,
  type PendingToolDraft,
} from './tool-writer'

export interface ToolEvolutionEngineDeps {
  bashCommandRepo: BashCommandRepo
  /** LLM 调用（宿主导入会话模型，三级降级由宿主负责） */
  callLLM: (prompt: string) => Promise<string>
  /** 注册生效动作：registry.register + 使现有实例失效（bridge 注入） */
  registerEvolvedTool: (def: TemplateToolDefinition) => void
  /** 已注册工具名（重名检查） */
  getRegisteredToolNames: () => string[]
  /** 发出对话内审批提问（宿主注入 inject_message wiring） */
  emitApprovalPrompt: (text: string) => void
  /** 每次挖掘最多草拟的候选数（默认 2） */
  maxCandidatesPerRun?: number
  /** 待审批队列积压上限，超过则暂停草拟（默认 5） */
  maxPendingQueue?: number
}

export interface MiningSummary {
  samplesScanned: number
  patternsFound: number
  drafted: number
  gatedOut: number
  skippedReason: string | null
}

interface ToolEvolutionEngineEvents {
  'approval_asked': { text: string; toolName: string }
  'tool_activated': { toolName: string }
  'draft_rejected': { toolName: string }
}

/** 确认/拒绝关键词（先测拒绝再测确认，避免「不用」被「用」误判） */
const REJECT_RE = /(不用|不要|不需要|拒绝|取消|忽略|跳过|no|reject|skip)/i
const CONFIRM_RE = /(启用|好的|保存|同意|可以|确认|好|yes|enable|ok)/i

export function buildApprovalPrompt(draft: PendingToolDraft): string {
  return (
    `检测到命令模式 \`${draft.pattern}\` 最近被高频使用（样本 ${draft.samples.length} 条），` +
    `已草拟参数化工具「${draft.name}」。\n` +
    `回复「启用」将其注册为系统工具（之后 Agent 直接调用，不再重写命令）；回复「不用」丢弃。`
  )
}

export class ToolEvolutionEngine extends EventEmitter {
  private readonly pending: PendingToolDraft[] = []

  constructor(private readonly deps: ToolEvolutionEngineDeps) {
    super()
    // 启动时恢复待审批队列
    this.pending.push(...loadPendingDrafts())
    log.info(`[ToolEvolution] 恢复待审批候选 ${this.pending.length} 条`)
  }

  /** 待审批候选数 */
  get pendingCount(): number {
    return this.pending.length
  }

  /** 启动时注册所有已批准工具。返回注册数量。 */
  loadApprovedTools(): number {
    const approved = loadApprovedTools()
    let registered = 0
    for (const def of approved) {
      try {
        this.deps.registerEvolvedTool(def)
        registered++
      } catch (err) {
        log.warn(`[ToolEvolution] 启动注册工具失败 name=${def.name}:`, err)
      }
    }
    if (registered > 0) {
      log.info(`[ToolEvolution] 启动注册已批准工具 ${registered} 个`)
    }
    return registered
  }

  /**
   * 一次挖掘周期：采集 → 粗聚类 → 精归一化 → 草拟 → 质量门 → 入队提问。
   * 由 cron 每日调度（M3 接线）；数据不足时静默跳过。
   */
  async runMiningCycle(): Promise<MiningSummary> {
    const summary: MiningSummary = {
      samplesScanned: 0,
      patternsFound: 0,
      drafted: 0,
      gatedOut: 0,
      skippedReason: null,
    }

    const maxPending = this.deps.maxPendingQueue ?? 5
    if (this.pending.length >= maxPending) {
      summary.skippedReason = `待审批队列已满（${this.pending.length}）`
      return summary
    }

    let rows
    try {
      rows = this.deps.bashCommandRepo.listRecent(2000)
    } catch (err) {
      summary.skippedReason = `读取命令日志失败: ${err instanceof Error ? err.message : String(err)}`
      return summary
    }
    if (rows.length < 5) {
      summary.skippedReason = `命令日志不足（${rows.length} 条）`
      return summary
    }

    const samples: CommandSample[] = rows.map((r) => ({
      command: r.command,
      isError: r.is_error === 1,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }))
    summary.samplesScanned = samples.length

    const patterns = mineCommandPatterns(samples)
    summary.patternsFound = patterns.length
    if (patterns.length === 0) return summary

    const maxCandidates = this.deps.maxCandidatesPerRun ?? 2
    const existingNames = this.deps.getRegisteredToolNames()

    for (const pattern of patterns) {
      if (summary.drafted >= maxCandidates) break
      if (this.pending.length >= maxPending) break

      // 已在待审批队列的模式去重（已注册工具的样本不落库，无法按模式比对，
      // 重名检查由质量门兜底）
      if (this.pending.some((d) => d.pattern === pattern.pattern)) {
        continue
      }

      // 二级精归一化（LLM，失败回退规则模式，草拟 prompt 会自动降级）
      const refined = await refinePatternWithLLM(pattern, { callLLM: this.deps.callLLM })

      // LLM 草拟
      const draft = await draftToolFromPattern(pattern, refined, {
        callLLM: this.deps.callLLM,
        existingToolNames: [...existingNames, ...this.pending.map((d) => d.name)],
      })
      if (!draft) {
        summary.gatedOut++
        continue
      }

      // 质量门
      const gate = checkToolDraft(
        { ...draft, needsPermission: true },
        pattern,
        { normalize: normalizeCommand, registeredNames: existingNames },
      )
      if (!gate.passed) {
        summary.gatedOut++
        log.info(`[ToolEvolution] 质量门拒绝 name=${draft.name} errors=${gate.errors.join('; ')}`)
        continue
      }

      // 入队 + 落盘 + 提问
      const pending: PendingToolDraft = {
        ...draft,
        pattern: pattern.pattern,
        samples: pattern.samples,
        createdAt: new Date().toISOString(),
        draftId: newDraftId(),
      }
      this.pending.push(pending)
      summary.drafted++
      const text = buildApprovalPrompt(pending)
      try {
        await savePendingDrafts(this.pending)
      } catch (err) {
        log.warn('[ToolEvolution] 待审批队列落盘失败:', err)
      }
      this.deps.emitApprovalPrompt(text)
      this.emit('approval_asked', { text, toolName: pending.name })
    }

    log.info(
      `[ToolEvolution] 挖掘周期完成: scanned=${summary.samplesScanned} patterns=${summary.patternsFound} ` +
        `drafted=${summary.drafted} gatedOut=${summary.gatedOut}`,
    )
    return summary
  }

  /**
   * 用户消息处理：消费确认/拒绝。返回是否命中审批信号。
   * 挂在 prompt-dispatcher 的用户消息集成点（不拦截正常对话）。
   */
  async handleUserMessage(text: string): Promise<boolean> {
    const head = this.pending[0]
    if (!head) return false

    const isReject = REJECT_RE.test(text)
    const isConfirm = !isReject && CONFIRM_RE.test(text)
    if (!isReject && !isConfirm) return false

    if (isConfirm) {
      // 确认：落盘 + 注册 + 实例失效
      try {
        const def: TemplateToolDefinition = { ...head, needsPermission: true }
        await saveApprovedTool(def, head.samples)
        this.deps.registerEvolvedTool(def)
        this.emit('tool_activated', { toolName: head.name })
        log.info(`[ToolEvolution] 工具已批准并注册: ${head.name}`)
      } catch (err) {
        log.error(`[ToolEvolution] 工具注册失败 name=${head.name}:`, err)
      }
      this.deps.emitApprovalPrompt(`已注册系统工具「${head.name}」，后续可直接调用。`)
    } else {
      this.emit('draft_rejected', { toolName: head.name })
      this.deps.emitApprovalPrompt(`已丢弃候选工具「${head.name}」。`)
    }

    this.pending.shift()
    try {
      await savePendingDrafts(this.pending)
    } catch {
      // 落盘失败不影响状态机内存态
    }
    return true
  }
}
