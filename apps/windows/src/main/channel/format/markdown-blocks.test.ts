/**
 * Markdown 块提取检查。
 * 重点：块类型识别准确、列表/表格连续行合并、围栏与分隔行不误伤正文。
 */
import { describe, expect, it } from 'vitest'
import { parseMarkdownBlocks } from './markdown-blocks'

describe('parseMarkdownBlocks', () => {
  it('空输入返回空数组', () => {
    expect(parseMarkdownBlocks('')).toEqual([])
    expect(parseMarkdownBlocks('\n\n  \n')).toEqual([])
  })

  it('识别各级标题', () => {
    expect(parseMarkdownBlocks('# 一\n### 三')).toEqual([
      { kind: 'heading', level: 1, text: '一' },
      { kind: 'heading', level: 3, text: '三' },
    ])
  })

  it('连续无序列表合并为一块', () => {
    expect(parseMarkdownBlocks('- 甲\n- 乙\n* 丙')).toEqual([
      { kind: 'list', ordered: false, items: ['甲', '乙', '丙'] },
    ])
  })

  it('有序列表合并，识别 1. 与 1) 两种写法', () => {
    expect(parseMarkdownBlocks('1. 甲\n2) 乙')).toEqual([
      { kind: 'list', ordered: true, items: ['甲', '乙'] },
    ])
  })

  it('围栏代码块整体收走，内部记号不解析', () => {
    expect(parseMarkdownBlocks('```ts\n# 不是标题\n- 不是列表\n```')).toEqual([
      { kind: 'code', text: '# 不是标题\n- 不是列表' },
    ])
  })

  it('未闭合的围栏吃到文末', () => {
    expect(parseMarkdownBlocks('```\nconst a = 1')).toEqual([
      { kind: 'code', text: 'const a = 1' },
    ])
  })

  it('引用连续行合并', () => {
    expect(parseMarkdownBlocks('> 甲\n> 乙')).toEqual([{ kind: 'quote', text: '甲\n乙' }])
  })

  it('表格丢弃分隔行、拆分单元格', () => {
    expect(parseMarkdownBlocks('| 甲 | 乙 |\n| --- | :---: |\n| 1 | 2 |')).toEqual([
      {
        kind: 'table',
        rows: [
          ['甲', '乙'],
          ['1', '2'],
        ],
      },
    ])
  })

  it('分隔线识别为 hr', () => {
    expect(parseMarkdownBlocks('---\n***\n___')).toEqual([
      { kind: 'hr' },
      { kind: 'hr' },
      { kind: 'hr' },
    ])
  })

  it('段落连续行合并保留软换行，遇到块起始即停', () => {
    expect(parseMarkdownBlocks('第一行\n第二行\n# 标题')).toEqual([
      { kind: 'paragraph', text: '第一行\n第二行' },
      { kind: 'heading', level: 1, text: '标题' },
    ])
  })

  it('混合文档按原始顺序产出块', () => {
    const blocks = parseMarkdownBlocks(
      '# 报告\n\n今天完成三件事。\n\n1. 甲\n2. 乙\n\n> 备注一行\n\n---\n\n结尾段落。',
    )
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'quote',
      'hr',
      'paragraph',
    ])
  })
})
