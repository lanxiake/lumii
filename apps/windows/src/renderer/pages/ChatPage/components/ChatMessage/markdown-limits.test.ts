/**
 * markdown-limits 单元测试
 *
 * 覆盖超长正文的两道体积闸门：代码块高亮跳过、以及阈值之间的大小关系。
 * 这些判据一旦算错，要么让大文本重新拖垮滚动（阈值过大），要么误伤正常代码块（阈值过小）。
 */
import { describe, it, expect } from 'vitest'
import {
  hastTextExceeds,
  markLargeCodeBlocks,
  walkHastElements,
  HIGHLIGHT_MAX_CHARS,
  MATH_MAX_CHARS,
  PLAIN_TEXT_THRESHOLD,
  type HastNode,
} from './markdown-limits'

const text = (value: string): HastNode => ({ type: 'text', value })

const code = (content: string, className: string[] = []): HastNode => ({
  type: 'element',
  tagName: 'code',
  properties: { className },
  children: [text(content)],
})

const pre = (child: HastNode): HastNode => ({
  type: 'element',
  tagName: 'pre',
  children: [child],
})

const root = (children: HastNode[]): HastNode => ({ type: 'root', children })

/** 超过高亮闸门一个字符的代码块 */
const oversized = (className: string[] = []) =>
  pre(code('x'.repeat(HIGHLIGHT_MAX_CHARS + 1), className))

const classNameOf = (node: HastNode): unknown => node.children?.[0]?.properties?.['className']

describe('hastTextExceeds', () => {
  it('未超过 limit 时返回 false', () => {
    expect(hastTextExceeds(code('abcdef'), 10)).toBe(false)
  })

  it('超过 limit 时返回 true', () => {
    expect(hastTextExceeds(code('x'.repeat(11)), 10)).toBe(true)
  })

  it('恰好等于 limit 不算超过（判据是严格大于）', () => {
    expect(hastTextExceeds(code('x'.repeat(10)), 10)).toBe(false)
  })

  it('累加嵌套子节点的文本', () => {
    const nested: HastNode = {
      type: 'element',
      tagName: 'span',
      children: [
        text('aaaa'),
        { type: 'element', tagName: 'em', children: [text('bbbb')] },
      ],
    }
    expect(hastTextExceeds(nested, 7)).toBe(true)
    expect(hastTextExceeds(nested, 8)).toBe(false)
  })

  it('无文本子节点时返回 false', () => {
    expect(hastTextExceeds({ type: 'element', tagName: 'br' }, 0)).toBe(false)
  })
})

describe('walkHastElements', () => {
  it('深度优先访问所有元素节点，不含文本节点', () => {
    const tree = root([
      pre(code('a')),
      { type: 'element', tagName: 'p', children: [text('b')] },
    ])
    const seen: string[] = []
    walkHastElements(tree, (el) => seen.push(el.tagName ?? ''))
    expect(seen).toEqual(['pre', 'code', 'p'])
  })
})

describe('markLargeCodeBlocks', () => {
  it('给超长代码块追加 no-highlight，并保留原有 language class', () => {
    const tree = oversized(['language-java'])
    markLargeCodeBlocks(tree)
    expect(classNameOf(tree)).toEqual(['language-java', 'no-highlight'])
  })

  it('短代码块不受影响', () => {
    const tree = pre(code('const a = 1', ['language-js']))
    markLargeCodeBlocks(tree)
    expect(classNameOf(tree)).toEqual(['language-js'])
  })

  it('已有 no-highlight 时不重复追加', () => {
    const tree = oversized(['no-highlight'])
    markLargeCodeBlocks(tree)
    expect(classNameOf(tree)).toEqual(['no-highlight'])
  })

  it('无 className 的超长代码块也能标记', () => {
    const tree = oversized()
    markLargeCodeBlocks(tree)
    expect(classNameOf(tree)).toEqual(['no-highlight'])
  })

  it('不改动非 code 元素，即使其文本超长', () => {
    const paragraph: HastNode = {
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [text('x'.repeat(HIGHLIGHT_MAX_CHARS + 1))],
    }
    markLargeCodeBlocks(root([paragraph]))
    expect(paragraph.properties).toEqual({})
  })
})

describe('阈值配置', () => {
  it('MATH_MAX_CHARS 小于 PLAIN_TEXT_THRESHOLD，否则数学闸门永远不会生效', () => {
    expect(MATH_MAX_CHARS).toBeLessThan(PLAIN_TEXT_THRESHOLD)
  })
})
