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
  it('按 mediaType 返回手绘笔记色', () => {
    expect(wikiMediaTypeIconColor('document')).toMatch(/^#/)
    expect(wikiMediaTypeIconColor('image')).toMatch(/^#/)
    expect(wikiMediaTypeIconColor('audio')).toMatch(/^#/)
    expect(wikiMediaTypeIconColor('video')).toMatch(/^#/)
    expect(wikiMediaTypeIconColor('document')).not.toBe(wikiMediaTypeIconColor('image'))
  })

  it('按后缀细分徽章色，同大类可区分', () => {
    expect(wikiFileExtBadgeColor('md')).toMatch(/^#/)
    expect(wikiFileExtBadgeColor('pdf')).toMatch(/^#/)
    expect(wikiFileExtBadgeColor('md')).not.toBe(wikiFileExtBadgeColor('pdf'))
    expect(wikiFileExtBadgeColor('png')).not.toBe(wikiFileExtBadgeColor('mp4'))
  })
})
