/**
 * 压缩摘要落库形态：必须能被 messageRowToAgentMessages 投影进 Agent 上下文。
 */
import { describe, expect, it } from 'vitest'
import { messageRowToAgentMessages } from '@mtbot/agent-runtime'
import {
  buildPersistedCompactSummary,
  resolveCompactSummaryTimestamp,
} from './compact-persist'

describe('buildPersistedCompactSummary', () => {
  it('写成 assistant_parts，loadMessagesAsPiFormat 能投影为 assistant 文本', () => {
    const content = buildPersistedCompactSummary('关键决策：改用分段渲染')
    expect(content.type).toBe('assistant_parts')

    const msgs = messageRowToAgentMessages({
      id: 's1',
      conversation_id: 'c1',
      agent_id: null,
      role: 'assistant',
      content_json: JSON.stringify(content),
      timestamp: '2026-08-13T12:00:00.000Z',
      is_streaming: 0,
    })

    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.role).toBe('assistant')
    const blocks = msgs[0]?.content as Array<{ type: string; text?: string }>
    expect(blocks.some((b) => b.text?.includes('关键决策：改用分段渲染'))).toBe(true)
    expect(blocks.some((b) => b.text?.startsWith('[对话摘要]'))).toBe(true)
  })

  it('旧的 assistant type=text 无法投影（回归：压缩摘要曾因此从后续对话消失）', () => {
    const msgs = messageRowToAgentMessages({
      id: 's1',
      conversation_id: 'c1',
      agent_id: null,
      role: 'assistant',
      content_json: JSON.stringify({ type: 'text', text: '[对话摘要]\n关键决策' }),
      timestamp: '2026-08-13T12:00:00.000Z',
      is_streaming: 0,
    })
    expect(msgs).toEqual([])
  })
})

describe('resolveCompactSummaryTimestamp', () => {
  it('插在首条保留消息之前 1ms，保证摘要排在最近原文前面', () => {
    const kept = '2026-08-13T12:00:00.000Z'
    const ts = resolveCompactSummaryTimestamp(kept)
    expect(Date.parse(ts)).toBe(Date.parse(kept) - 1)
  })

  it('无保留段时返回当前时间附近的 ISO 字符串', () => {
    const ts = resolveCompactSummaryTimestamp(undefined)
    expect(Number.isNaN(Date.parse(ts))).toBe(false)
  })
})
