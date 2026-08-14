import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NativeImage } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SNAPSHOT_SCRIPT } from './snapshot'
import { createAppUiController, VIEW_STATE_SCRIPT } from './controller'
import { clearScreenshotTempDir, getScreenshotTempDir } from './screenshot-cleanup'
import type { RawSnapshotNode } from './types'

vi.mock('../pet/pet-mode-ipc', () => ({
  getPetWindowManager: vi.fn(() => null),
}))

vi.mock('./annotate', () => ({
  annotateSnapshot: vi.fn(async (buf: Buffer) => Buffer.from(`${buf.toString()}-annotated`)),
}))

import { getPetWindowManager } from '../pet/pet-mode-ipc'
import { annotateSnapshot } from './annotate'

const mockedGetPetWindowManager = vi.mocked(getPetWindowManager)
const mockedAnnotateSnapshot = vi.mocked(annotateSnapshot)

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
  send?: ReturnType<typeof vi.fn>
  sendInputEvent?: ReturnType<typeof vi.fn>
}) {
  const send = options.send ?? vi.fn()
  const sendInputEvent = options.sendInputEvent ?? vi.fn()

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
        if (script.includes('elementFromPoint')) {
          if (script.includes('scrollBy')) return true
          if (script.includes('setNativeValue')) return true
          return { x: 10, y: 20, w: 100, h: 40 }
        }
        return [] as RawSnapshotNode[]
      }),
    send,
    sendInputEvent,
  }

  return {
    isDestroyed: () => options.destroyed ?? false,
    isVisible: () => options.visible ?? true,
    webContents,
    send,
    sendInputEvent,
  }
}

describe('createAppUiController', () => {
  let tmpDataRoot: string

  beforeEach(() => {
    tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-screenshot-'))
    clearScreenshotTempDir(tmpDataRoot)
    mockedGetPetWindowManager.mockReturnValue(null)
    mockedAnnotateSnapshot.mockClear()
  })

  afterEach(() => {
    fs.rmSync(tmpDataRoot, { recursive: true, force: true })
  })

  /** 构造带 fake 依赖的控制器 */
  function makeController(
    getWindow: (target?: 'main' | 'pet' | 'preview') => ReturnType<typeof fakeWindow> | null,
    overrides: {
      resizeImageIfNeeded?: ReturnType<typeof vi.fn>
      deps?: Partial<Parameters<typeof createAppUiController>[0]>
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
        getWindow: ((target: 'main' | 'pet' | 'preview') =>
          getWindow(target)) as never,
        resizeImageIfNeeded,
        resolveDataRoot: () => tmpDataRoot,
        gotoSettleMs: 0,
        ...overrides.deps,
      }),
      resizeImageIfNeeded,
    }
  }

  it('无主窗时返回 app_not_running', async () => {
    const { controller } = makeController(() => null)
    const result = await controller.screenshot()
    expect(result).toEqual({ ok: false, error: 'app_not_running' })
  })

  it('target=preview 返回 usage', async () => {
    const { controller } = makeController(() => fakeWindow({}))
    const result = await controller.screenshot({ target: 'preview' })
    expect(result).toEqual({ ok: false, error: 'usage' })
  })

  it('target=pet 且桌宠未运行返回 pet_not_running', async () => {
    mockedGetPetWindowManager.mockReturnValue(null)
    const { controller } = makeController(() => fakeWindow({}))
    const result = await controller.screenshot({ target: 'pet' })
    expect(result).toEqual({ ok: false, error: 'pet_not_running' })
  })

  it('target=pet 且桌宠窗口可用时成功截图', async () => {
    const petWin = fakeWindow({ visible: true })
    mockedGetPetWindowManager.mockReturnValue({
      getPetBrowserWindow: () => petWin,
    } as never)

    const { controller } = makeController(() => fakeWindow({}))
    const result = await controller.screenshot({ target: 'pet' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshotId).toBe('1')
  })

  it('annotate=true 时调用 annotateSnapshot 并写入标注图', async () => {
    const rawNodes: RawSnapshotNode[] = [
      { role: 'button', name: '发送', x: 10, y: 20, w: 80, h: 32 },
    ]
    const win = fakeWindow({
      executeJavaScript: async (script) => {
        if (script === SNAPSHOT_SCRIPT) return rawNodes
        if (script.includes('__LUMII_APP_UI_STATE__')) {
          return JSON.stringify({
            view: 'chat',
            hub: { open: false, tab: null, category: null },
          })
        }
        return null
      },
    })

    const { controller } = makeController(() => win)
    const result = await controller.screenshot({ annotate: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(mockedAnnotateSnapshot).toHaveBeenCalledTimes(1)
    expect(result.imageBase64).toBe(
      Buffer.from('fake-jpeg-1920x1080-annotated').toString('base64'),
    )
    const written = fs.readFileSync(result.previewPath)
    expect(written.equals(Buffer.from('fake-jpeg-1920x1080-annotated'))).toBe(true)
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

  it('goto 非法入参返回 usage', async () => {
    const { controller } = makeController(() => fakeWindow({}))
    const result = await controller.goto({ view: 'invalid' })
    expect(result).toEqual({ ok: false, error: 'usage' })
  })

  it('goto 无主窗返回 app_not_running', async () => {
    const { controller } = makeController(() => null)
    const result = await controller.goto({ view: 'chat' })
    expect(result).toEqual({ ok: false, error: 'app_not_running' })
  })

  it('goto 发送 app-ui:goto 并回读 view/hub', async () => {
    const send = vi.fn()
    const executeJavaScript = vi.fn(async (script: string) => {
      if (script === VIEW_STATE_SCRIPT) {
        return JSON.stringify({
          view: 'skills',
          hub: { open: true, tab: 'skills', category: 'general' },
        })
      }
      return null
    })
    const win = fakeWindow({ send, executeJavaScript })
    const { controller } = makeController(() => win)

    const result = await controller.goto({ view: 'skills' })

    expect(send).toHaveBeenCalledWith('app-ui:goto', { view: 'skills' })
    expect(result).toEqual({
      ok: true,
      view: 'skills',
      hub: { open: true, tab: 'skills', category: 'general' },
    })
  })

  it('goto 无回读函数时 view 为 null', async () => {
    const executeJavaScript = vi.fn(async (script: string) => {
      if (script === VIEW_STATE_SCRIPT) return null
      return null
    })
    const { controller } = makeController(() => fakeWindow({ executeJavaScript }))

    const result = await controller.goto({ view: 'chat' })
    expect(result).toEqual({
      ok: true,
      view: null,
      hub: { open: false, tab: null, category: null },
    })
  })

  it('click 缺 ref 返回 missing_ref', async () => {
    const { controller } = makeController(() => fakeWindow({}))
    const result = await controller.click({ action: 'click' })
    expect(result).toEqual({ ok: false, error: 'missing_ref' })
  })

  it('click 快照过期返回 stale_snapshot', async () => {
    const { controller } = makeController(() => fakeWindow({}))
    const result = await controller.click({
      action: 'click',
      ref: 'e1',
      snapshotId: 'missing',
    })
    expect(result).toEqual({ ok: false, error: 'stale_snapshot' })
  })

  it('click composer 禁点返回 blocked_composer', async () => {
    const win = fakeWindow({})
    const { controller } = makeController(() => win)
    await controller.screenshot()

    const cache = controller.getSnapshotCache('1')
    expect(cache).toBeDefined()
    if (!cache) return

    cache.refs.push({
      ref: 'e2',
      role: 'composer',
      name: '输入框',
      x: 0,
      y: 0,
      w: 100,
      h: 40,
    })

    const result = await controller.click({
      action: 'click',
      ref: 'e2',
      snapshotId: '1',
    })
    expect(result).toEqual({ ok: false, error: 'blocked_composer' })
  })

  it('click 成功发送 mousedown/mouseup', async () => {
    const rawNodes: RawSnapshotNode[] = [
      { role: 'button', name: '设置', x: 10, y: 20, w: 100, h: 40 },
    ]
    const sendInputEvent = vi.fn()
    const win = fakeWindow({
      sendInputEvent,
      executeJavaScript: async (script: string) => {
        if (script === SNAPSHOT_SCRIPT) return rawNodes
        if (script.includes('__LUMII_APP_UI_STATE__')) {
          return JSON.stringify({
            view: 'chat',
            hub: { open: false, tab: null, category: null },
          })
        }
        if (script.includes('elementFromPoint')) {
          return { x: 10, y: 20, w: 100, h: 40 }
        }
        return null
      },
    })
    const { controller } = makeController(() => win, {
      deps: { getScaleFactor: () => 2 },
    })

    await controller.screenshot()
    const result = await controller.click({
      action: 'click',
      ref: 'e1',
      snapshotId: '1',
    })

    expect(result).toEqual({ ok: true })
    expect(sendInputEvent).toHaveBeenCalledTimes(2)
    expect(sendInputEvent).toHaveBeenNthCalledWith(1, {
      type: 'mouseDown',
      x: 30,
      y: 20,
      button: 'left',
      clickCount: 1,
    })
    expect(sendInputEvent).toHaveBeenNthCalledWith(2, {
      type: 'mouseUp',
      x: 30,
      y: 20,
      button: 'left',
      clickCount: 1,
    })
  })

  it('type 成功注入 native setter 脚本', async () => {
    const rawNodes: RawSnapshotNode[] = [
      { role: 'input', name: '搜索', x: 10, y: 20, w: 100, h: 40 },
    ]
    const executeJavaScript = vi.fn(async (script: string) => {
      if (script === SNAPSHOT_SCRIPT) return rawNodes
      if (script.includes('__LUMII_APP_UI_STATE__')) {
        return JSON.stringify({
          view: 'chat',
          hub: { open: false, tab: null, category: null },
        })
      }
      if (script.includes('setNativeValue')) return true
      return null
    })
    const { controller } = makeController(() => fakeWindow({ executeJavaScript }))

    await controller.screenshot()
    const result = await controller.type({
      action: 'type',
      ref: 'e1',
      text: '你好🎉',
      snapshotId: '1',
    })

    expect(result).toEqual({ ok: true })
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('getOwnPropertyDescriptor'),
    )
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('你好🎉'))
  })

  it('type 目标丢失返回 click_target_lost', async () => {
    const rawNodes: RawSnapshotNode[] = [
      { role: 'input', name: '搜索', x: 10, y: 20, w: 100, h: 40 },
    ]
    const { controller } = makeController(() =>
      fakeWindow({
        executeJavaScript: async (script: string) => {
          if (script === SNAPSHOT_SCRIPT) return rawNodes
          if (script.includes('__LUMII_APP_UI_STATE__')) {
            return JSON.stringify({
              view: 'chat',
              hub: { open: false, tab: null, category: null },
            })
          }
          if (script.includes('setNativeValue')) return null
          return null
        },
      }),
    )
    await controller.screenshot()
    const result = await controller.type({
      action: 'type',
      ref: 'e1',
      text: 'x',
      snapshotId: '1',
    })
    expect(result).toEqual({ ok: false, error: 'click_target_lost' })
  })

  it('key 白名单外返回 usage', async () => {
    const { controller } = makeController(() => fakeWindow({}))
    const result = await controller.key({ action: 'key', key: 'a' })
    expect(result).toEqual({ ok: false, error: 'usage' })
  })

  it('key 成功发送 keyDown/keyUp', async () => {
    const sendInputEvent = vi.fn()
    const { controller } = makeController(() => fakeWindow({ sendInputEvent }))

    const result = await controller.key({ action: 'key', key: 'Enter' })

    expect(result).toEqual({ ok: true })
    expect(sendInputEvent).toHaveBeenCalledTimes(2)
    expect(sendInputEvent).toHaveBeenNthCalledWith(1, { type: 'keyDown', keyCode: 'Enter' })
    expect(sendInputEvent).toHaveBeenNthCalledWith(2, { type: 'keyUp', keyCode: 'Enter' })
  })

  it('scroll 成功注入 scrollBy 脚本', async () => {
    const rawNodes: RawSnapshotNode[] = [
      { role: 'list', name: '列表', x: 0, y: 0, w: 200, h: 300 },
    ]
    const executeJavaScript = vi.fn(async (script: string) => {
      if (script === SNAPSHOT_SCRIPT) return rawNodes
      if (script.includes('__LUMII_APP_UI_STATE__')) {
        return JSON.stringify({
          view: 'chat',
          hub: { open: false, tab: null, category: null },
        })
      }
      if (script.includes('scrollBy')) return true
      return null
    })
    const { controller } = makeController(() => fakeWindow({ executeJavaScript }))

    await controller.screenshot()
    const result = await controller.scroll({
      action: 'scroll',
      ref: 'e1',
      dx: 0,
      dy: 120,
      snapshotId: '1',
    })

    expect(result).toEqual({ ok: true })
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('scrollBy(0, 120)'))
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
