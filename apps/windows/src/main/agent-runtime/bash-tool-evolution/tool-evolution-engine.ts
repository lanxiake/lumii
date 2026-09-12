/**
 * ToolEvolutionEngine — bash 命令工具进化引擎（宿主装配）
 *
 * 管道：
 *
 *   runMiningCycle()：近 7 天 bash_command_log → 规则粗聚类
 *   → count>100 且次数 Top5 → 单次 LLM 草拟 → 质量门 → 待审批
 *
 *   runConditionalCheck()：定时条件检查（默认每 6h）；有候选且不在冷却期才挖掘。
 *   无实时触发；成功进 LLM 后 7 天冷却，避免周内反复消耗。
 *
 * 所有 LLM 失败 / 质量门不通过都静默丢弃候选，不影响 Agent 主链路。
 */

import { EventEmitter } from 'node:events'
import {
  BashCommandRepo,
  checkToolDraft,
  draftToolFromPattern,
  mineCommandPatterns,
  normalizeCommand,
  openTemplateRejectionReason,
  selectHighValuePatterns,
  DEFAULT_MIN_COUNT_EXCLUSIVE,
  DEFAULT_TOP_N_FOR_LLM,
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

/** 统计与冷却窗口：7 天 */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** 定时条件检查间隔：6 小时 */
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 近一周日志拉取上限 */
const WEEKLY_LOG_LIMIT = 50000

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
  /** 每次挖掘最多草拟的候选数（默认 Top 5） */
  maxCandidatesPerRun?: number
  /** 待审批队列积压上限，超过则暂停草拟（默认 5） */
  maxPendingQueue?: number
  /**
   * 进 LLM 的次数门槛：count 必须严格大于该值（默认 100）。
   * 单测可下调以加快造数。
   */
  minCountExclusive?: number
  /** 统计窗口毫秒（默认 7 天） */
  statsWindowMs?: number
  /** 成功进 LLM 后的冷却毫秒（默认 7 天） */
  miningCooldownMs?: number
  /** 读取上次成功挖掘时间（ISO）；宿主可持久化到 runtime_state */
  getLastMiningAt?: () => string | null
  /** 写入上次成功挖掘时间（ISO） */
  setLastMiningAt?: (iso: string) => void
  /** 可注入时钟（单测用） */
  now?: () => number
}

/** @deprecated 实时触发已移除；保留常量以免旧 IPC/UI 引用崩掉 */
export const DEFAULT_TRIGGER_THRESHOLD = 50
export const MIN_TRIGGER_THRESHOLD = 10
export const MAX_TRIGGER_THRESHOLD = 500
/** runtime_state 键：历史触发阈值（已弃用，仅兼容） */
export const TRIGGER_THRESHOLD_KEY = 'tool-evolution.trigger-threshold'
/** runtime_state 键：上次成功挖掘时间 */
export const LAST_MINING_AT_KEY = 'tool-evolution.last-mining-at'

/** 将用户输入的触发阈值钳制到合法范围（兼容旧设置页） */
export function clampTriggerThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRIGGER_THRESHOLD
  return Math.min(MAX_TRIGGER_THRESHOLD, Math.max(MIN_TRIGGER_THRESHOLD, Math.round(value)))
}

export interface MiningSummary {
  samplesScanned: number
  patternsFound: number
  highValuePatterns: number
  drafted: number
  gatedOut: number
  llmCalls: number
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
    `检测到命令模式近一周高频使用（样本 ${draft.samples.length} 条），已草拟参数化工具「${draft.name}」。`,
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
  /** @deprecated 仅兼容旧 IPC */
  private triggerThreshold: number = DEFAULT_TRIGGER_THRESHOLD

  constructor(private readonly deps: ToolEvolutionEngineDeps) {
    super()
    // 启动时恢复待审批队列
    this.pending.push(...loadPendingDrafts())
    log.info(`[ToolEvolution] 恢复待审批候选 ${this.pending.length} 条`)
  }

  /** 当前时间（可注入） */
  private nowMs(): number {
    return this.deps.now?.() ?? Date.now()
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

  /** 是否仍在挖掘冷却期内 */
  isInMiningCooldown(): boolean {
    const cooldownMs = this.deps.miningCooldownMs ?? WEEK_MS
    if (cooldownMs <= 0) return false
    const last = this.deps.getLastMiningAt?.() ?? null
    if (!last) return false
    const lastMs = Date.parse(last)
    if (!Number.isFinite(lastMs)) return false
    return this.nowMs() - lastMs < cooldownMs
  }

  /** 标记一次成功进入 LLM 的挖掘周期（进入冷却） */
  private markMiningDone(): void {
    const iso = new Date(this.nowMs()).toISOString()
    try {
      this.deps.setLastMiningAt?.(iso)
    } catch (err) {
      log.warn('[ToolEvolution] 写入 lastMiningAt 失败:', err)
    }
  }

  /**
   * 定时条件检查：冷却中或功能关闭则跳过；否则跑一次挖掘周期。
   * 由宿主按固定间隔调用（默认 6h），不是定点 cron。
   */
  async runConditionalCheck(): Promise<MiningSummary | null> {
    if (!this.featureEnabled) {
      log.info('[ToolEvolution] 条件检查跳过：功能已关闭')
      return null
    }
    if (this.isInMiningCooldown()) {
      log.info('[ToolEvolution] 条件检查跳过：仍在 7 天冷却期内')
      return null
    }
    return this.runMiningCycle()
  }

  /**
   * 一次挖掘周期：近 7 天采集 → 粗聚类 → 高频 Top5 → 单次 LLM 草拟 → 质量门 → 入队。
   * 无高价值候选时静默跳过且不进入冷却。
   */
  async runMiningCycle(): Promise<MiningSummary> {
    const summary: MiningSummary = {
      samplesScanned: 0,
      patternsFound: 0,
      highValuePatterns: 0,
      drafted: 0,
      gatedOut: 0,
      llmCalls: 0,
      skippedReason: null,
    }

    const maxPending = this.deps.maxPendingQueue ?? 5
    if (this.pending.length >= maxPending) {
      summary.skippedReason = `待审批队列已满（${this.pending.length}）`
      return summary
    }

    const windowMs = this.deps.statsWindowMs ?? WEEK_MS
    const cutoffIso = new Date(this.nowMs() - windowMs).toISOString()

    let rows
    try {
      rows = this.deps.bashCommandRepo.listSince(cutoffIso, WEEKLY_LOG_LIMIT)
    } catch (err) {
      summary.skippedReason = `读取命令日志失败: ${err instanceof Error ? err.message : String(err)}`
      return summary
    }
    if (rows.length < 5) {
      summary.skippedReason = `近一周命令日志不足（${rows.length} 条）`
      return summary
    }

    const samples: CommandSample[] = rows.map((r) => ({
      command: r.command,
      isError: r.is_error === 1,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }))
    summary.samplesScanned = samples.length

    // 粗挖掘用较低门槛聚合；真正进 LLM 再由 selectHighValuePatterns 卡 >100
    const patterns = mineCommandPatterns(samples, { minSamples: 5 })
    summary.patternsFound = patterns.length
    if (patterns.length === 0) {
      summary.skippedReason = '无可用命令模式'
      return summary
    }

    const minCountExclusive = this.deps.minCountExclusive ?? DEFAULT_MIN_COUNT_EXCLUSIVE
    const maxCandidates = this.deps.maxCandidatesPerRun ?? DEFAULT_TOP_N_FOR_LLM
    const highValue = selectHighValuePatterns(patterns, {
      minCountExclusive,
      topN: maxCandidates,
    })
    summary.highValuePatterns = highValue.length
    if (highValue.length === 0) {
      summary.skippedReason = `近一周无 count>${minCountExclusive} 的高频模式`
      return summary
    }

    const existingNames = this.deps.getRegisteredToolNames()
    const approvedCanonical = new Set(
      loadStoredTools().map(({ def }) => canonicalizeParamSlots(def.commandTemplate)),
    )

    let attemptedLlm = false

    for (const pattern of highValue) {
      if (summary.drafted >= maxCandidates) break
      if (this.pending.length >= maxPending) break

      const canonical = canonicalizeParamSlots(pattern.pattern)
      if (this.pending.some((d) => canonicalizeParamSlots(d.pattern) === canonical)) {
        continue
      }
      if (approvedCanonical.has(canonical)) {
        continue
      }

      // 单次 LLM：语义化模板 + 工具定义合并草拟
      attemptedLlm = true
      summary.llmCalls++
      const draft = await draftToolFromPattern(pattern, null, {
        callLLM: this.deps.callLLM,
        existingToolNames: [...existingNames, ...this.pending.map((d) => d.name)],
      })
      if (!draft) {
        summary.gatedOut++
        continue
      }

      const draftCanonical = canonicalizeParamSlots(draft.commandTemplate)
      if (
        approvedCanonical.has(draftCanonical) ||
        this.pending.some((d) => canonicalizeParamSlots(d.commandTemplate) === draftCanonical)
      ) {
        log.info(`[ToolEvolution] 草稿模板与已有工具等价，跳过 name=${draft.name}`)
        continue
      }

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

      const pending: PendingToolDraft = {
        ...draft,
        pattern: pattern.pattern,
        samples: pattern.samples,
        createdAt: new Date(this.nowMs()).toISOString(),
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

    if (attemptedLlm) {
      this.markMiningDone()
    }

    log.info(
      `[ToolEvolution] 挖掘周期完成: scanned=${summary.samplesScanned} patterns=${summary.patternsFound} ` +
        `highValue=${summary.highValuePatterns} drafted=${summary.drafted} gatedOut=${summary.gatedOut} ` +
        `llmCalls=${summary.llmCalls}`,
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

  /** @deprecated 实时触发已移除 */
  getTriggerThreshold(): number {
    return this.triggerThreshold
  }

  /** @deprecated 实时触发已移除，仅兼容旧 IPC */
  setTriggerThreshold(value: number): number {
    this.triggerThreshold = clampTriggerThreshold(value)
    log.info(`[ToolEvolution] 触发阈值已更新为 ${this.triggerThreshold}（已弃用，不影响调度）`)
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
    const windowMs = this.deps.statsWindowMs ?? WEEK_MS
    const cutoffIso = new Date(this.nowMs() - windowMs).toISOString()
    const recentRows = repo.listSince(cutoffIso, WEEKLY_LOG_LIMIT)

    const commandCounts = new Map<string, number>()
    for (const row of recentRows) {
      const normalized = normalizeCommand(row.command)
      commandCounts.set(normalized, (commandCounts.get(normalized) || 0) + 1)
    }

    const highFrequencyCommands = Array.from(commandCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([command, count]) => ({ command, count }))

    const stored = loadStoredTools()
    const approved = stored.filter((t) => t.status === 'approved').length
    const disabled = stored.filter((t) => t.status === 'disabled').length

    return {
      trackedPatterns: commandCounts.size,
      recentCalls: recentRows.length,
      highFrequencyCommands,
      lastAnalysisTime: this.deps.getLastMiningAt?.() ?? null,
      nextScheduledTime: null,
      totalGenerated: stored.length + this.pending.length,
      approved: approved + disabled,
      rejected: 0,
      pending: this.pending.length,
    }
  }
}
