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
  openTemplateRejectionReason,
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
  loadStoredTools,
  updateToolStatus,
  removeApprovedTool,
  newDraftId,
  type PendingToolDraft,
} from './tool-writer'

export interface ToolEvolutionEngineDeps {
  bashCommandRepo: BashCommandRepo
  /** LLM 调用（宿主导入会话模型，三级降级由宿主负责） */
  callLLM: (prompt: string) => Promise<string>
  /** 注册生效动作：registry.register + 使现有实例失效（bridge 注入） */
  registerEvolvedTool: (def: TemplateToolDefinition) => void
  /** 注销动作：registry.unregister + 使现有实例失效（bridge 注入） */
  unregisterTool: (name: string) => void
  /** 已注册工具名（重名检查） */
  getRegisteredToolNames: () => string[]
  /** 发出对话内审批提问（宿主注入 inject_message wiring） */
  emitApprovalPrompt: (text: string) => void
  /** 每次挖掘最多草拟的候选数（默认 2） */
  maxCandidatesPerRun?: number
  /** 待审批队列积压上限，超过则暂停草拟（默认 5） */
  maxPendingQueue?: number
  /** 过去 24h 累计调用触发挖掘的阈值（默认 50，范围 10–500） */
  triggerThreshold?: number
}

/** 默认：过去 24h 累计 50 次 bash 调用触发一次分析 */
export const DEFAULT_TRIGGER_THRESHOLD = 50
export const MIN_TRIGGER_THRESHOLD = 10
export const MAX_TRIGGER_THRESHOLD = 500
/** runtime_state 键：过去 24h 调用次数触发阈值 */
export const TRIGGER_THRESHOLD_KEY = 'tool-evolution.trigger-threshold'

/** 将用户输入的触发阈值钳制到合法范围 */
export function clampTriggerThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRIGGER_THRESHOLD
  return Math.min(MAX_TRIGGER_THRESHOLD, Math.max(MIN_TRIGGER_THRESHOLD, Math.round(value)))
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

/**
 * 模板参数位归一：{{workspacePackagePath}} → {{p}}。
 * 用于等价模式比较——同一命令模式经 LLM 草拟会得到不同参数名
 * （如 {{pkg}} / {{appPath}}），不做归一无法识别为重复。
 */
export function canonicalizeParamSlots(template: string): string {
  return template.replace(/\{\{[^}]+\}\}/g, '{{p}}')
}

/**
 * 组装对话内 / 通知用的审批文案：用途、AI 建议、模板与样本。
 */
export function buildApprovalPrompt(draft: PendingToolDraft): string {
  const samples = draft.samples.slice(0, 3).map((s) => `  - ${s}`).join('\n')
  const whenToUse = draft.whenToUse?.trim()
  const whenNotToUse = draft.whenNotToUse?.trim()
  const lines = [
    `检测到命令模式最近被高频使用（样本 ${draft.samples.length} 条），已草拟参数化工具「${draft.name}」。`,
    ``,
    `用途：${draft.description}`,
  ]
  if (whenToUse) lines.push(`建议使用：${whenToUse}`)
  if (whenNotToUse) lines.push(`不建议：${whenNotToUse}`)
  lines.push(`命令模板：\`${draft.commandTemplate}\``)
  if (samples) {
    lines.push(`真实样本：`)
    lines.push(samples)
  }
  lines.push(``)
  lines.push(
    `回复「启用」将其注册为系统工具（之后 Agent 直接调用，不再重写命令）；回复「不用」丢弃。`,
  )
  return lines.join('\n')
}

/**
 * 找出与候选模板等价（参数位归一后相同）的已批准工具名。
 */
export function findSimilarApprovedTools(
  commandTemplate: string,
  approved: Array<{ name: string; commandTemplate: string }>,
): string[] {
  const canonical = canonicalizeParamSlots(commandTemplate)
  return approved
    .filter((t) => canonicalizeParamSlots(t.commandTemplate) === canonical)
    .map((t) => t.name)
}

export class ToolEvolutionEngine extends EventEmitter {
  private readonly pending: PendingToolDraft[] = []
  private featureEnabled: boolean = true
  private triggerThreshold: number

  constructor(private readonly deps: ToolEvolutionEngineDeps) {
    super()
    this.triggerThreshold = clampTriggerThreshold(
      deps.triggerThreshold ?? DEFAULT_TRIGGER_THRESHOLD,
    )
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

    // 已批准工具的等价模式（参数位归一后比较）：同模式不再重复草拟，
    // 也让低频模式有机会轮上 maxCandidatesPerRun 的名额
    const approvedCanonical = new Set(
      loadStoredTools().map(({ def }) => canonicalizeParamSlots(def.commandTemplate)),
    )

    for (const pattern of patterns) {
      if (summary.drafted >= maxCandidates) break
      if (this.pending.length >= maxPending) break

      const canonical = canonicalizeParamSlots(pattern.pattern)
      // 已在待审批队列的等价模式去重（同模式不同 LLM 命名也识别）
      if (this.pending.some((d) => canonicalizeParamSlots(d.pattern) === canonical)) {
        continue
      }
      // 已批准工具的等价模式跳过
      if (approvedCanonical.has(canonical)) {
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

      // 草拟后的 commandTemplate 再与已批准 / 待审队列去重（pattern 预检可能漏掉参数位差异）
      const draftCanonical = canonicalizeParamSlots(draft.commandTemplate)
      if (
        approvedCanonical.has(draftCanonical) ||
        this.pending.some((d) => canonicalizeParamSlots(d.commandTemplate) === draftCanonical)
      ) {
        log.info(`[ToolEvolution] 草稿模板与已有工具等价，跳过 name=${draft.name}`)
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

    await this.consumePending(head.name, isConfirm)
    return true
  }

  /**
   * 消费指定名称的候选（设置页 UI / 对话内审批共用）。
   * 确认 → 落盘 + 注册 + 实例失效；拒绝 → 丢弃。
   */
  async consumePending(toolName: string, confirm: boolean): Promise<boolean> {
    const index = this.pending.findIndex((d) => d.name === toolName)
    if (index < 0) return false
    const [draft] = this.pending.splice(index, 1)

    if (confirm) {
      try {
        const def: TemplateToolDefinition = { ...draft, needsPermission: true }
        await saveApprovedTool(def, draft.samples)
        this.deps.registerEvolvedTool(def)
        this.emit('tool_activated', { toolName: draft.name })
        log.info(`[ToolEvolution] 工具已批准并注册: ${draft.name}`)
      } catch (err) {
        log.error(`[ToolEvolution] 工具注册失败 name=${draft.name}:`, err)
      }
      this.deps.emitApprovalPrompt(`已注册系统工具「${draft.name}」，后续可直接调用。`)
    } else {
      this.emit('draft_rejected', { toolName: draft.name })
      this.deps.emitApprovalPrompt(`已丢弃候选工具「${draft.name}」。`)
    }

    try {
      await savePendingDrafts(this.pending)
    } catch {
      // 落盘失败不影响状态机内存态
    }
    return true
  }

  /** 进化工具列表 + 待审批候选（设置页管理 UI 数据源） */
  listEvolvedTools(): {
    tools: Array<{
      name: string
      description: string
      commandTemplate: string
      isReadOnly: boolean
      enabled: boolean
      sampleCount: number
      approvedAt: string
    }>
    pending: Array<{
      name: string
      description: string
      pattern: string
      commandTemplate: string
      createdAt: string
      whenToUse?: string
      whenNotToUse?: string
      samples: string[]
      similarApproved: string[]
      /** 开放式低价值模板原因（已入队历史候选也可能命中） */
      lowValueReason: string | null
    }>
  } {
    const stored = loadStoredTools()
    const approvedForSimilarity = stored.map(({ def }) => ({
      name: def.name,
      commandTemplate: def.commandTemplate,
    }))

    return {
      tools: stored.map(({ def, status }) => ({
        name: def.name,
        description: def.description,
        commandTemplate: def.commandTemplate,
        isReadOnly: def.isReadOnly,
        enabled: status === 'approved',
        sampleCount: def.samples?.length ?? 0,
        approvedAt: def.approvedAt,
      })),
      pending: this.pending.map((d) => ({
        name: d.name,
        description: d.description,
        pattern: d.pattern,
        commandTemplate: d.commandTemplate,
        createdAt: d.createdAt,
        whenToUse: d.whenToUse,
        whenNotToUse: d.whenNotToUse,
        samples: d.samples.slice(0, 5),
        similarApproved: findSimilarApprovedTools(d.commandTemplate, approvedForSimilarity),
        lowValueReason: openTemplateRejectionReason(d.commandTemplate),
      })),
    }
  }

  /**
   * 启用/禁用已批准工具（设置页开关，状态持久化到 tool.json）。
   * 禁用：注销 + 实例失效；启用：重新注册。
   */
  setToolEnabled(toolName: string, enabled: boolean): boolean {
    const stored = loadStoredTools().find((e) => e.def.name === toolName)
    if (!stored) return false

    if (enabled) {
      if (!updateToolStatus(toolName, 'approved')) return false
      this.deps.registerEvolvedTool(stored.def)
      log.info(`[ToolEvolution] 工具已启用: ${toolName}`)
    } else {
      if (!updateToolStatus(toolName, 'disabled')) return false
      this.deps.unregisterTool(toolName)
      log.info(`[ToolEvolution] 工具已禁用: ${toolName}`)
    }
    return true
  }

  /** 删除已批准工具（移除文件 + 注销，不可恢复） */
  removeTool(toolName: string): boolean {
    const exists = loadStoredTools().some((e) => e.def.name === toolName)
    if (!exists) return false
    try {
      removeApprovedTool(toolName)
    } catch (err) {
      log.warn(`[ToolEvolution] 删除工具文件失败 name=${toolName}:`, err)
    }
    this.deps.unregisterTool(toolName)
    log.info(`[ToolEvolution] 工具已删除: ${toolName}`)
    return true
  }

  /** 获取功能开关状态 */
  isFeatureEnabled(): boolean {
    return this.featureEnabled
  }

  /** 设置功能开关（启用/禁用整个工具进化功能） */
  setFeatureEnabled(enabled: boolean): void {
    this.featureEnabled = enabled
    log.info(`[ToolEvolution] 功能已${enabled ? '启用' : '禁用'}`)
  }

  /** 获取过去 24h 调用次数触发阈值 */
  getTriggerThreshold(): number {
    return this.triggerThreshold
  }

  /**
   * 设置过去 24h 调用次数触发阈值（钳制到 10–500）。
   * 返回实际生效值。
   */
  setTriggerThreshold(value: number): number {
    this.triggerThreshold = clampTriggerThreshold(value)
    log.info(`[ToolEvolution] 触发阈值已更新为 ${this.triggerThreshold}`)
    return this.triggerThreshold
  }

  /** 获取统计数据（用于设置页展示） */
  getStats(repo: BashCommandRepo): {
    trackedPatterns: number
    recentCalls: number
    highFrequencyCommands: Array<{ command: string; count: number }>
    lastAnalysisTime: string | null
    nextScheduledTime: string | null
    totalGenerated: number
    approved: number
    rejected: number
    pending: number
  } {
    // 获取最近 24 小时的命令
    const rows = repo.listRecent(2000)
    const now = Date.now()
    const oneDayAgo = now - 24 * 60 * 60 * 1000

    const recentRows = rows.filter(r => new Date(r.created_at).getTime() > oneDayAgo)

    // 统计高频命令（简化版，基于归一化后的模式）
    const commandCounts = new Map<string, number>()
    for (const row of recentRows) {
      const normalized = normalizeCommand(row.command)
      commandCounts.set(normalized, (commandCounts.get(normalized) || 0) + 1)
    }

    const highFrequencyCommands = Array.from(commandCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([command, count]) => ({ command, count }))

    // 统计已批准和已拒绝的工具数（从磁盘读取）
    const stored = loadStoredTools()
    const approved = stored.filter(t => t.status === 'approved').length
    const disabled = stored.filter(t => t.status === 'disabled').length

    return {
      trackedPatterns: commandCounts.size,
      recentCalls: recentRows.length,
      highFrequencyCommands,
      lastAnalysisTime: null, // TODO: 从持久化状态读取
      nextScheduledTime: null, // TODO: 从 cron 任务读取
      totalGenerated: stored.length + this.pending.length,
      approved: approved + disabled,
      rejected: 0, // TODO: 记录拒绝历史
      pending: this.pending.length,
    }
  }

  /**
   * 实时触发检查：在记录新命令后调用，检查是否应该触发挖掘。
   * 阈值策略：过去 24 小时内累计达到 triggerThreshold 次时触发一次分析。
   * 为避免频繁触发，使用简单的冷却机制：触发后 1 小时内不再检查。
   */
  private lastTriggerCheckTime = 0
  private readonly triggerCooldownMs = 60 * 60 * 1000 // 1 小时冷却

  async checkAndTriggerIfNeeded(repo: BashCommandRepo): Promise<boolean> {
    // 功能未启用时跳过
    if (!this.featureEnabled) return false

    // 冷却期内跳过
    const now = Date.now()
    if (now - this.lastTriggerCheckTime < this.triggerCooldownMs) {
      return false
    }

    // 检查最近 24 小时的调用次数
    const rows = repo.listRecent(2000)
    const oneDayAgo = now - 24 * 60 * 60 * 1000
    const recentCount = rows.filter(r => new Date(r.created_at).getTime() > oneDayAgo).length

    // 未达到阈值
    if (recentCount < this.triggerThreshold) {
      return false
    }

    // 达到阈值，触发挖掘
    log.info(`[ToolEvolution] 调用次数达到阈值（${recentCount}/${this.triggerThreshold}），触发实时挖掘`)
    this.lastTriggerCheckTime = now

    try {
      await this.runMiningCycle()
      return true
    } catch (err) {
      log.error('[ToolEvolution] 实时触发挖掘失败:', err)
      return false
    }
  }
}
