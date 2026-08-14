import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NativeImage } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SNAPSHOT_SCRIPT } from './snapshot'
import { createAppUiController } from './controller'
import { clearScreenshotTempDir, getScreenshotTempDir } from './screenshot-cleanup'
import type { RawSnapshotNode } from './types'

/** 构造 fake NativeImage，供 capturePage mock 使用 */
function fakeNativeImage(width = 1920, height = 1080): NativeImage {
  return {
    toJPEG: () => Buffer.from(`fake-jpeg-${width}x${height}`),
    getSize: () => ({ width, height }),
  } as unknown as NativeImage
}

/** 构造 fake BrowserWindow 最小接口 */
function fakeWindow(options: {
  destroyed?: boolean
  visible?: boolean
  capturePage?: () => Promise<NativeImage>
  executeJavaScript?: (script: string) => Promise<unknown>
}) {
  const webContents = {
    capturePage: options.capturePage ?? (async () => fakeNativeImage()),
    executeJavaScript:
      options.executeJavaScript ??
      (async (script: string) => {
        if (script.includes('__LUMII_APP_UI_STATE__')) {
          return JSON.stringify({
            view: 'chat',
            hub: { open: false, tab: null, category: null },
          })
        }
        return [] as RawSnapshotNode[]
      }),
  }

  return {
    isDestroyed: () => options.destroyed ?? false,
    isVisible: () => options.visible ?? true,
    webContents,
  }
}

describe('createAppUiController', () => {
  let tmpDataRoot: string

  beforeEach(() => {
    tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-screenshot-'))
    clearScreenshotTempDir(tmpDataRoot)
  })

  afterEach(() => {
    fs.rmSync(tmpDataRoot, { recursive: true, force: true })
  })

  /** 构造带 fake 依赖的控制器 */
  function makeController(
    getMainWindow: () => ReturnType<typeof fakeWindow> | null,
    overrides: {
      resizeImageIfNeeded?: ReturnType<typeof vi.fn>
    } = {},
  ) {
    const resizeImageIfNeeded =
      overrides.resizeImageIfNeeded ??
      vi.fn(async (buf: Buffer) => ({
        buffer: buf,
        mimeType: 'image/jpeg',
        wasResized: true,
        originalBytes: buf.byteLength,
        finalBytes: buf.byteLength,
      }))

    return {
      controller: createAppUiController({
        getMainWindow: getMainWindow as never,
        resizeImageIfNeeded,
        resolveDataRoot: () => tmpDataRoot,
      }),
      resizeImageIfNeeded,
    }
  }

  it('无主窗时返回 app_not_running', async () => {
    const { controller } = makeController(() => null)
    const result = await controller.screenshot()
    expect(result).toEqual({ ok: false, error: 'app_not_running' })
  })

  it('主窗已销毁时返回 app_not_running', async () => {
    const { controller } = makeController(() => fakeWindow({ destroyed: true }))
    const result = await controller.screenshot()
    expect(result).toEqual({ ok: false, error: 'app_not_running' })
  })

  it('成功截图返回 base64、refs、viewState 与尺寸', async () => {
    const rawNodes: RawSnapshotNode[] = [
      { role: 'button', name: '发送', x: 10, y: 20, w: 80, h: 32 },
    ]

    const win = fakeWindow({
      executeJavaScript: async (script) => {
        if (script === SNAPSHOT_SCRIPT) return rawNodes
        if (script.includes('__LUMII_APP_UI_STATE__')) {
          return JSON.stringify({
            view: 'chat',
            hub: { open: true, tab: 'settings', category: 'general' },
          })
        }
        return null
      },
    })

    const { controller, resizeImageIfNeeded } = makeController(() => win)
    const result = await controller.screenshot()

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.snapshotId).toBe('1')
    expect(result.imageBase64).toBe(Buffer.from('fake-jpeg-1920x1080').toString('base64'))
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.width).toBe(1280)
    expect(result.height).toBe(720)
    expect(result.viewState).toEqual({
      view: 'chat',
      hub: { open: true, tab: 'settings', category: 'general' },
    })
    expect(result.refs).toEqual([
      { ref: 'e1', role: 'button', name: '发送', x: 10, y: 20, w: 80, h: 32 },
    ])
    expect(result.truncated).toBe(false)
    expect(result.windowVisible).toBe(true)
    expect(result.previewPath).toBe(
      path.join(getScreenshotTempDir(tmpDataRoot), '1.jpg'),
    )
    expect(resizeImageIfNeeded).toHaveBeenCalledWith(
      expect.any(Buffer),
      '.jpg',
      1280,
      expect.any(Number),
    )
  })

  it('将 JPEG 写入临时目录供 ToolCallCard 预览', async () => {
    const { controller } = makeController(() => fakeWindow({}))
    const result = await controller.screenshot()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(fs.existsSync(result.previewPath)).toBe(true)
    const written = fs.readFileSync(result.previewPath)
    expect(written.equals(Buffer.from('fake-jpeg-1920x1080'))).toBe(true)
  })

  it('连续截图递增 snapshotId 并缓存快照', async () => {
    const { controller } = makeController(() => fakeWindow({}))

    const first = await controller.screenshot()
    const second = await controller.screenshot()

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(first.snapshotId).toBe('1')
    expect(second.snapshotId).toBe('2')

    const cached = controller.getSnapshotCache('2')
    expect(cached).toMatchObject({
      snapshotId: '2',
      bounds: { width: 1280, height: 720 },
    })
    expect(cached?.refs.length).toBeGreaterThanOrEqual(0)
    expect(cached?.viewState.view).toBe('chat')
  })

  it('窗口不可见时仍尝试截图并标记 windowVisible=false', async () => {
    const capturePage = vi.fn(async () => fakeNativeImage())
    const { controller } = makeController(() =>
      fakeWindow({ visible: false, capturePage }),
    )

    const result = await controller.screenshot()
    expect(capturePage).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.windowVisible).toBe(false)
  })
})

describe('clearScreenshotTempDir', () => {
  it('清空并重建 screenshots 目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-cleanup-'))
    const dir = getScreenshotTempDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'old.jpg'), 'old')

    clearScreenshotTempDir(root)

    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([])

    fs.rmSync(root, { recursive: true, force: true })
  })
})
