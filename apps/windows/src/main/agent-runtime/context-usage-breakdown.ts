/**
 * 上下文占用分类估算
 *
 * 口径：固定部分（系统提示词各章节 / 工具定义）按**标定的字符-token 比**直接换算，
 * 对话历史按消息内容独立估算（`estimateTokenCount`，与文本本身的字符类型加权，
 * 不依赖 charsPerToken）。
 *
 * 为什么不再整体等比缩放：旧实现把各分类的字符级估算之和缩放到 usedTokens
 * （scale = usedTokens / rawTotal）。估算缺口主要出在对话侧（图片、消息 envelope、
 * thinking 块口径差异），对话越长缺口越大、scale 越大，于是连一个字都没变的
 * 系统提示词、工具定义也跟着一起虚涨——正是"各部分随聊天持续增长"的根因。
 *
 * 为什么对话历史不能是"usedTokens − 固定部分之和"的残差：固定部分体量通常远超
 * 单轮对话（如 13K vs 100 token），charsPerToken 只是全局单一比值，对固定部分
 * 哪怕有 10-20% 的估算偏差，换算成绝对 token 数也会数千起跳——这个偏差如果全部
 * 甩给残差公式，会让一句"你是谁"的对话历史显示成 2K+，构成本模块修复的下一个bug。
 * 因此对话历史必须独立估算，固定部分之和只用于校验"总量是否超标"，不用于反推对话量。
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

/** 无标定值时的粗略字符→token 权重（中英文混排的折中值） */
const LEGACY_TOKENS_PER_CHAR = 0.45

/** 标签名 → 展示分类 */
const TAG_CATEGORY: Readonly<Record<string, ContextUsageCategory>> = {
  tooling: 'tools',
  skills: 'skills',
  mcp_servers: 'mcp',
  subagents: 'subagents',
  memory: 'memory',
}

const CACHE_BOUNDARY_MARKER = '<!-- CACHE_BOUNDARY -->'

/**
 * 按 `<tag>…</tag>` 精确切分系统提示词，返回各分类的字符数。
 *
 * 标签外的内容一律归 systemPrompt。相比早前用 `## 标题` 正则匹配，这里是确定性
 * 切分：标题文案怎么改都不影响归类，不会出现某分类静默归零。
 */
function splitTaggedChars(prompt: string): Map<ContextUsageCategory, number> {
  const chars = new Map<ContextUsageCategory, number>()
  const add = (category: ContextUsageCategory, n: number): void => {
    if (n > 0) chars.set(category, (chars.get(category) ?? 0) + n)
  }

  const boundary = prompt.indexOf(CACHE_BOUNDARY_MARKER)
  const staticPrompt = boundary >= 0 ? prompt.slice(0, boundary) : prompt
  if (boundary >= 0) {
    add('dynamicContext', prompt.length - boundary - CACHE_BOUNDARY_MARKER.length)
  }

  const tagNames = Object.keys(TAG_CATEGORY).join('|')
  const re = new RegExp(`<(${tagNames})>([\\s\\S]*?)</\\1>`, 'g')

  let cursor = 0
  for (let m = re.exec(staticPrompt); m !== null; m = re.exec(staticPrompt)) {
    add('systemPrompt', m.index - cursor)
    add(TAG_CATEGORY[m[1]], m[2].length)
    cursor = m.index + m[0].length
  }
  add('systemPrompt', staticPrompt.length - cursor)

  return chars
}

/** 展示顺序：与卡片行顺序一致 */
const CATEGORY_ORDER: readonly ContextUsageCategory[] = [
  'systemPrompt',
  'tools',
  'skills',
  'mcp',
  'subagents',
  'memory',
  'dynamicContext',
  'conversation',
]

/** 固定部分分类（不含对话历史） */
const FIXED_CATEGORIES: readonly ContextUsageCategory[] = CATEGORY_ORDER.filter(
  (c) => c !== 'conversation',
)

/** 工具定义的计费文本：名称 + 描述 + 参数 schema */
function toolText(tool: ToolDefinitionLite): string {
  return `${tool.name}${tool.description}${JSON.stringify(tool.parameters ?? {})}`
}

/**
 * 统计固定部分各分类的字符数：系统提示词按标签切分，工具定义计入
 * tools / mcp（`mcp__` 前缀的工具归 MCP）。
 */
function collectFixedChars(
  systemPrompt: string,
  toolDefinitions: readonly ToolDefinitionLite[],
): Map<ContextUsageCategory, number> {
  const chars = splitTaggedChars(systemPrompt)
  for (const tool of toolDefinitions) {
    const category: ContextUsageCategory = tool.name.startsWith('mcp__') ? 'mcp' : 'tools'
    chars.set(category, (chars.get(category) ?? 0) + toolText(tool).length)
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

  // 同样按标签切分，但用 0.3/0.6 字符权重换算（无标定值时的近似口径）
  for (const [category, chars] of splitTaggedChars(input.systemPrompt)) {
    add(category, chars * LEGACY_TOKENS_PER_CHAR)
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
  // 固定部分包括静态提示词章节、工具定义；动态上下文单独统计，不归对话历史。
  // 直接按标定比换算，不做整体缩放——缩放会让一个字没变的固定部分随对话变长而虚涨。
  const fixed = new Map<ContextUsageCategory, number>()
  for (const category of FIXED_CATEGORIES) {
    const chars = fixedChars.get(category) ?? 0
    if (chars > 0) fixed.set(category, Math.round(chars / charsPerToken))
  }
  let fixedTotal = [...fixed.values()].reduce((sum, n) => sum + n, 0)

  // 对话历史独立估算（同 estimateTokenCount 的文本口径），不做 usedTokens 反推残差——
  // 固定部分的标定偏差量级远超单轮对话真实 token 数，残差公式会把这偏差全部错记成对话历史。
  let conversation = estimateTokenCount([...input.messages])

  // 标定偏大或提供商读数偏小时，固定部分 + 对话历史可能吃满甚至超过总量。
  // 整体压回 MAX_FIXED_RATIO 的等比缩放，两侧一起收缩，不让某一侧独自承担误差。
  const total = fixedTotal + conversation
  const cap = Math.floor(usedTokens * MAX_FIXED_RATIO)
  if (total > cap && total > 0) {
    const shrink = cap / total
    for (const [category, tokens] of fixed) {
      fixed.set(category, Math.round(tokens * shrink))
    }
    fixedTotal = [...fixed.values()].reduce((sum, n) => sum + n, 0)
    conversation = Math.round(conversation * shrink)
  }

  return CATEGORY_ORDER.map((category) => ({
    category,
    tokens: category === 'conversation' ? conversation : (fixed.get(category) ?? 0),
  })).filter((entry) => entry.tokens > 0)
}
