/**
 * Wiki 文件列表：后缀解析与手绘笔记风格色
 */
import { describe, expect, it } from 'vitest'
import {
  formatWikiExtBadgeLabel,
  resolveWikiFileExt,
  shouldShowWikiExtBadge,
  wikiFileExtBadgeColor,
  wikiMediaTypeIconColor,
} from '../../renderer/pages/MemoriesPage/components/wikiFileExtDisplay'

describe('resolveWikiFileExt', () => {
  it('优先从 sourcePath 取后缀', () => {
    expect(resolveWikiFileExt('wiki/notes/计划.md', '计划')).toBe('md')
    expect(resolveWikiFileExt('C:\\files\\报告.PDF', '报告')).toBe('pdf')
  })

  it('无 path 时回退 title', () => {
    expect(resolveWikiFileExt(null, '录音.m4a')).toBe('m4a')
    expect(resolveWikiFileExt('', '截图.PNG')).toBe('png')
  })

  it('无后缀或隐藏文件返回 null', () => {
    expect(resolveWikiFileExt(null, 'readme')).toBeNull()
    expect(resolveWikiFileExt('.gitignore', '.gitignore')).toBeNull()
    expect(resolveWikiFileExt(null, '')).toBeNull()
  })

  it('.lumii-ref 侧车不当作后缀，剥掉后无后缀则回退 title 的真实后缀', () => {
    expect(resolveWikiFileExt('wiki/收藏/可复用/拍照姿势21.lumii-ref', '拍照姿势21.mp4')).toBe('mp4')
    // url ref 剥掉 .url.lumii-ref 后无真实文件后缀，回退 title 也无后缀 → null
    expect(resolveWikiFileExt('wiki/收藏/链接示例.url.lumii-ref', '链接示例')).toBeNull()
  })
})

describe('shouldShowWikiExtBadge', () => {
  it('标题已含后缀时不显示徽章', () => {
    expect(shouldShowWikiExtBadge('会议纪要.docx', 'docx')).toBe(false)
    expect(shouldShowWikiExtBadge('报告.PDF', 'pdf')).toBe(false)
  })

  it('标题不含后缀时显示徽章', () => {
    expect(shouldShowWikiExtBadge('会议纪要', 'docx')).toBe(true)
    expect(shouldShowWikiExtBadge('计划', 'md')).toBe(true)
  })

  it('无后缀时不显示', () => {
    expect(shouldShowWikiExtBadge('无后缀', null)).toBe(false)
  })
})

describe('formatWikiExtBadgeLabel', () => {
  it('大写展示', () => {
    expect(formatWikiExtBadgeLabel('md')).toBe('MD')
    expect(formatWikiExtBadgeLabel('Pdf')).toBe('PDF')
  })
})

describe('wikiMediaTypeIconColor / wikiFileExtBadgeColor', () => {
  // 色值走 --mt-file-* 令牌（定义在 design-system.css 三个主题块），
  // 消费点是 DOM 内联 style，CSS 变量天然可用。改动前是字面 hex。
  const isToken = (v: string) => expect(v).toMatch(/^var\(--mt-file-[\w-]+\)$/)

  it('按 mediaType 返回手绘笔记色', () => {
    for (const t of ['document', 'image', 'audio', 'video']) isToken(wikiMediaTypeIconColor(t))
    expect(wikiMediaTypeIconColor('document')).not.toBe(wikiMediaTypeIconColor('image'))
  })

  it('按后缀细分徽章色，同大类可区分', () => {
    isToken(wikiFileExtBadgeColor('md'))
    isToken(wikiFileExtBadgeColor('pdf'))
    expect(wikiFileExtBadgeColor('md')).not.toBe(wikiFileExtBadgeColor('pdf'))
    expect(wikiFileExtBadgeColor('png')).not.toBe(wikiFileExtBadgeColor('mp4'))
  })

  it('未知 mediaType / 后缀回退到同一个兜底色', () => {
    const fallback = wikiFileExtBadgeColor('不存在的后缀')
    isToken(fallback)
    expect(wikiMediaTypeIconColor('unknown-media-type')).toBe(fallback)
  })
})
