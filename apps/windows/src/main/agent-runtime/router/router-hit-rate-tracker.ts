/**
 * Router 命中率追踪器
 *
 * 记录每轮 Router 输出 + 主 LLM 实际选择，便于：
 * - 评估 Router 准确率
 * - 收集 fallback 触发频率
 * - 为 R3（混合 router）演进提供训练数据
 *
 * 详见 .qoder/design/Agent-Skill编排优化/02-技术设计.md §9
 */

import { createLogger } from "../../logger"
import type { RouterResult } from "./types"

const log = createLogger("router-hit-rate")

export interface RouterRecord {
  /** Unix 时间戳（ms） */
  timestamp: number
  /** Agent 实例 ID，用于关联后续 actualChoice 上报 */
  instanceId: string
  /** Router 推断意图 */
  intent: string
  /** Router 置信度 */
  confidence: number
  /** Top 1 Agent ID（如有） */
  topAgentId?: string
  /** 所有 topSkill IDs */
  topSkillIds: readonly string[]
  /** Router 耗时（ms） */
  durationMs: number
  /** 是否走降级 */
  fallback: RouterResult["fallback"]
  /** 是否触发了用户澄清 */
  clarified: boolean
  /** 主 LLM 实际选择的 Agent ID（recordActualChoice 时填） */
  actualAgentId?: string
  /** 主 LLM 实际调用的 Skill IDs（recordActualChoice 时填） */
  actualSkillIds?: readonly string[]
  /** 命中等级：top1 / top3 / miss / unknown */
  hitLevel?: "top1" | "top3" | "miss" | "unknown"
}

/**
 * 内存中保留最近 N 条记录用于即时统计；持久化由调用方决定。
 */
export class RouterHitRateTracker {
  private records: RouterRecord[] = []
  private readonly maxRecords: number

  constructor(opts?: { maxRecords?: number }) {
    this.maxRecords = opts?.maxRecords ?? 200
  }

  /** 在 Router 调用完成后立即记录 */
  record(instanceId: string, result: RouterResult): void {
    const r: RouterRecord = {
      timestamp: Date.now(),
      instanceId,
      intent: result.intent,
      confidence: result.confidence,
      topAgentId: result.topAgents[0]?.id,
      topSkillIds: result.topSkills.map((s) => s.id),
      durationMs: result.durationMs,
      fallback: result.fallback,
      clarified: result.needsClarification,
    }
    this.records.push(r)
    if (this.records.length > this.maxRecords) {
      this.records.shift()
    }
  }

  /** 主 LLM 推理结束后调用，对比 Router 推荐与实际选择 */
  recordActualChoice(
    instanceId: string,
    actualAgentId?: string,
    actualSkillIds?: readonly string[],
  ): void {
    // 找到最近一条该实例的记录
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!
      if (r.instanceId !== instanceId) continue
      if (r.actualAgentId !== undefined || r.actualSkillIds !== undefined) continue // 已填过，跳过

      r.actualAgentId = actualAgentId
      r.actualSkillIds = actualSkillIds
      r.hitLevel = this.calculateHitLevel(r, actualAgentId, actualSkillIds)
      log.info(
        `[recordActualChoice] instance=${instanceId} hitLevel=${r.hitLevel} ` +
          `router_top1=${r.topAgentId ?? "-"} actual=${actualAgentId ?? "-"} skills=[${(actualSkillIds ?? []).join(",")}]`,
      )
      return
    }
  }

  private calculateHitLevel(
    record: RouterRecord,
    actualAgentId?: string,
    actualSkillIds?: readonly string[],
  ): "top1" | "top3" | "miss" | "unknown" {
    if (record.fallback !== "none") return "unknown"
    // 优先看 Agent 命中
    if (actualAgentId && record.topAgentId === actualAgentId) return "top1"
    // 退一步看 Skill 命中
    if (actualSkillIds && actualSkillIds.length > 0) {
      const topSkillSet = new Set(record.topSkillIds)
      const hit = actualSkillIds.some((id) => topSkillSet.has(id))
      if (hit) {
        // top 1?
        if (actualSkillIds[0] === record.topSkillIds[0]) return "top1"
        return "top3"
      }
    }
    // 未命中 Agent 也未命中 Skill
    if (actualAgentId || (actualSkillIds && actualSkillIds.length > 0)) return "miss"
    return "unknown"
  }

  /** 获取最近 N 条记录的统计摘要（用于 admin 仪表盘或 /router-stats 命令） */
  getSummary(): {
    total: number
    fallbackRate: number
    clarifyRate: number
    avgDurationMs: number
    top1Rate: number
    top3Rate: number
    missRate: number
  } {
    if (this.records.length === 0) {
      return { total: 0, fallbackRate: 0, clarifyRate: 0, avgDurationMs: 0, top1Rate: 0, top3Rate: 0, missRate: 0 }
    }
    const total = this.records.length
    const fallback = this.records.filter((r) => r.fallback !== "none").length
    const clarify = this.records.filter((r) => r.clarified).length
    const avgDuration = this.records.reduce((sum, r) => sum + r.durationMs, 0) / total
    const evaluated = this.records.filter((r) => r.hitLevel !== undefined && r.hitLevel !== "unknown")
    const top1 = evaluated.filter((r) => r.hitLevel === "top1").length
    const top3 = evaluated.filter((r) => r.hitLevel === "top1" || r.hitLevel === "top3").length
    const miss = evaluated.filter((r) => r.hitLevel === "miss").length
    return {
      total,
      fallbackRate: fallback / total,
      clarifyRate: clarify / total,
      avgDurationMs: avgDuration,
      top1Rate: evaluated.length > 0 ? top1 / evaluated.length : 0,
      top3Rate: evaluated.length > 0 ? top3 / evaluated.length : 0,
      missRate: evaluated.length > 0 ? miss / evaluated.length : 0,
    }
  }

  /** 清空记录（测试或新会话开始时调用） */
  clear(): void {
    this.records = []
  }

  /** 导出所有记录（用于持久化或离线分析） */
  exportRecords(): readonly RouterRecord[] {
    return [...this.records]
  }
}
