import { describe, expect, it } from 'vitest'
import {
  isCompactSummaryText,
  unwrapCompactSummaryText,
} from './compact-summary-text'

describe('isCompactSummaryText', () => {
  it('识别手动压缩前缀', () => {
    expect(isCompactSummaryText('[对话摘要]\n用户想改压缩卡片')).toBe(true)
  })

  it('识别自动压缩注入消息', () => {
    expect(
      isCompactSummaryText(
        'This session is being continued from a previous conversation that ran out of context.',
      ),
    ).toBe(true)
    expect(isCompactSummaryText('<conversation_summary>先前讨论了压缩</conversation_summary>')).toBe(
      true,
    )
  })

  it('普通回复不是摘要', () => {
    expect(isCompactSummaryText('好的，我继续改。')).toBe(false)
    expect(isCompactSummaryText(undefined)).toBe(false)
  })
})

describe('unwrapCompactSummaryText', () => {
  it('去掉手动压缩前缀', () => {
    expect(unwrapCompactSummaryText('[对话摘要]\n关键决策：只扣对话历史')).toBe(
      '关键决策：只扣对话历史',
    )
  })

  it('抽出 conversation_summary 标签内文', () => {
    expect(
      unwrapCompactSummaryText('<conversation_summary>\n  先前讨论了 MCP\n</conversation_summary>'),
    ).toBe('先前讨论了 MCP')
  })
})
