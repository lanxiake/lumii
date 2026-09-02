/**
 * cron-wiki-persist：Markdown 组装与文件名规则单测。
 */
import { describe, expect, it } from 'vitest'
import {
  __testables,
  CRON_WIKI_PERSIST_JOB_IDS,
  shouldPersistCronOutputToWiki,
} from './cron-wiki-persist'

const {
  buildCronWikiFileStem,
  buildCronWikiTitle,
  formatNewsFeedMarkdown,
  stripMarkdownForIndex,
  PERSIST_SPECS,
} = __testables

describe('shouldPersistCronOutputToWiki', () => {
  it('仅四类预置任务需要持久化', () => {
    expect(CRON_WIKI_PERSIST_JOB_IDS.size).toBe(4)
    expect(shouldPersistCronOutputToWiki('news-pipeline')).toBe(true)
    expect(shouldPersistCronOutputToWiki('seed-morning-briefing')).toBe(true)
    expect(shouldPersistCronOutputToWiki('seed-daily-report')).toBe(true)
    expect(shouldPersistCronOutputToWiki('seed-weekly-review')).toBe(true)
    expect(shouldPersistCronOutputToWiki('wiki-ero-extract')).toBe(false)
    expect(shouldPersistCronOutputToWiki('seed-focus-check')).toBe(false)
  })
})

describe('buildCronWikiFileStem', () => {
  const at = new Date(2026, 8, 2, 14, 30)

  it('资讯按日期+小时', () => {
    expect(buildCronWikiFileStem('news-pipeline', at)).toBe('2026-09-02-14')
  })

  it('日报类按日期', () => {
    expect(buildCronWikiFileStem('seed-daily-report', at)).toBe('2026-09-02')
  })

  it('周报按 ISO 周次', () => {
    // 2026-09-02 是周三，属 2026 年第 36 周
    expect(buildCronWikiFileStem('seed-weekly-review', at)).toBe('2026-W36')
  })
})

describe('formatNewsFeedMarkdown', () => {
  const spec = PERSIST_SPECS['news-pipeline']
  const finishedAt = new Date(2026, 8, 2, 10, 0)

  it('空 feed 返回 null', () => {
    expect(formatNewsFeedMarkdown(null, finishedAt, spec)).toBeNull()
    expect(formatNewsFeedMarkdown({ feedId: 'news', title: '最近资讯', updatedAt: 1, items: [] }, finishedAt, spec)).toBeNull()
  })

  it('含综述与条目', () => {
    const md = formatNewsFeedMarkdown(
      {
        feedId: 'news',
        title: '最近资讯',
        updatedAt: 1,
        summary: 'AI 领域两条主线。',
        items: [
          { id: '1', title: '头条', summary: '摘要正文', source: 'IT之家', href: 'https://example.com/a' },
        ],
      },
      finishedAt,
      spec,
    )
    expect(md).toContain('# 最近资讯')
    expect(md).toContain('## 综述')
    expect(md).toContain('AI 领域两条主线')
    expect(md).toContain('### 头条')
    expect(md).toContain('[原文](https://example.com/a)')
  })
})

describe('stripMarkdownForIndex', () => {
  it('去掉标题与链接语法', () => {
    const text = stripMarkdownForIndex('# 标题\n\n见 [链接](https://x.com)')
    expect(text).toContain('标题')
    expect(text).toContain('链接')
    expect(text).not.toContain('#')
    expect(text).not.toContain('](https')
  })
})

describe('buildCronWikiTitle', () => {
  it('标题含日期前缀', () => {
    const at = new Date(2026, 8, 2, 8, 30)
    expect(buildCronWikiTitle('早间简报', 'seed-morning-briefing', at)).toBe('2026-09-02 早间简报')
  })
})
