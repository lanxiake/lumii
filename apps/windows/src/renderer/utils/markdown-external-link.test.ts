/**
 * markdown-external-link 工具单测
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { isHttpUrl, openExternalUrl } from './markdown-external-link'

describe('isHttpUrl', () => {
  it('识别 http(s) 链接', () => {
    expect(isHttpUrl('https://www.ithome.com/0/995/869.htm')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
    expect(isHttpUrl('mailto:a@b.com')).toBe(false)
    expect(isHttpUrl('/relative/path')).toBe(false)
  })
})

describe('openExternalUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      electronAPI: {
        app: { openExternal: vi.fn() },
      },
    })
  })

  it('http(s) 调用 openExternal', () => {
    openExternalUrl('https://example.com/article')
    expect(window.electronAPI.app.openExternal).toHaveBeenCalledWith('https://example.com/article')
  })

  it('非 http(s) 不调用', () => {
    openExternalUrl('file:///tmp/a.md')
    expect(window.electronAPI.app.openExternal).not.toHaveBeenCalled()
  })
})
