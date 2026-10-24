/**
 * 媒体预览共用工具单元测试。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isExternalImageSrc, loadLocalImageDataUrl } from './mediaPreview'

describe('mediaPreview', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('识别外部与 data URL', () => {
    expect(isExternalImageSrc('https://a.test/x.png')).toBe(true)
    expect(isExternalImageSrc('data:image/png;base64,aa')).toBe(true)
    expect(isExternalImageSrc('outputs/a.png')).toBe(false)
  })

  it('IPC 读本地图为 data URL', async () => {
    const sendCommand = vi.fn().mockResolvedValue({
      content: 'abc',
      mimeType: 'image/png',
      encoding: 'base64',
    })
    vi.stubGlobal('electronAPI', { agentRuntime: { sendCommand } })
    // window.electronAPI 在实现里读的是 window 上的属性
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { agentRuntime: { sendCommand } },
    })

    await expect(loadLocalImageDataUrl('outputs/a.png')).resolves.toBe(
      'data:image/png;base64,abc',
    )
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'files:read-preview-by-path', filePath: 'outputs/a.png' }),
    )
  })
})
