/**
 * 会话标题推导（deriveConversationTitleFromUserText）。
 *
 * 守一件事：标题**不截断、不拼接字面省略号**。曾经的 18 字硬砍 + 「...」
 * 会把省略号写进数据，侧栏与重命名框里显示的都不是真名。
 */
import { describe, expect, it } from 'vitest'
import { deriveConversationTitleFromUserText } from './conversation-title'

describe('deriveConversationTitleFromUserText', () => {
  it('短文本原样返回', () => {
    expect(deriveConversationTitleFromUserText('帮我写周报')).toBe('帮我写周报')
  })

  it('长文本不截断、不加「...」', () => {
    const text = '帮我分析一下这份合同的违约责任条款和付款方式是否合理'
    const title = deriveConversationTitleFromUserText(text)
    expect(title).toBe(text)
    expect(title).not.toContain('...')
  })

  it('只取首个句子', () => {
    expect(deriveConversationTitleFromUserText('先做这个。然后再做那个')).toBe('先做这个')
    expect(deriveConversationTitleFromUserText('先做这个！然后再说')).toBe('先做这个')
  })

  it('空文本回落到「新对话」', () => {
    expect(deriveConversationTitleFromUserText('')).toBe('新对话')
    expect(deriveConversationTitleFromUserText('   \n  ')).toBe('新对话')
  })

  it('去掉行首的列表符号/编号', () => {
    expect(deriveConversationTitleFromUserText('1. 读取配置文件')).toBe('读取配置文件')
    expect(deriveConversationTitleFromUserText('- 帮我查个东西')).toBe('帮我查个东西')
  })
})
