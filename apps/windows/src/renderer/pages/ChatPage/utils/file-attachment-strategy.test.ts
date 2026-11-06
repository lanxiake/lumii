import { describe, expect, it } from 'vitest'
import {
  getDisplayMessagePreview,
  mergeEditedUserMessage,
  parseMediaAttachedLine,
  parseMediaAttachments,
  processFilesWithStrategies,
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

describe('processFilesWithStrategies：本地路径来源', () => {
  // 不需要真 DataTransfer：被测代码只用到 length / 下标访问
  const fileList = (files: File[]): FileList =>
    Object.assign([...files], { item: (i: number) => files[i] ?? null }) as unknown as FileList

  // 回归：Electron 32 起 `File.path` 被移除（本机 36 实测 undefined）。
  // 旧实现用 `file.name` 兜底，主进程收到的是个不存在的「路径」，拖入必失败；
  // 现在必须回落到 webUtils，拿不到就返回空串让调用方去读字节。
  it('webUtils 可用时取真实路径', () => {
    const api = { getPathForFile: (f: File) => 'C:/real/' + f.name }
    ;(globalThis as { window?: unknown }).window = { electronAPI: { app: api } }
    const [att] = processFilesWithStrategies(fileList([new File(['x'], 'a.txt')]))
    expect(att?.filePath).toBe('C:/real/a.txt')
    delete (globalThis as { window?: unknown }).window
  })

  it('拿不到路径时返回空串，而不是拿文件名冒充路径', () => {
    ;(globalThis as { window?: unknown }).window = { electronAPI: { app: {} } }
    const [att] = processFilesWithStrategies(fileList([new File(['x'], 'a.txt')]))
    expect(att?.filePath).toBe('')
    delete (globalThis as { window?: unknown }).window
  })

  it('非 Electron 环境（无 window）同样返回空串且不抛错', () => {
    const [att] = processFilesWithStrategies(fileList([new File(['x'], 'a.txt')]))
    expect(att?.filePath).toBe('')
  })
})
