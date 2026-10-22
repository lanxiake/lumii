/**
 * 对话观察者 — 规则预筛 + LLM 深度判断
 *
 * 两阶段设计：
 * 1. 规则预筛（毫秒级）：快速排除明显不值得提取的对话
 * 2. LLM 判断（可选）：对通过预筛的对话，让 LLM 决定是否值得生成技能
 */

import type { ConversationMessage, LLMCaller } from './types'

export interface ObservationResult {
  worthExtracting: boolean
  patternType?: 'workflow' | 'domain_knowledge' | 'tool_sequence'
  toolsUsed?: string[]
}

export interface LLMJudgmentResult {
  shouldExtract: boolean
  reason: string
}

const FAILURE_RE = /失败|错误|error|failed|exception/i
const NEGATIVE_RE = /不对|错了|重来|不是这样|wrong|redo/i

/** 简单字符串相似度（Jaccard on bigrams） */
function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const sa = bigrams(a.toLowerCase())
  const sb = bigrams(b.toLowerCase())
  const intersection = [...sa].filter(x => sb.has(x)).length
  const union = new Set([...sa, ...sb]).size
  return union === 0 ? 0 : intersection / union
}

/**
 * LLM 深度判断：对话是否值得提取为可复用技能
 *
 * 只在规则预筛通过后调用，避免每轮都消耗 LLM token。
 * LLM 需要判断：这段对话是否包含一个可复用的工作流或操作模式？
 */
export async function judgeWithLLM(
  messages: ConversationMessage[],
  existingSkillNames: string[],
  callLLM: LLMCaller,
  instanceId?: string,
): Promise<LLMJudgmentResult> {
  const steps: string[] = []
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolName) {
      steps.push(`[工具] ${msg.toolName}`)
    } else if (msg.role === 'assistant') {
      const snippet = msg.content.slice(0, 60).replace(/\n/g, ' ')
      if (snippet.trim()) steps.push(`[助手] ${snippet}`)
    } else if (msg.role === 'user') {
      const snippet = msg.content.slice(0, 50).replace(/\n/g, ' ')
      if (snippet.trim()) steps.push(`[用户] ${snippet}`)
    }
  }

  const prompt = `请判断以下对话是否包含一个值得保存为"可复用技能"的工作流或操作模式。

判断标准：
- 包含明确的、可重复执行的步骤序列
- 用户目标已成功完成（无明显失败或放弃）
- 这个流程在未来类似场景中可以直接复用
- 不是一次性的、高度个性化的操作

已有技能（避免重复）：${existingSkillNames.join(', ') || '无'}

对话摘要：
${steps.join('\n')}

请只输出 JSON，不要有任何额外文字：
{"shouldExtract": true/false, "reason": "一句话说明原因"}`

  try {
    const raw = await callLLM(prompt, instanceId)
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/)
    const jsonStr = jsonMatch ? jsonMatch[1] : raw
    const parsed = JSON.parse(jsonStr)
    return {
      shouldExtract: Boolean(parsed.shouldExtract),
      reason: String(parsed.reason ?? ''),
    }
  } catch {
    // LLM 判断失败时保守处理：不提取
    return { shouldExtract: false, reason: 'LLM 判断失败，跳过提取' }
  }
}

export function observe(
  messages: ConversationMessage[],
  existingSkillNames: string[],
): ObservationResult {
  // 规则1：对话轮次 ≥ 3（user+assistant 消息对 ≥ 3）
  const pairs = messages.filter(m => m.role === 'user' || m.role === 'assistant')
  const userCount = pairs.filter(m => m.role === 'user').length
  const assistantCount = pairs.filter(m => m.role === 'assistant').length
  if (Math.min(userCount, assistantCount) < 3) {
    return { worthExtracting: false }
  }

  // 规则2：Agent 使用了 ≥ 2 个不同工具
  const toolMessages = messages.filter(m => m.role === 'tool' && m.toolName)
  const uniqueTools = new Set(toolMessages.map(m => m.toolName!))
  if (uniqueTools.size < 2) {
    return { worthExtracting: false }
  }

  // 规则3：最后一条 Agent 消息不含失败信号
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  if (lastAssistant && FAILURE_RE.test(lastAssistant.content)) {
    return { worthExtracting: false }
  }

  // 规则4：对话中无用户否定反馈
  const hasNegative = messages
    .filter(m => m.role === 'user')
    .some(m => NEGATIVE_RE.test(m.content))
  if (hasNegative) {
    return { worthExtracting: false }
  }

  // 规则5：与现有技能名称无高度重叠
  const toolList = [...uniqueTools].join(' ')
  const tooSimilar = existingSkillNames.some(name => similarity(name, toolList) >= 0.7)
  if (tooSimilar) {
    return { worthExtracting: false }
  }

  // 判断 patternType
  let patternType: ObservationResult['patternType'] = 'tool_sequence'
  if (uniqueTools.size >= 4) patternType = 'workflow'
  else if (assistantCount >= 5) patternType = 'domain_knowledge'

  return {
    worthExtracting: true,
    patternType,
    toolsUsed: [...uniqueTools],
  }
}
