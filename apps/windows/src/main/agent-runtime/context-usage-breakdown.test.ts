import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import {
  applyConversationCompactToUsage,
  buildContextUsageBreakdown,
  calibrateCharsPerToken,
  countPromptChars,
  patchBreakdownAfterConversationCompact,
} from './context-usage-breakdown'

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
  it('无标定值时按章节归类并缩放到提供商总量', () => {
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

  it('压缩只扣对话差值，MCP/工具总量保持', () => {
    // 212K 总量、对话估算 101.1K → 36.4K，应对齐用户看到的 212K → ~147K
    expect(applyConversationCompactToUsage(212_000, 101_100, 36_400)).toBe(147_300)
  })

  it('patchBreakdown 只缩小 conversation，mcp 行不变', () => {
    const patched = patchBreakdownAfterConversationCompact(
      [
        { category: 'mcp', tokens: 93_300 },
        { category: 'conversation', tokens: 100_000 },
        { category: 'tools', tokens: 9_200 },
      ],
      101_100,
      36_400,
    )
    const byCategory = new Map(patched.map((e) => [e.category, e.tokens]))
    expect(byCategory.get('mcp')).toBe(93_300)
    expect(byCategory.get('tools')).toBe(9_200)
    expect(byCategory.get('conversation')).toBe(Math.round(100_000 * (36_400 / 101_100)))
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

describe('标定口径：固定部分不随对话增长', () => {
  /** 构造 n 轮对话 */
  const conversation = (n: number): AgentMessage[] =>
    Array.from({ length: n }, (_, i) =>
      i % 2 === 0
        ? { role: 'user', content: `第 ${i} 个问题，内容有一定长度用于放大差异。` }
        : { role: 'assistant', content: `第 ${i} 个回答，同样有一定长度用于放大差异。` },
    ) as unknown as AgentMessage[]

  const build = (messages: AgentMessage[], usedTokens: number) =>
    new Map(
      buildContextUsageBreakdown({
        systemPrompt: SYSTEM_PROMPT,
        toolDefinitions: TOOLS,
        messages,
        usedTokens,
        charsPerToken: 2.5,
      }).map((e) => [e.category, e.tokens]),
    )

  it('对话从 2 条涨到 50 条，固定分类 token 数完全不变', () => {
    // 这是用户报告的现象：系统提示词/工具/技能一个字没变，显示值却随聊天持续增长。
    const few = build(conversation(2), 8_000)
    const many = build(conversation(50), 40_000)

    for (const category of ['systemPrompt', 'tools', 'skills', 'mcp', 'memory'] as const) {
      expect(many.get(category)).toBe(few.get(category))
    }
    // 只有对话行增长
    expect(many.get('conversation')!).toBeGreaterThan(few.get('conversation')!)
  })

  it('明细之和严格等于提供商总量', () => {
    const entries = buildContextUsageBreakdown({
      systemPrompt: SYSTEM_PROMPT,
      toolDefinitions: TOOLS,
      messages: conversation(10),
      usedTokens: 12_345,
      charsPerToken: 2.5,
    })
    expect(entries.reduce((n, e) => n + e.tokens, 0)).toBe(12_345)
  })

  it('固定部分超过总量时压回 90%，对话行仍可见', () => {
    // usedTokens 很小（如提供商开缓存导致读数偏低），固定部分本会吃满
    const entries = buildContextUsageBreakdown({
      systemPrompt: SYSTEM_PROMPT,
      toolDefinitions: TOOLS,
      messages: conversation(2),
      usedTokens: 100,
      charsPerToken: 2.5,
    })
    const byCategory = new Map(entries.map((e) => [e.category, e.tokens]))
    expect(byCategory.get('conversation')).toBeGreaterThan(0)
    expect(entries.reduce((n, e) => n + e.tokens, 0)).toBe(100)
  })

  it('标定值越界时退回旧估算口径', () => {
    const insane = buildContextUsageBreakdown({
      systemPrompt: SYSTEM_PROMPT,
      toolDefinitions: TOOLS,
      messages: conversation(2),
      usedTokens: 10_000,
      charsPerToken: 9999,
    })
    const legacy = buildContextUsageBreakdown({
      systemPrompt: SYSTEM_PROMPT,
      toolDefinitions: TOOLS,
      messages: conversation(2),
      usedTokens: 10_000,
    })
    expect(insane).toEqual(legacy)
  })
})

describe('calibrateCharsPerToken', () => {
  it('首次标定直接取观测值', () => {
    expect(calibrateCharsPerToken(2_500, 1_000)).toBe(2.5)
  })

  it('有旧值时滑动更新，抑制单轮抖动', () => {
    // 旧值 2.0，观测 3.0 → 2.0*0.8 + 3.0*0.2 = 2.2
    expect(calibrateCharsPerToken(3_000, 1_000, 2.0)).toBeCloseTo(2.2, 6)
  })

  it('观测值越界时返回 undefined，不污染已有标定', () => {
    expect(calibrateCharsPerToken(1_000_000, 1, 2.5)).toBeUndefined()
    expect(calibrateCharsPerToken(1, 1_000_000, 2.5)).toBeUndefined()
  })

  it('非法输入返回 undefined', () => {
    expect(calibrateCharsPerToken(0, 100)).toBeUndefined()
    expect(calibrateCharsPerToken(100, 0)).toBeUndefined()
    expect(calibrateCharsPerToken(Number.NaN, 100)).toBeUndefined()
  })
})

describe('countPromptChars', () => {
  it('累加系统提示词、工具定义与消息字符数', () => {
    const chars = countPromptChars({
      systemPrompt: 'abc',
      toolDefinitions: [{ name: 'f', description: 'd', parameters: {} }],
      messages: [{ role: 'user', content: 'hi' }] as unknown as AgentMessage[],
    })
    // 'abc'(3) + 'f'+'d'+'{}'(4) + JSON 消息(>0)
    expect(chars).toBeGreaterThan(7)
  })
})
