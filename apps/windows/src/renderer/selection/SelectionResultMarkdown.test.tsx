/**
 * L2 结果的 Markdown 渲染测试。
 *
 * 判据集中在两件事上：
 *   1. 结构要真的被"读出来"（标题是 h2、列表是 ul、引用是 blockquote），
 *   2. **标记本身不能漏成文字** —— 渲染器没认出来的话用户会看到一屏 `**` 和 `##`，
 *      这正是替换前纯文本渲染的样子。
 *
 * 类名按原样写：vitest 的 `css.modules.classNameStrategy: 'non-scoped'` 下，
 * CSS Module 的类名不会被哈希（真实构建里会，所以只有测试能这么查）。
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import React from 'react'
import { SelectionResultMarkdown } from './SelectionResultMarkdown'

function renderMarkdown(text: string) {
  return render(<SelectionResultMarkdown text={text} />).container
}

describe('SelectionResultMarkdown', () => {
  it('标题渲染成真标题，并带手绘下划线的类', () => {
    const container = renderMarkdown('## 结论\n\n正文一段。')

    const heading = container.querySelector('h2')
    expect(heading).not.toBeNull()
    expect(heading?.textContent).toBe('结论')
    expect(heading?.className).toContain('sr-heading')
  })

  it('`**重点**` 变成荧光笔标记，星号不漏成文字', () => {
    const container = renderMarkdown('这里的 **关键结论** 要标出来')

    const mark = container.querySelector('strong')
    expect(mark?.textContent).toBe('关键结论')
    expect(mark?.className).toContain('sr-mark')
    expect(container.textContent).not.toContain('**')
  })

  it('无序与有序列表都认，星号与序号不漏成文字', () => {
    const unordered = renderMarkdown('- 甲\n- 乙')
    expect(unordered.querySelectorAll('ul > li')).toHaveLength(2)
    expect(unordered.textContent).not.toContain('- ')

    const ordered = renderMarkdown('1. 一\n2. 二')
    expect(ordered.querySelectorAll('ol > li')).toHaveLength(2)
  })

  it('引用块当便签渲染', () => {
    const container = renderMarkdown('> 一句被引用的话')
    const quote = container.querySelector('blockquote')
    // 引用里的正文会被 Markdown 再包一层 <p>，所以 textContent 前后带换行
    expect(quote?.textContent?.trim()).toBe('一句被引用的话')
    expect(quote?.className).toContain('sr-quote')
  })

  it('纯文本结果照常显示（短结果不该被结构污染）', () => {
    const container = renderMarkdown('A piece of selected text')
    expect(container.textContent).toBe('A piece of selected text')
    expect(container.querySelector('p')).not.toBeNull()
  })

  it('段落之间分开，不是挤成一坨', () => {
    const container = renderMarkdown('第一段\n\n第二段')
    expect(container.querySelectorAll('p')).toHaveLength(2)
  })

  it('原始 HTML 不执行（结果来自模型，当数据看）', () => {
    const container = renderMarkdown('<img src=x onerror="window.__xss=1">')
    expect(container.querySelector('img')).toBeNull()
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined()
  })
})
