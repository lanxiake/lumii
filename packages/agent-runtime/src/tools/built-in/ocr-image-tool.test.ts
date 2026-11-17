/**
 * ocr_image 工具契约：schema 与「默认 stub 必须明说不可用」。
 * 真正的 OCR 在 Electron bridge 里覆盖实现，这里只守包内导出的部分。
 */
import { describe, expect, it } from 'vitest'
import { OCR_IMAGE_TOOL_NAME, ocrImageToolConfig } from './ocr-image-tool'

describe('ocr_image 工具', () => {
  it('工具名与只读属性（不写盘，不需要审批）', () => {
    expect(ocrImageToolConfig.name).toBe('ocr_image')
    expect(OCR_IMAGE_TOOL_NAME).toBe('ocr_image')
    expect(ocrImageToolConfig.isReadOnly).toBe(true)
    expect(ocrImageToolConfig.needsPermission).toBe(false)
  })

  it('描述里明确说了「坐标」这件事，否则模型不知道该用它', () => {
    expect(ocrImageToolConfig.description).toContain('坐标')
    expect(ocrImageToolConfig.description).toContain('left, top, width, height')
  })

  it('未注入实现时返回 not_implemented，而不是假装成功', async () => {
    const result = await ocrImageToolConfig.execute('call-1', { imagePath: 'a.png' })
    const text = result.content.map((c) => c.text).join('')
    expect(text).toContain('not_implemented')
  })
})
