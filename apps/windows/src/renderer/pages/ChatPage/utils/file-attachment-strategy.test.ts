import { describe, expect, it } from 'vitest'
import {
  getDisplayMessagePreview,
  mergeEditedUserMessage,
  parseMediaAttachedLine,
  parseMediaAttachments,
  serializeAttachments,
} from './file-attachment-strategy'

describe('parseMediaAttachedLine', () => {
  it('解析不含括号的文件名', () => {
    const result = parseMediaAttachedLine(
      '[media attached: D:\\ws\\uploads\\同意函_1.pdf (同意函.pdf)]',
    )
    expect(result).toEqual({
      filePath: 'D:\\ws\\uploads\\同意函_1.pdf',
      fileName: '同意函.pdf',
    })
  })

  it('文件名含半角括号时仍能正确拆分 path 与 fileName', () => {
    const result = parseMediaAttachedLine(
      '[media attached: D:\\ws\\uploads\\户口本拼页(1)_123.pdf (证件扫描-户口本拼页(1).pdf)]',
    )
    expect(result).toEqual({
      filePath: 'D:\\ws\\uploads\\户口本拼页(1)_123.pdf',
      fileName: '证件扫描-户口本拼页(1).pdf',
    })
  })

  it('无 fileName 括号时回退为路径 basename', () => {
    const result = parseMediaAttachedLine('[media attached: /tmp/a/b/c.pdf]')
    expect(result).toEqual({
      filePath: '/tmp/a/b/c.pdf',
      fileName: 'c.pdf',
    })
  })
})

describe('parseMediaAttachments', () => {
  it('剥离 parsed text 与 media attached，只保留用户原文与 chips', () => {
    const content = [
      '合并上述两个文档，将其拼接到一个PDF文档中。【PDF_监护人出具未成年人参加演出的同意函】在第一页',
      '[media attached: D:\\ws\\uploads\\同意函_1.pdf (同意函.pdf)]',
      '[media attached: D:\\ws\\uploads\\户口本拼页(1)_2.pdf (证件扫描-户口本拼页(1).pdf)]',
      '[parsed text: uploads/2026-08-07/同意函_1.extracted.txt (from 同意函.pdf)]',
      '[parsed text: uploads/2026-08-07/户口本拼页(1)_2.extracted.txt (from 证件扫描-户口本拼页(1).pdf)]',
    ].join('\n')

    const { textWithoutMedia, mediaFiles } = parseMediaAttachments(content)

    expect(textWithoutMedia).toBe(
      '合并上述两个文档，将其拼接到一个PDF文档中。【PDF_监护人出具未成年人参加演出的同意函】在第一页',
    )
    expect(mediaFiles).toEqual([
      { filePath: 'D:\\ws\\uploads\\同意函_1.pdf', fileName: '同意函.pdf' },
      {
        filePath: 'D:\\ws\\uploads\\户口本拼页(1)_2.pdf',
        fileName: '证件扫描-户口本拼页(1).pdf',
      },
    ])
  })

  it('剥离图片识别块与视觉降级占位行', () => {
    const content = [
      '请看看这张图',
      '[media attached: D:\\ws\\uploads\\a.png (a.png)]',
      '[image recognition: a.png]',
      '描述: 一只猫',
      'OCR: hello',
      '',
      '[图片附件: b.png] 识别失败，请尝试切换到支持视觉的模型',
    ].join('\n')

    const { textWithoutMedia, mediaFiles } = parseMediaAttachments(content)
    expect(textWithoutMedia).toBe('请看看这张图')
    expect(mediaFiles).toEqual([{ filePath: 'D:\\ws\\uploads\\a.png', fileName: 'a.png' }])
  })

  it('getDisplayMessagePreview 截断用户原文', () => {
    const content =
      '这是一段超过三十个字符的用户消息内容用于预览截断测试\n[parsed text: uploads/x.extracted.txt (from x.pdf)]'
    expect(getDisplayMessagePreview(content, 10)).toBe('这是一段超过三十个字...')
  })

  it('编辑可见正文后 merge 回附件与 parsed text 后缀', () => {
    const original = [
      '旧正文',
      '[media attached: D:\\ws\\a.pdf (a.pdf)]',
      '[parsed text: uploads/a.extracted.txt (from a.pdf)]',
    ].join('\n')
    const merged = mergeEditedUserMessage(original, '新正文')
    expect(merged).toBe(
      [
        '新正文',
        '[media attached: D:\\ws\\a.pdf (a.pdf)]',
        '[parsed text: uploads/a.extracted.txt (from a.pdf)]',
      ].join('\n'),
    )
  })

  it('serializeAttachments 与解析往返一致（含括号文件名）', () => {
    const serialized = serializeAttachments([
      {
        fileName: '证件扫描-户口本拼页(1).pdf',
        filePath: 'D:\\ws\\uploads\\户口本拼页(1)_2.pdf',
        mimeType: 'application/pdf',
        size: 1,
        category: 'office',
      },
    ])
    const { mediaFiles } = parseMediaAttachments(serialized)
    expect(mediaFiles[0]).toEqual({
      filePath: 'D:\\ws\\uploads\\户口本拼页(1)_2.pdf',
      fileName: '证件扫描-户口本拼页(1).pdf',
    })
  })
})
