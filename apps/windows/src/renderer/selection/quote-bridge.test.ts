/**
 * 引用投递桥测试
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildQuoteMarkdown,
  hasQuoteSink,
  insertQuote,
  registerQuoteSink,
  type QuoteSink,
} from './quote-bridge'

const cleanups: Array<() => void> = []

function register(sink: QuoteSink): () => void {
  const off = registerQuoteSink(sink)
  cleanups.push(off)
  return off
}

afterEach(() => {
  // 模块级单例：用例之间必须清干净，否则顺序会互相影响
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('buildQuoteMarkdown', () => {
  it('单行文本加 > 前缀', () => {
    expect(buildQuoteMarkdown({ text: '一句话' })).toBe('> 一句话')
  })

  it('多行逐行加前缀，空行写成裸 >', () => {
    expect(buildQuoteMarkdown({ text: '第一行\n\n第三行' })).toBe('> 第一行\n>\n> 第三行')
  })

  it('出处优先用标题', () => {
    expect(buildQuoteMarkdown({ text: 'x', title: '划词设计', role: 'assistant' })).toBe(
      '> x\n> —— 来自《划词设计》',
    )
  })

  it('没有标题时按角色兜底', () => {
    expect(buildQuoteMarkdown({ text: 'x', role: 'assistant' })).toBe('> x\n> —— 来自助手回复')
    expect(buildQuoteMarkdown({ text: 'x', role: 'user' })).toBe('> x\n> —— 来自我的提问')
  })

  it('标题与角色都没有时不写出处行', () => {
    expect(buildQuoteMarkdown({ text: 'x' })).toBe('> x')
  })

  it('保留尾部换行对应的空行，不吞文本', () => {
    expect(buildQuoteMarkdown({ text: 'a\n' })).toBe('> a\n>')
  })
})

describe('引用投递桥', () => {
  it('无 sink 时 hasQuoteSink 为假、insertQuote 返回 false', () => {
    expect(hasQuoteSink()).toBe(false)
    expect(insertQuote({ text: 'x' })).toBe(false)
  })

  it('注册后 insertQuote 转发入参并透传 sink 的返回值', () => {
    const sink = vi.fn(() => true)
    register(sink)

    expect(hasQuoteSink()).toBe(true)
    expect(insertQuote({ text: '一段', role: 'user' })).toBe(true)
    expect(sink).toHaveBeenCalledWith({ text: '一段', role: 'user' })
  })

  it('sink 拒绝时返回 false', () => {
    register(() => false)
    expect(insertQuote({ text: 'x' })).toBe(false)
  })

  it('注销后恢复为不可用', () => {
    const off = register(() => true)
    off()
    expect(hasQuoteSink()).toBe(false)
    expect(insertQuote({ text: 'x' })).toBe(false)
  })

  it('先挂的 sink 被卸载时，不该把后挂的那个一起清掉', () => {
    const first = register(() => true)
    const second = vi.fn(() => true)
    register(second)

    first() // 先挂的那个卸载，此时 active 已经是 second

    expect(hasQuoteSink()).toBe(true)
    expect(insertQuote({ text: 'x' })).toBe(true)
    expect(second).toHaveBeenCalled()
  })
})
