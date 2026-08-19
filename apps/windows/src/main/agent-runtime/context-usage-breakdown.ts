/**
 * 上下文占用分类估算
 *
 * 把系统提示词按 `## ` 章节归类（技能 / MCP / 子 Agent / 记忆 / 其余算系统提示词），
 * 加上工具定义与对话历史，再按提供商回执的真实 usedTokens 等比缩放，
 * 使明细之和与顶部总量一致，供 UI 展示占比。
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
  /** 权威总量（提供商 inputTokens + 缓存），用于等比缩放；<=0 时直接用估算值 */
  readonly usedTokens: number
}

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

function matchSectionCategory(heading: string): ContextUsageCategory {
  for (const [re, category] of SECTION_CATEGORY) {
    if (re.test(heading.trim())) return category
  }
  return 'systemPrompt'
}

/**
 * 按 `## ` 章节边界把系统提示词的 token 估算分摊到各分类。
 */
function categorizeSystemPrompt(prompt: string, acc: Map<ContextUsageCategory, number>): void {
  let current: ContextUsageCategory = 'systemPrompt'
  for (const line of prompt.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) current = matchSectionCategory(heading[1])
    acc.set(current, (acc.get(current) ?? 0) + estimateTextTokenCount(line))
  }
}

/**
 * 工具定义 token：MCP 工具（`mcp__` 前缀）单列，其余算内置工具。
 */
function categorizeTools(
  tools: readonly ToolDefinitionLite[],
  acc: Map<ContextUsageCategory, number>,
): void {
  for (const tool of tools) {
    const category: ContextUsageCategory = tool.name.startsWith('mcp__') ? 'mcp' : 'tools'
    const text = `${tool.name}${tool.description}${JSON.stringify(tool.parameters ?? {})}`
    acc.set(category, (acc.get(category) ?? 0) + estimateTextTokenCount(text))
  }
}

/**
 * 对话历史 token：user / assistant / toolResult 消息全部计入。
 *
 * 此前只统计 user/assistant，遗漏了 toolResult 内容（文件读取结果、命令输出等，
 * 往往是单条消息里最大的部分），导致 rawTotal 被严重低估。等比缩放时
 * scale = usedTokens / rawTotal 被拉得过大，各分类展示值随对话增长而失真变大。
 */
function categorizeMessages(
  messages: readonly AgentMessage[],
  acc: Map<ContextUsageCategory, number>,
): void {
  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'toolResult') {
      acc.set('conversation', (acc.get('conversation') ?? 0) + estimateTokenCount([msg]))
    }
  }
}

/**
 * 构造上下文占用分类明细。返回值按 CATEGORY_ORDER 排序并过滤掉零值分类。
 */
export function buildContextUsageBreakdown(
  input: BuildContextUsageBreakdownInput,
): readonly ContextUsageBreakdownEntry[] {
  const acc = new Map<ContextUsageCategory, number>()

  categorizeSystemPrompt(input.systemPrompt, acc)
  categorizeTools(input.toolDefinitions, acc)
  categorizeMessages(input.messages, acc)

  const rawTotal = [...acc.values()].reduce((sum, n) => sum + n, 0)
  if (rawTotal <= 0) return []

  // ponytail: 等比缩放到提供商回执总量。分类内部是字符级估算，绝对值不准但占比可用；
  // 若日后需要精确分类计量，得在装配提示词时逐段调 tokenizer。
  const scale = input.usedTokens > 0 ? input.usedTokens / rawTotal : 1

  return CATEGORY_ORDER.map((category) => ({
    category,
    tokens: Math.round((acc.get(category) ?? 0) * scale),
  })).filter((entry) => entry.tokens > 0)
}
