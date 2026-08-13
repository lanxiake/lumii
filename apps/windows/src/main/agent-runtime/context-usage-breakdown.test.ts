import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { buildContextUsageBreakdown } from './context-usage-breakdown'

const SYSTEM_PROMPT = [
  '你是灵栖。',
  '## Skills',
  '技能列表很长'.repeat(40),
  '## MCP Servers',
  'mcp 说明',
  '## Memory',
  '记忆说明',
  '## Language',
  '始终用中文回复',
].join('\n')

const TOOLS = [
  { name: 'file_read', description: '读取文件', parameters: { type: 'object' } },
  { name: 'mcp__ynote__createNote', description: '创建笔记', parameters: { type: 'object' } },
]

const MESSAGES: AgentMessage[] = [
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '你好，有什么可以帮你的？' },
] as unknown as AgentMessage[]

describe('buildContextUsageBreakdown', () => {
  it('按章节归类并缩放到提供商总量', () => {
    const result = buildContextUsageBreakdown({
      systemPrompt: SYSTEM_PROMPT,
      toolDefinitions: TOOLS,
      messages: MESSAGES,
      usedTokens: 10_000,
    })

    const byCategory = new Map(result.map((e) => [e.category, e.tokens]))
    // 章节各自归位
    expect(byCategory.get('skills')).toBeGreaterThan(0)
    expect(byCategory.get('mcp')).toBeGreaterThan(0)
    expect(byCategory.get('memory')).toBeGreaterThan(0)
    // 未命中的章节（Language / 首行身份）落到系统提示词
    expect(byCategory.get('systemPrompt')).toBeGreaterThan(0)
    expect(byCategory.get('tools')).toBeGreaterThan(0)
    expect(byCategory.get('conversation')).toBeGreaterThan(0)

    // 缩放后之和≈总量（各项取整带来 ±分类数 的误差）
    const sum = result.reduce((n, e) => n + e.tokens, 0)
    expect(Math.abs(sum - 10_000)).toBeLessThanOrEqual(result.length)

    // Skills 章节最长，应占比最高
    const top = [...result].sort((a, b) => b.tokens - a.tokens)[0]
    expect(top.category).toBe('skills')
  })

  it('usedTokens 为 0 时退回原始估算，不缩放', () => {
    const result = buildContextUsageBreakdown({
      systemPrompt: '## Skills\n技能',
      toolDefinitions: [],
      messages: [],
      usedTokens: 0,
    })
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((e) => e.tokens > 0)).toBe(true)
  })

  it('空输入返回空数组', () => {
    expect(
      buildContextUsageBreakdown({
        systemPrompt: '',
        toolDefinitions: [],
        messages: [],
        usedTokens: 5000,
      }),
    ).toEqual([])
  })
})
