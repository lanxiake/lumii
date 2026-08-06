/**
 * news-store 解析自检
 *
 * 只测「RSS 文本 → NewsItem」这段纯逻辑：实体解码、CDATA、HTML 剥离、时间解析、
 * 缺字段跳过、条数上限。抓取与落盘走网络和磁盘，不在单测范围。
 */

import { describe, expect, it } from 'vitest'
import { __testables } from './news-store'

const { parseRss, stripTags, decodeEntities } = __testables

function rss(items: string): string {
  return `<rss version="2.0"><channel><title>t</title>${items}</channel></rss>`
}

describe('news-store 解析', () => {
  it('解出标题/链接/时间/摘要，HTML 被剥掉', () => {
    const xml = rss(`
      <item>
        <title>冥王星发现液体证据</title>
        <description>&lt;p&gt;IT之家 8 月 6 日消息&lt;/p&gt;&lt;img src="x.png"/&gt;</description>
        <link>https://www.ithome.com/0/986/510.htm</link>
        <pubDate>Thu, 06 Aug 2026 07:00:30 GMT</pubDate>
      </item>`)
    const [item] = parseRss(xml, 'IT之家', 0)
    expect(item.title).toBe('冥王星发现液体证据')
    expect(item.link).toBe('https://www.ithome.com/0/986/510.htm')
    expect(item.id).toBe(item.link)
    expect(item.source).toBe('IT之家')
    expect(item.pubTs).toBe(Date.parse('Thu, 06 Aug 2026 07:00:30 GMT'))
    expect(item.excerpt).toBe('IT之家 8 月 6 日消息')
  })

  it('支持 CDATA 包裹（少数派风格）', () => {
    const xml = rss(`
      <item>
        <title><![CDATA[派早报：今日要闻]]></title>
        <description><![CDATA[<p>正文<b>加粗</b></p>]]></description>
        <link><![CDATA[https://sspai.com/post/1]]></link>
        <pubDate>Thu, 06 Aug 2026 01:00:00 GMT</pubDate>
      </item>`)
    const [item] = parseRss(xml, '少数派', 0)
    expect(item.title).toBe('派早报：今日要闻')
    expect(item.excerpt).toBe('正文 加粗')
  })

  it('缺 title 或 link 的条目被跳过', () => {
    const xml = rss(`
      <item><title>没有链接</title><description>d</description></item>
      <item><link>https://a.com/1</link><description>没有标题</description></item>
      <item><title>完整</title><link>https://a.com/2</link></item>`)
    const items = parseRss(xml, 's', 0)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('完整')
  })

  it('pubDate 缺失或非法时回落到传入的 now', () => {
    const xml = rss(`
      <item><title>a</title><link>https://a.com/1</link><pubDate>不是日期</pubDate></item>`)
    expect(parseRss(xml, 's', 12345)[0].pubTs).toBe(12345)
  })

  it('单源条数受上限约束', () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `<item><title>t${i}</title><link>https://a.com/${i}</link></item>`,
    ).join('')
    expect(parseRss(rss(many), 's', 0).length).toBeLessThanOrEqual(12)
  })

  it('&amp; 只解一次，不会把 &amp;lt; 误解成标签', () => {
    expect(decodeEntities('a &amp;lt; b')).toBe('a &lt; b')
    expect(decodeEntities('&lt;b&gt;')).toBe('<b>')
    expect(decodeEntities('&#65;&#66;')).toBe('AB')
  })

  it('stripTags 压缩空白', () => {
    expect(stripTags('<p>  a  </p>\n<p>b</p>')).toBe('a b')
  })
})
