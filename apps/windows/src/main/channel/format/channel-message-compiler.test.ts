/**
 * 渠道消息编译器检查。
 * 重点：飞书短/长分流与卡片结构、企微/QQ 语法子集清洗、微信段落打包与截断。
 */
import { describe, expect, it } from 'vitest'
import {
  compileForFeishu,
  compileForQbot,
  compileForWecom,
  compileForWeixin,
} from './channel-message-compiler'

describe('compileForFeishu', () => {
  it('短文本走 text 且已降级 Markdown 记号', () => {
    const r = compileForFeishu('**加粗** 与 [链接](https://a.com)')
    expect(r.kind).toBe('text')
    if (r.kind === 'text') {
      expect(r.text).toBe('加粗 与 链接')
    }
  })

  it('含标题结构走卡片，首个标题提为 header 且不重复出现在正文', () => {
    const r = compileForFeishu('# 今日要闻\n\n1. 甲\n2. 乙')
    expect(r.kind).toBe('card')
    if (r.kind === 'card') {
      expect(r.card.header.title.content).toBe('今日要闻')
      const divs = r.card.elements.filter((e) => e.tag === 'div')
      expect(divs).toHaveLength(1)
      expect((divs[0] as { text: { content: string } }).text.content).toBe('1. 甲\n2. 乙')
    }
  })

  it('显式 title 优先，heading 保留在正文', () => {
    const r = compileForFeishu('# 子标题\n\n正文内容', '工作日报')
    expect(r.kind).toBe('card')
    if (r.kind === 'card') {
      expect(r.card.header.title.content).toBe('工作日报')
      const divs = r.card.elements.filter((e) => e.tag === 'div')
      expect((divs[0] as { text: { content: string } }).text.content).toBe('**子标题**')
    }
  })

  it('超长纯文本（无标题）也走卡片', () => {
    const r = compileForFeishu('测'.repeat(600))
    expect(r.kind).toBe('card')
  })

  it('正文超上限时截断并附提示，fallbackText 始终可用', () => {
    const r = compileForFeishu('字'.repeat(9000), '长报告')
    expect(r.kind).toBe('card')
    if (r.kind === 'card') {
      const texts = r.card.elements
        .filter((e) => e.tag === 'div')
        .map((e) => (e as { text: { content: string } }).text.content)
      expect(texts[texts.length - 1]).toContain('内容过长已截断')
      expect(r.fallbackText.length).toBeGreaterThan(0)
      expect(r.fallbackText).not.toContain('**')
    }
  })

  it('无标题且无 heading 时 header 回落到产品名', () => {
    const r = compileForFeishu('很长的一段话。'.repeat(100))
    expect(r.kind).toBe('card')
    if (r.kind === 'card') {
      expect(r.card.header.title.content).toBe('灵栖')
    }
  })

  it('全文只有一个标题时没有卡片正文可放，回落 text', () => {
    const r = compileForFeishu('# 只有标题')
    expect(r.kind).toBe('text')
    if (r.kind === 'text') {
      expect(r.text).toBe('【只有标题】')
    }
  })
})

describe('compileForWecom / compileForQbot', () => {
  it('title 渲染为一级标题', () => {
    expect(compileForWecom('正文', '日报')).toBe('# 日报\n\n正文')
  })

  it('表格降级为竖线文本行、代码块去围栏', () => {
    const out = compileForWecom('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst a = 1\n```')
    expect(out).toBe('甲 | 乙\n1 | 2\n\nconst a = 1')
  })

  it('有序列表重排序号，标题保留记号', () => {
    const out = compileForWecom('## 节\n\n1. 甲\n1. 乙')
    expect(out).toBe('## 节\n\n1. 甲\n2. 乙')
  })

  it('QQ 编译单条且受 3500 字上限截断', () => {
    const out = compileForQbot('字'.repeat(9000))
    expect(out.length).toBeLessThanOrEqual(3501)
    expect(out).not.toContain('```')
  })
})

describe('compileForWeixin', () => {
  it('空输入返回空数组', () => {
    expect(compileForWeixin('')).toEqual([])
    expect(compileForWeixin('   \n\n  ')).toEqual([])
  })

  it('短消息编译为单段，去装饰并规范序号', () => {
    const segs = compileForWeixin('# 今日要闻\n\n- **甲**\n- 乙')
    expect(segs).toHaveLength(1)
    expect(segs[0]).toBe('【今日要闻】\n\n· 甲\n· 乙')
  })

  it('有序列表重排序号', () => {
    const segs = compileForWeixin('1. 甲\n1. 乙\n1. 丙')
    expect(segs[0]).toBe('1. 甲\n2. 乙\n3. 丙')
  })

  it('title 作为来源标签放首段开头', () => {
    const segs = compileForWeixin('正文内容', '工作日报')
    expect(segs[0]).toBe('【工作日报】\n\n正文内容')
  })

  it('超过单段上限时按段落打包成多段', () => {
    const p1 = `第一段${'甲'.repeat(600)}`
    const p2 = `第二段${'乙'.repeat(600)}`
    const segs = compileForWeixin(`${p1}\n\n${p2}`)
    expect(segs.length).toBe(2)
    expect(segs[0]).toContain('第一段')
    expect(segs[1]).toContain('第二段')
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(1000)
  })

  it('超过段数上限时截断并在末段附提示', () => {
    const paras = Array.from({ length: 6 }, (_, i) => `第${i + 1}段${'字'.repeat(600)}`)
    const segs = compileForWeixin(paras.join('\n\n'))
    expect(segs).toHaveLength(5)
    expect(segs[4]).toContain('内容过长已截断')
  })

  it('单行超过段上限时硬切，每段不超限', () => {
    const segs = compileForWeixin('字'.repeat(2500))
    expect(segs).toHaveLength(3)
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(1000)
  })

  it('极端输入（纯分隔线）编译为空时退回原文，不静默丢失', () => {
    expect(compileForWeixin('---')).toEqual(['---'])
    expect(compileForWeixin('   \n\n  ')).toEqual([])
  })

  it('词内下划线/星号原样保留（user_id_x、__init__、a*b 不被当斜体吞掉）', () => {
    const segs = compileForWeixin('运行 `user_id_x`，调用 __init__，计算 a*b，再看 _强调_ 与 *斜体*')
    expect(segs[0]).toContain('user_id_x')
    expect(segs[0]).toContain('__init__')
    expect(segs[0]).toContain('a*b')
    expect(segs[0]).toContain('强调')
    expect(segs[0]).not.toContain('_强调_')
    expect(segs[0]).toContain('斜体')
    expect(segs[0]).not.toContain('*斜体*')
  })
})
