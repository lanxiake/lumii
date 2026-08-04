/**
 * 技能命中率监控 Hook
 *
 * 监控 skill_invoke / skill_search 工具调用，统计每次对话中的技能使用情况。
 * 每轮结束后自动将统计数据写回 skill-store，由系统自动调整 autoActivationScope，
 * 用户无需任何手动配置。
 */

import type { ToolHook } from '@mtbot/agent-runtime'
import { createLogger } from '../../logger'

const log = createLogger('skill-hit-rate')

/** 每轮结束后批量更新技能统计的回调 */
export type UpdateScopeBatchFn = (deltas: Map<string, { invokeSuccess?: number; searchCount?: number }>) => Promise<void>

export interface SkillHitRateTracker {
  hook: ToolHook
  /** prompt 结束后调用：输出统计日志并自动更新 scope */
  flush(instanceId: string): void
}

interface SkillCallRecord {
  toolName: string
  /**
   * skill_invoke: 技能名
   * skill_search: 搜索到的技能名列表（从结果解析，修复 #2：避免用 query 字符串作 key）
   */
  targets: string[]
  success: boolean
}

/**
 * 从 skill_search 工具结果文本中解析返回的技能名称列表。
 * 结果格式：{ "skills": [{"name": "xxx", "description": "..."}, ...], "total": N }
 */
function parseSkillSearchTargets(resultText: string): string[] {
  try {
    const obj = JSON.parse(resultText) as { skills?: Array<{ name?: unknown }> }
    if (!Array.isArray(obj?.skills)) return []
    return obj.skills
      .map((s) => (typeof s.name === 'string' ? s.name.trim() : ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 创建技能命中率监控 hook
 *
 * @param updateScopeBatch 每轮结束后批量更新技能统计的回调（来自 LocalSkillStore.updateAutoScopeBatch）
 *                         传 undefined 时只记日志不持久化（测试用）
 */
export function createSkillHitRateHook(updateScopeBatch?: UpdateScopeBatchFn): SkillHitRateTracker {
  const records: SkillCallRecord[] = []

  const hook: ToolHook = {
    name: 'skill-hit-rate',
    filter: {
      toolNames: ['skill_invoke', 'skill_search'],
    },
    afterExecute(ctx) {
      if (ctx.toolName === 'skill_invoke') {
        const target = String(
          (ctx.params as { skillName?: unknown }).skillName ??
          (ctx.params as { name?: unknown }).name ??
          (ctx.params as { id?: unknown }).id ??
          '',
        ).trim()
        if (target) {
          records.push({ toolName: ctx.toolName, targets: [target], success: !ctx.isError })
        }
      } else {
        // skill_search：从结果中解析实际返回的技能名称（修复 #2）
        const resultText =
          typeof ctx.result === 'string'
            ? ctx.result
            : Array.isArray((ctx.result as { content?: unknown[] })?.content)
              ? String(
                  ((ctx.result as { content: Array<{ text?: unknown }> }).content[0])?.text ?? '',
                )
              : ''
        const targets = parseSkillSearchTargets(resultText)
        if (targets.length > 0) {
          records.push({ toolName: ctx.toolName, targets, success: !ctx.isError })
        }
      }
    },
  }

  function flush(instanceId: string): void {
    if (records.length === 0) return

    const invokeRecords = records.filter((r) => r.toolName === 'skill_invoke')
    const searchRecords = records.filter((r) => r.toolName === 'skill_search')
    const invokeSuccess = invokeRecords.filter((r) => r.success)

    // 日志输出
    if (invokeRecords.length > 0) {
      const hitRate = Math.round((invokeSuccess.length / invokeRecords.length) * 100)
      log.info(
        `[flush] ${instanceId} skill_invoke: 调用=${invokeRecords.length} 成功=${invokeSuccess.length} 命中率=${hitRate}% 技能=[${invokeRecords.flatMap((r) => r.targets).join(', ')}]`,
      )
    }
    if (searchRecords.length > 0) {
      log.info(
        `[flush] ${instanceId} skill_search: 调用=${searchRecords.length} 搜索命中技能=[${searchRecords.flatMap((r) => r.targets).join(' | ')}]`,
      )
    }

    // 自动更新激活范围（修复 #4：批量一次写入，而非逐个调用）
    if (updateScopeBatch) {
      const skillDeltas = new Map<string, { invokeSuccess: number; searchCount: number }>()

      for (const r of invokeRecords) {
        for (const target of r.targets) {
          if (!target) continue
          const s = skillDeltas.get(target) ?? { invokeSuccess: 0, searchCount: 0 }
          if (r.success) s.invokeSuccess++
          skillDeltas.set(target, s)
        }
      }
      for (const r of searchRecords) {
        for (const target of r.targets) {
          if (!target) continue
          const s = skillDeltas.get(target) ?? { invokeSuccess: 0, searchCount: 0 }
          s.searchCount++
          skillDeltas.set(target, s)
        }
      }

      if (skillDeltas.size > 0) {
        updateScopeBatch(skillDeltas).catch((err) =>
          log.warn(`[flush] 批量更新技能激活范围失败: ${String(err)}`),
        )
      }
    }

    records.length = 0
  }

  return { hook, flush }
}
