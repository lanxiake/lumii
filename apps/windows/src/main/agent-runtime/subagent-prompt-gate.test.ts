import { describe, expect, it } from 'vitest'
import { shouldUseSubAgentPrompt } from './subagent-prompt-gate'

describe('shouldUseSubAgentPrompt', () => {
  it('非子实例 → false（主 Agent 永远走完整提示词）', () => {
    expect(
      shouldUseSubAgentPrompt({ hasParent: false, definitionId: 'assistant', grayList: ['assistant'] }),
    ).toBe(false)
  })

  it('名单为空 → 全部维持主 Agent 提示词（零回归的回滚点）', () => {
    expect(shouldUseSubAgentPrompt({ hasParent: true, definitionId: 'assistant', grayList: [] })).toBe(
      false,
    )
    expect(
      shouldUseSubAgentPrompt({ hasParent: true, definitionId: 'assistant', grayList: undefined }),
    ).toBe(false)
  })

  it('命中灰度名单 → true', () => {
    expect(
      shouldUseSubAgentPrompt({
        hasParent: true,
        definitionId: 'assistant',
        grayList: ['assistant', 'video-pro'],
      }),
    ).toBe(true)
  })

  it('不在名单里的 Agent → false（灰度只放行点名的那个）', () => {
    expect(
      shouldUseSubAgentPrompt({ hasParent: true, definitionId: 'chronicler', grayList: ['assistant'] }),
    ).toBe(false)
  })

  it('精确匹配，不做前缀/模糊（避免 assistant 顺带放行 assistant-x）', () => {
    expect(
      shouldUseSubAgentPrompt({ hasParent: true, definitionId: 'assistant-x', grayList: ['assistant'] }),
    ).toBe(false)
  })
})
