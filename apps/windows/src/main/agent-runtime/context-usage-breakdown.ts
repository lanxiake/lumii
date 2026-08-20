/**
 * 上下文占用分类估算
 *
 * 口径：固定部分（系统提示词各章节 / 工具定义）按**标定的字符-token 比**直接换算，
 * 对话历史 = 提供商回执总量 − 固定部分之和。
 *
 * 为什么不再整体等比缩放：旧实现把各分类的字符级估算之和缩放到 usedTokens
 * （scale = usedTokens / rawTotal）。估算缺口主要出在对话侧（图片、消息 envelope、
 * thinking 块口径差异），对话越长缺口越大、scale 越大，于是连一个字都没变的
 * 系统提示词、工具定义也跟着一起虚涨——正是"各部分随聊天持续增长"的根因。
 *
 * 现在固定部分只依赖自身字符数与标定比，同一实例内保持稳定；所有误差都落在
 * 对话历史这一唯一真正在变化的分类上。
 */

import { estimateTextTokenCount, estimateTokenCount } from '@mtbot/agent-runtime'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type {
  ContextUsageBreakdownEntry,
  ContextUsageCategory,
} from '../../shared/agent-runtime-events'

export {
  applyConversationCompactToUsage,
  patchBreakdownAfterConversationCompact,
} from '../../shared/context-usage-compact'

/** 工具定义的最小形状（名称 + 描述 + 参数 schema，不含 execute） */
export interface ToolDefinitionLite {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export interface BuildContextUsageBreakdownInput {
  readonly systemPrompt: string
  readonly toolDefinitions: readonly ToolDefinitionLite[]
  readonly messages: readonly AgentMessage[]
  /** 权威总量（提供商 inputTokens + 缓存），<=0 时直接用估算值 */
  readonly usedTokens: number
  /**
   * 标定的字符/token 比（由某轮真实回执反推）。缺省时退回 0.3/0.6 字符权重估算，
   * 并沿用旧的等比缩放，保持首轮响应前的行为不变。
   */
  readonly charsPerToken?: number
}

/** 标定比的合理区间：纯 CJK 约 1.6，纯英文约 4，JSON/代码可更高 */
const MIN_CHARS_PER_TOKEN = 0.5
const MAX_CHARS_PER_TOKEN = 20

/** 固定部分至多占用总量的比例，余下留给对话，避免展示出"对话 0 token" */
const MAX_FIXED_RATIO = 0.9

/** 滑动更新权重：保留旧值 80%，吸收新值 20%，抑制单轮抖动 */
const CALIBRATION_SMOOTHING = 0.8

/** `## 章节标题` → 归属分类；未命中的章节算入系统提示词 */
const SECTION_CATEGORY: ReadonlyArray<readonly [RegExp, ContextUsageCategory]> = [
  [/^(Skills|Skill Activation|Your bundled capabilities|自我学习与进化)/i, 'skills'],
  [/^MCP Servers/i, 'mcp'],
  [/^Multi-Agent Collaboration/i, 'subagents'],
  [/^(Memory|About the User|记忆)/i, 'memory'],
]

/** 展示顺序：与卡片行顺序一致 */
const CATEGORY_ORDER: readonly ContextUsageCategory[] = [
  'systemPrompt',
  'tools',
  'skills',
  'mcp',
  'subagents',
  'memory',
  'conversation',
]

/** 固定部分分类（不含对话历史） */
const FIXED_CATEGORIES: readonly ContextUsageCategory[] = CATEGORY_ORDER.filter(
  (c) => c !== 'conversation',
)

function matchSectionCategory(heading: string): ContextUsageCategory {
  for (const [re, category] of SECTION_CATEGORY) {
    if (re.test(heading.trim())) return category
  }
  return 'systemPrompt'
}

/** 工具定义的计费文本：名称 + 描述 + 参数 schema */
function toolText(tool: ToolDefinitionLite): string {
  return `${tool.name}${tool.description}${JSON.stringify(tool.parameters ?? {})}`
}

/**
 * 按 `## ` 章节边界统计系统提示词各分类的字符数，并把工具定义计入
 * tools / mcp（`mcp__` 前缀的工具归 MCP）。
 */
function collectFixedChars(
  systemPrompt: string,
  toolDefinitions: readonly ToolDefinitionLite[],
): Map<ContextUsageCategory, number> {
  const chars = new Map<ContextUsageCategory, number>()
  const add = (category: ContextUsageCategory, n: number): void => {
    chars.set(category, (chars.get(category) ?? 0) + n)
  }

  let current: ContextUsageCategory = 'systemPrompt'
  for (const line of systemPrompt.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) current = matchSectionCategory(heading[1])
    add(current, line.length + 1)
  }

  for (const tool of toolDefinitions) {
    add(tool.name.startsWith('mcp__') ? 'mcp' : 'tools', toolText(tool).length)
  }

  return chars
}

/** 本轮实际发往模型的字符总量（系统提示词 + 工具定义 + 消息序列化） */
export function countPromptChars(input: {
  readonly systemPrompt: string
  readonly toolDefinitions: readonly ToolDefinitionLite[]
  readonly messages: readonly AgentMessage[]
}): number {
  let total = input.systemPrompt.length
  for (const tool of input.toolDefinitions) {
    total += toolText(tool).length
  }
  for (const msg of input.messages) {
    total += JSON.stringify(msg).length
  }
  return total
}

/**
 * 由一轮真实回执反推字符/token 比。
 *
 * @param previous 上一次标定值，用于滑动平滑；首次标定传 undefined
 * @returns 落在合理区间内的新标定值；输入异常时返回 undefined（不污染已有值）
 */
export function calibrateCharsPerToken(
  totalChars: number,
  promptTokens: number,
  previous?: number,
): number | undefined {
  if (!Number.isFinite(totalChars) || !Number.isFinite(promptTokens)) return undefined
  if (totalChars <= 0 || promptTokens <= 0) return undefined

  const observed = totalChars / promptTokens
  if (observed < MIN_CHARS_PER_TOKEN || observed > MAX_CHARS_PER_TOKEN) return undefined

  if (previous == null || !Number.isFinite(previous) || previous <= 0) return observed
  return previous * CALIBRATION_SMOOTHING + observed * (1 - CALIBRATION_SMOOTHING)
}

/** 旧口径：字符权重估算 + 整体等比缩放，仅在缺少标定值时使用 */
function buildLegacyBreakdown(
  input: BuildContextUsageBreakdownInput,
): readonly ContextUsageBreakdownEntry[] {
  const acc = new Map<ContextUsageCategory, number>()
  const add = (category: ContextUsageCategory, n: number): void => {
    acc.set(category, (acc.get(category) ?? 0) + n)
  }

  let current: ContextUsageCategory = 'systemPrompt'
  for (const line of input.systemPrompt.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) current = matchSectionCategory(heading[1])
    add(current, estimateTextTokenCount(line))
  }
  for (const tool of input.toolDefinitions) {
    add(tool.name.startsWith('mcp__') ? 'mcp' : 'tools', estimateTextTokenCount(toolText(tool)))
  }
  for (const msg of input.messages) {
    add('conversation', estimateTokenCount([msg]))
  }

  const rawTotal = [...acc.values()].reduce((sum, n) => sum + n, 0)
  if (rawTotal <= 0) return []
  const scale = input.usedTokens > 0 ? input.usedTokens / rawTotal : 1

  return CATEGORY_ORDER.map((category) => ({
    category,
    tokens: Math.round((acc.get(category) ?? 0) * scale),
  })).filter((entry) => entry.tokens > 0)
}

/**
 * 构造上下文占用分类明细。返回值按 CATEGORY_ORDER 排序并过滤掉零值分类。
 */
export function buildContextUsageBreakdown(
  input: BuildContextUsageBreakdownInput,
): readonly ContextUsageBreakdownEntry[] {
  const { charsPerToken, usedTokens } = input
  const calibrated =
    charsPerToken != null &&
    Number.isFinite(charsPerToken) &&
    charsPerToken >= MIN_CHARS_PER_TOKEN &&
    charsPerToken <= MAX_CHARS_PER_TOKEN
  if (!calibrated || usedTokens <= 0) return buildLegacyBreakdown(input)

  const fixedChars = collectFixedChars(input.systemPrompt, input.toolDefinitions)
  const fixed = new Map<ContextUsageCategory, number>()
  for (const category of FIXED_CATEGORIES) {
    const chars = fixedChars.get(category) ?? 0
    if (chars > 0) fixed.set(category, Math.round(chars / charsPerToken))
  }

  let fixedTotal = [...fixed.values()].reduce((sum, n) => sum + n, 0)

  // 标定偏大或提供商读数偏小时，固定部分可能吃满甚至超过总量。
  // 整体压回 MAX_FIXED_RATIO，保证对话行仍有可见数值。
  const fixedCap = Math.floor(usedTokens * MAX_FIXED_RATIO)
  if (fixedTotal > fixedCap && fixedTotal > 0) {
    const shrink = fixedCap / fixedTotal
    for (const [category, tokens] of fixed) {
      fixed.set(category, Math.round(tokens * shrink))
    }
    fixedTotal = [...fixed.values()].reduce((sum, n) => sum + n, 0)
  }

  const conversation = Math.max(0, usedTokens - fixedTotal)

  return CATEGORY_ORDER.map((category) => ({
    category,
    tokens: category === 'conversation' ? conversation : (fixed.get(category) ?? 0),
  })).filter((entry) => entry.tokens > 0)
}
