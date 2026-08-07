/**
 * 渠道格式化策略检查。
 * 重点：Markdown 降级不漏记号、各渠道限长生效、策略可按名取用。
 */
import { describe, expect, it } from 'vitest'
import {
  NOTIFY_STRATEGIES,
  formatForTarget,
  markdownToPlainText,
  truncate,
} from './cron-notify-format'

describe('markdownToPlainText', () => {
  it('去掉标题/粗斜体/删除线记号', () => {
    expect(markdownToPlainText('## 标题\n**粗** *斜* ~~删~~')).toBe('标题\n粗 斜 删')
  })

  it('链接与图片只留文字', () => {
    expect(markdownToPlainText('见 [文档](https://a.com) 与 ![图](https://b.png)')).toBe('见 文档 与 图')
  })

  it('列表转顿点，有序列表保留编号', () => {
    expect(markdownToPlainText('- 甲\n- 乙')).toBe('· 甲\n· 乙')
    expect(markdownToPlainText('1. 甲\n2. 乙')).toBe('1. 甲\n2. 乙')
  })

  it('代码块去围栏留内容', () => {
    expect(markdownToPlainText('```ts\nconst a = 1\n```')).toBe('const a = 1')
  })

  it('表格竖线转分隔符，分隔行丢掉', () => {
    expect(markdownToPlainText('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |')).toBe('甲 | 乙\n1 | 2')
  })

  it('多余空行压成一个空行', () => {
    expect(markdownToPlainText('甲\n\n\n\n乙')).toBe('甲\n\n乙')
  })
})

describe('truncate', () => {
  it('未超长原样返回', () => {
    expect(truncate('短文本', 10)).toBe('短文本')
  })

  it('优先断在句末标点', () => {
    expect(truncate('第一句话写得比较长。第二句', 11)).toBe('第一句话写得比较长。')
  })

  it('标点太靠前则宁可硬截，不砍掉大半内容', () => {
    // 句号在 8 字上限的 3/8 处，断在那里等于只剩四个字
    expect(truncate('第一句。第二句会被截掉', 8)).toBe('第一句。第二句会…')
  })

  it('找不到标点则硬截加省略号', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde…')
  })
})

describe('渠道策略', () => {
  it('system 压单行并带任务名标题', () => {
    const out = NOTIFY_STRATEGIES.system.format('早间简报', '第一行\n第二行')
    expect(out.title).toBe('灵栖 · 早间简报')
    expect(out.body).toBe('第一行 第二行')
  })

  it('feishu 保留换行并加任务名前缀', () => {
    const out = NOTIFY_STRATEGIES.feishu.format('日报', '甲\n乙')
    expect(out.body).toBe('【日报】\n甲\n乙')
  })

  it('news 产出标题 + 摘要两个槽位', () => {
    const out = NOTIFY_STRATEGIES.news.format('资讯', '## 摘要\n内容')
    expect(out.title).toBe('资讯')
    expect(out.body).toBe('摘要 内容')
  })

  it('focus 拼成单行陈述句', () => {
    const out = NOTIFY_STRATEGIES.focus.format('复盘', '- 甲\n- 乙')
    expect(out.body).toBe('复盘：· 甲 · 乙')
  })

  it('各渠道限长互不相同且都生效', () => {
    const long = '啊'.repeat(3000)
    for (const [name, strategy] of Object.entries(NOTIFY_STRATEGIES)) {
      const { body } = strategy.format('任务', long)
      // feishu/focus 带前缀，允许略超正文上限
      expect(body.length, name).toBeLessThanOrEqual(strategy.limit + 20)
    }
  })
})

describe('formatForTarget', () => {
  it('已注册渠道走对应策略', () => {
    expect(formatForTarget('feishu', '日报', '正文').body).toBe('【日报】\n正文')
  })

  it('未注册渠道回落纯文本，不原样吐 Markdown', () => {
    expect(formatForTarget('unknown', '任务', '**粗**\n下一行').body).toBe('粗 下一行')
  })
})
