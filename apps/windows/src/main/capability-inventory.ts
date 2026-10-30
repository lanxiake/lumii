/**
 * 能力面清单：把「常驻成本 × 实际用量」摆到一张表上。
 *
 * **口径必须写死在这里**（本仓库既有习惯）：
 * - 工具用量来自 `tool_usage_daily`（近 30 天滚动窗口）；
 * - 技能用量来自 skill-store 索引的 `executionCount`（只有累计值，**没有日维度**）。
 *
 * 两者**不可互相兜底**——技能没有 `usageCount` 就是 0，绝不回退去查同名的工具行。
 * 这正是 `AgentUsageView` 头注释里警告过的 B1 坑：两个数据源的语义不同，混用只会
 * 让「从未使用」这个裁剪信号变成假的。
 *
 * **对账三级口径（2026-10-30 实测，200 项 / 150 工具 / minimal 档）**：
 * | 来源 | 工具合计 | 与日志差 |
 * |---|---|---|
 * | 本页（`charsPerToken` 取全局 `provider.json` 的模型） | 10413 | 12.6% |
 * | `tool_exposure_log.total_tokens`（取会话 `ctx.resolvedModelId`） | 11235 | 5.7% |
 * | 日志 `contextUsage.breakdown.tools + mcp`（取 `sessionLastModelId`） | 11911 | — |
 *
 * 逐工具比值已收敛到 0.875–1.000（只有 10 个取值），剩下的差**不是算术错**，而是
 * 三处各自解析 `charsPerToken`：同一份文本按不同标定比折算，结果系统性偏移。
 * 所以退出标准按住 `tool_exposure_log ↔ 日志` 那一级判（5.7% < 10%），
 * 页面数字受全局模型标定比影响，只作趋势看。
 * 更早还踩过一个 32% 的坑：拿 `toolRegistry` 的**原始**工具定义计价，而 minimal 档
 * 实际发出去的是裁剪版——已在 `handleCapabilityInventory` 里按当前风格裁剪。
 */

import type { PromptStyle, SkillInfo } from '@mtbot/agent-runtime'
import type { ToolUsageByAgent } from './tool-usage-store'
import { estimateFixedTextTokens, estimateToolTokens, type ToolDefinitionLite } from './agent-runtime/context-usage-breakdown'

/** 一行能力：工具或技能。pipeline 等有数据源后再加 kind */
export interface CapabilityRow {
  readonly kind: 'tool' | 'skill'
  readonly id: string
  /** 什么时候该用它：工具取描述首句；技能优先 whenToUse */
  readonly whenToUse: string
  /** 常驻成本：每次请求都要付的 token（工具=完整 schema，技能=索引行） */
  readonly residentTokens: number
  /** 近 30 天用量（技能只有累计值，见文件头） */
  readonly usage30d: number
  /** 最后使用时间戳；技能侧无此数据，恒为 null */
  readonly lastUsed: number | null
}

export interface CapabilityInventoryInput {
  readonly tools: readonly ToolDefinitionLite[]
  readonly skills: readonly SkillInfo[]
  readonly usageByAgent: ToolUsageByAgent
  /** 当前模型的标定字符/token 比；缺省时与 contextUsage 一样退回权重法 */
  readonly charsPerToken?: number
  /** 提示词风格决定技能索引行的渲染形式（terse/minimal 只列名字） */
  readonly promptStyle?: PromptStyle
}

/** 与 skills-section 的 MAX_DESC 保持一致 */
const SKILL_DESC_LIMIT = 120

/** 描述首句：到第一个句末标点为止（含标点），没标点就整段 */
function firstSentence(text: string): string {
  const trimmed = (text || '').trim()
  const m = /^[\s\S]*?[.。!?！？](?=\s|$)/.exec(trimmed)
  return (m ? m[0] : trimmed).trim()
}

/** 技能索引行：与 skills-section 的渲染格式对齐，才能和提示词里的数字同尺 */
function skillIndexText(skill: SkillInfo, style: PromptStyle): string {
  if (style !== 'detailed') return `\`${skill.name}\``
  const raw = (skill.description || '').replace(/\n+/g, ' ').trim()
  const desc = raw.length <= SKILL_DESC_LIMIT ? raw : raw.slice(0, SKILL_DESC_LIMIT - 1) + '…'
  return `- **${skill.name}**: ${desc}`
}

/** 同一工具在多个 Agent 下的用量相加，最后使用取最晚 */
function sumToolUsage(
  usageByAgent: ToolUsageByAgent,
  toolName: string,
): { count: number; lastUsed: number | null } {
  let count = 0
  let lastUsed = 0
  for (const map of Object.values(usageByAgent)) {
    const stat = map[toolName]
    if (!stat) continue
    count += stat.count
    if (stat.lastUsedAt > lastUsed) lastUsed = stat.lastUsedAt
  }
  return { count, lastUsed: lastUsed > 0 ? lastUsed : null }
}

export function buildCapabilityInventory(input: CapabilityInventoryInput): CapabilityRow[] {
  const { charsPerToken, usageByAgent, promptStyle = 'detailed' } = input
  const rows: CapabilityRow[] = []

  for (const tool of input.tools) {
    const usage = sumToolUsage(usageByAgent, tool.name)
    rows.push({
      kind: 'tool',
      id: tool.name,
      whenToUse: firstSentence(tool.description),
      residentTokens: estimateToolTokens(tool, charsPerToken),
      usage30d: usage.count,
      lastUsed: usage.lastUsed,
    })
  }

  for (const skill of input.skills) {
    rows.push({
      kind: 'skill',
      // 技能缺 id 时用 name 兜底，避免页面上出现空 id
      id: (skill.id ?? skill.name).trim(),
      whenToUse: skill.whenToUse?.trim() || firstSentence(skill.description),
      residentTokens: estimateFixedTextTokens(skillIndexText(skill, promptStyle), charsPerToken),
      // 只有累计值；没提供就是 0，**不查工具用量表**（见文件头）
      usage30d: skill.usageCount ?? 0,
      lastUsed: null,
    })
  }

  return rows.sort((a, b) => b.residentTokens - a.residentTokens || a.id.localeCompare(b.id))
}
