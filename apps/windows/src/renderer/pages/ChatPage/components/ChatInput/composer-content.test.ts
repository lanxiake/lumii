/**
 * composer-content 的往返测试。
 *
 * 这层是「文本 ↔ chip」的翻译，判据只有一条：**往返必须逐字还原**。
 * 文本是对外契约（发送、草稿、渠道出站、Agent 认路径全靠它），
 * 翻译一旦丢字或加字，就是"看着对、发出去错"。
 */
import { describe, expect, it } from 'vitest'
import { buildQuoteMarkdown } from '../../../../selection/quote-bridge'
import type { FileReference } from './index'
import {
  buildComposerNodes,
  createFileChipNode,
  createQuoteChipNode,
  parseComposerText,
  parseQuoteLines,
  quoteChipLabel,
  serializeComposer,
} from './composer-content'

const CONFIG: FileReference = {
  relativePath: 'workspace/src/config',
  name: 'config',
  absolutePath: 'C:/ws/workspace/src/config',
  isDirectory: true,
}

const APP_TS: FileReference = {
  relativePath: 'workspace/src/app.ts',
  name: 'app.ts',
  absolutePath: 'C:/ws/workspace/src/app.ts',
  isDirectory: false,
}

/** 文本 → DOM → 文本 */
function roundTrip(text: string, refs: readonly FileReference[] = []): string {
  const host = document.createElement('div')
  host.append(...buildComposerNodes(parseComposerText(text, refs), document))
  return serializeComposer(host)
}

describe('parseQuoteLines（buildQuoteMarkdown 的逆）', () => {
  it.each([
    [{ text: '一行' }],
    [{ text: '第一行\n第二行' }],
    [{ text: '空行\n\n尾行' }],
    [{ text: '带出处', title: '会话标题' }],
    [{ text: '没有标题', role: 'assistant' as const }],
    [{ text: '没有标题', role: 'user' as const }],
  ])('往返还原 %o', (input) => {
    const lines = buildQuoteMarkdown(input).split('\n')
    expect(parseQuoteLines(lines)).toEqual({
      text: input.text,
      title: (input as { title?: string }).title,
      role: (input as { role?: 'user' | 'assistant' }).role,
    })
  })

  it('不以 > 开头的块不认', () => {
    expect(parseQuoteLines(['普通一行'])).toBeNull()
  })
})

describe('parseComposerText', () => {
  it('整块文本原样穿过（不认的东西不进 chip）', () => {
    expect(parseComposerText('随便写点什么\n再来一行')).toEqual([
      { kind: 'text', text: '随便写点什么\n再来一行' },
    ])
  })

  it('行首的 > 块认成引用，正文中间的 > 不认', () => {
    const segments = parseComposerText('看这个\n> 被引的正文\n> —— 来自助手回复\n结束')
    expect(segments.map((s) => s.kind)).toEqual(['text', 'quote', 'text'])
    expect(segments[1]).toMatchObject({ kind: 'quote', input: { text: '被引的正文', role: 'assistant' } })

    const inline = parseComposerText('小于号 > 后面这些不是引用')
    expect(inline.map((s) => s.kind)).toEqual(['text'])
  })

  it('在册的相对路径认成文件 chip，不在册的留作纯文本', () => {
    const segments = parseComposerText('看看 @workspace/src/app.ts 和 @workspace/other.ts', [APP_TS])
    expect(segments.map((s) => s.kind)).toEqual(['text', 'file', 'text'])
    expect(segments[1]).toMatchObject({ kind: 'file', ref: { relativePath: 'workspace/src/app.ts' } })
  })

  it('取最长匹配：目录与目录下的文件同时在册时不互相抢', () => {
    const segments = parseComposerText('@workspace/src/config/x.ts', [CONFIG, APP_TS].concat([
      { relativePath: 'workspace/src/config/x.ts', name: 'x.ts', absolutePath: 'C:/ws/x.ts', isDirectory: false },
    ]))
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ kind: 'file', ref: { relativePath: 'workspace/src/config/x.ts' } })
  })

  it('路径后紧跟字符不算命中（免得 @a/b 抢了 @a/bc 的前缀）', () => {
    const segments = parseComposerText('@workspace/src/app.tsx', [APP_TS])
    expect(segments.map((s) => s.kind)).toEqual(['text'])
  })
})

describe('往返', () => {
  it.each([
    '',
    '普通一行',
    '第一行\n第二行',
    '引用前面有字\n> 引一行\n> —— 来自《某会话》\n引用后面有字',
    '拖进来一个 @workspace/src/config 目录',
    '两个引用 @workspace/src/config 和 @workspace/src/app.ts 都在',
    '> 只有引用没有任何正文',
  ])('逐字还原：%j', (text) => {
    expect(roundTrip(text, [CONFIG, APP_TS])).toBe(text)
  })

  it('末尾那个给光标落脚的 <br> 不算内容', () => {
    const host = document.createElement('div')
    host.append(...buildComposerNodes(parseComposerText('有内容'), document))
    host.appendChild(document.createElement('br'))
    expect(serializeComposer(host)).toBe('有内容')
  })
})

describe('chip 节点', () => {
  it('引用 chip 带摘要与出处，悬停给全文', () => {
    const input = { text: '这是一段相当长的被引用的正文内容', title: '会话标题' }
    const chip = createQuoteChipNode(input, document)
    expect(chip.getAttribute('data-composer-chip')).toBe('quote')
    expect(chip.getAttribute('contenteditable')).toBe('false')
    expect(chip.getAttribute('data-quote-title')).toBe('会话标题')
    expect(chip.title).toBe(buildQuoteMarkdown(input))
    expect(chip.querySelector('[data-chip-remove]')).not.toBeNull()
    expect(quoteChipLabel(input)).toContain('来自《会话标题》')
  })

  it('文件 chip 区分目录与文件', () => {
    expect(createFileChipNode(CONFIG, document).textContent).toContain('目录 config')
    expect(createFileChipNode(APP_TS, document).textContent).toContain('app.ts')
  })
})
