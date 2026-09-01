import { describe, expect, it } from 'vitest'
import { originalFileExtension, titleWithOriginalExt } from './wiki-display-title'

describe('titleWithOriginalExt', () => {
  it('给无后缀标题补上原文件扩展名', () => {
    expect(titleWithOriginalExt('一年级语文下册', 'C:/教材/一年级语文下册.pdf')).toBe('一年级语文下册.pdf')
  })

  it('标题已有相同后缀时不重复', () => {
    expect(titleWithOriginalExt('纪要.docx', 'wiki/工作/例行/纪要.docx')).toBe('纪要.docx')
  })

  it('忽略 .lumii-ref 侧车后缀，改用原文件路径', () => {
    expect(originalFileExtension('wiki/收件箱/资料.lumii-ref')).toBeNull()
    expect(titleWithOriginalExt('资料', 'D:/files/合同.pdf')).toBe('资料.pdf')
  })

  it('网页链接不追加后缀', () => {
    expect(titleWithOriginalExt('文章', 'https://example.com/a')).toBe('文章')
  })
})
