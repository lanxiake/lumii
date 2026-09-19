/**
 * browser-media-store 单元测试
 *
 * 背景：`/screenshot` 曾因宿主未提供 media store 而恒定失败（"media store not available"）。
 * 这里锁死文件名生成的三条判据（前缀防穿越 / MIME 扩展名 / 同毫秒不重名），
 * 并真实落盘一次，验证写入的是工作区 `temp/screenshots`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { buildBrowserMediaFileName, createBrowserMediaStore, sanitizeMediaPrefix } from './browser-media-store'
import { _resetActiveWorkspaceDirGetterForTest, setActiveWorkspaceDirGetter } from './workspace-paths'

describe('sanitizeMediaPrefix', () => {
  it('保留字母数字与连字符', () => {
    expect(sanitizeMediaPrefix('browser-1')).toBe('browser-1')
  })

  it('剔除路径分隔符与点，防穿越', () => {
    expect(sanitizeMediaPrefix('../..\\evil')).toBe('evil')
  })

  it('全部非法字符时回退 browser', () => {
    expect(sanitizeMediaPrefix('中文/路径')).toBe('browser')
    expect(sanitizeMediaPrefix('')).toBe('browser')
  })
})

describe('buildBrowserMediaFileName', () => {
  it('按 MIME 给出扩展名', () => {
    expect(buildBrowserMediaFileName('browser', 'image/png', 1758345600000, 1)).toBe(
      'browser-1758345600000-1.png',
    )
    expect(buildBrowserMediaFileName('browser', 'image/jpeg', 1758345600000, 2)).toBe(
      'browser-1758345600000-2.jpg',
    )
    expect(buildBrowserMediaFileName('browser', 'application/pdf', 1758345600000, 3)).toBe(
      'browser-1758345600000-3.pdf',
    )
  })

  it('未知 MIME 回退 .bin', () => {
    expect(buildBrowserMediaFileName('browser', 'application/octet-stream', 1, 1)).toBe(
      'browser-1-1.bin',
    )
  })

  it('同毫秒靠序号区分', () => {
    const a = buildBrowserMediaFileName('browser', 'image/png', 100, 1)
    const b = buildBrowserMediaFileName('browser', 'image/png', 100, 2)
    expect(a).not.toBe(b)
  })
})

describe('createBrowserMediaStore', () => {
  afterEach(() => {
    _resetActiveWorkspaceDirGetterForTest()
  })

  it('写入工作区 temp/screenshots，并自动建目录', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-browser-media-'))
    setActiveWorkspaceDirGetter(() => workspaceRoot)

    const store = createBrowserMediaStore()
    await store.ensureMediaDir()
    const payload = Buffer.from('fake-png-bytes')
    const saved = await store.saveMediaBuffer(payload, 'image/png', 'browser', payload.byteLength)

    const screenshotDir = path.join(workspaceRoot, 'temp', 'screenshots')
    expect(path.dirname(saved.path)).toBe(screenshotDir)
    expect(path.basename(saved.path).startsWith('browser-')).toBe(true)
    expect(path.extname(saved.path)).toBe('.png')
    expect(fs.readFileSync(saved.path)).toEqual(payload)

    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  })
})
