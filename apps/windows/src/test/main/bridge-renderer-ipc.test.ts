/**
 * BridgeRendererIpcChannel：渲染进程可达性判定 + 离线队列边界
 *
 * 背景（2026-09-15 主窗口渲染进程 OOM 崩溃现场）：
 * 渲染进程崩溃后 BrowserWindow/webContents 对象仍然存活，只是 frame 已被 dispose。
 * 此时 `webContents.send` 会在 Electron 内部抛错，并被 Electron 自己
 * `console.error('Error sending from webFrameMain: ...')` 吞掉——调用方的 try/catch
 * 根本看不到，只能眼睁睁看着日志被刷屏。所以必须在这里提前判掉，
 * 顺带把「只写不读」的离线队列加上上限。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BridgeRendererIpcChannel } from '../../main/agent-runtime/bridge-renderer-ipc'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  globalShortcut: { register: vi.fn(), unregister: vi.fn() },
  app: { getPath: vi.fn(() => '') },
  BrowserWindow: class {},
}))

interface FakeWebContents {
  isDestroyed: () => boolean
  isCrashed: () => boolean
  send: ReturnType<typeof vi.fn>
}

interface FakeWindow {
  isDestroyed: () => boolean
  webContents: FakeWebContents
}

function makeWindow(overrides: Partial<FakeWebContents> = {}): FakeWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
      ...overrides,
    },
  }
}

/** 事件载荷在可达性判定里只用于日志，形状无关紧要 */
const event = { type: 'agent:idle', sessionKey: 's1' } as never

/** 队列是私有字段，测试直接穿透读取（TS private 仅编译期可见） */
function queueOf(channel: BridgeRendererIpcChannel): unknown[] {
  return (channel as unknown as { ipcMessageQueue: unknown[] }).ipcMessageQueue
}

describe('canReachRenderer', () => {
  it('正常窗口可达', () => {
    const channel = new BridgeRendererIpcChannel(() => makeWindow() as never)
    expect(channel.canReachRenderer()).toBe(true)
  })

  it('窗口为 null 时不可达', () => {
    const channel = new BridgeRendererIpcChannel(() => null)
    expect(channel.canReachRenderer()).toBe(false)
  })

  it('窗口已销毁时不可达', () => {
    const win = makeWindow()
    win.isDestroyed = () => true
    const channel = new BridgeRendererIpcChannel(() => win as never)
    expect(channel.canReachRenderer()).toBe(false)
  })

  it('渲染进程已崩溃时不可达（webContents 对象还在，但 frame 已 dispose）', () => {
    const channel = new BridgeRendererIpcChannel(() =>
      makeWindow({ isCrashed: () => true }) as never,
    )
    expect(channel.canReachRenderer()).toBe(false)
  })
})

describe('forwardIpcEvent', () => {
  let win: FakeWindow
  let channel: BridgeRendererIpcChannel

  beforeEach(() => {
    win = makeWindow()
    channel = new BridgeRendererIpcChannel(() => win as never)
  })

  it('可达时直发且不入队', () => {
    expect(channel.forwardIpcEvent(event)).toBe(true)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(queueOf(channel)).toHaveLength(0)
  })

  it('渲染进程崩溃后不再调用 send，事件转入离线队列', () => {
    win.webContents.isCrashed = () => true
    expect(channel.forwardIpcEvent(event)).toBe(false)
    expect(win.webContents.send).not.toHaveBeenCalled()
    expect(queueOf(channel)).toHaveLength(1)
  })

  it('离线队列有上限：超限丢弃最旧的一条，不会无限增长', () => {
    win.webContents.isCrashed = () => true
    for (let i = 0; i < 600; i++) {
      channel.forwardIpcEvent({ type: 'agent:idle', sessionKey: `s${i}` } as never)
    }
    const queue = queueOf(channel) as { event: { sessionKey: string } }[]
    expect(queue).toHaveLength(500)
    // 最旧的 100 条被丢弃，队首是第 101 条
    expect(queue[0]!.event.sessionKey).toBe('s100')
  })
})

describe('clearIpcQueue', () => {
  it('清空离线队列', () => {
    const win = makeWindow({ isCrashed: () => true })
    const channel = new BridgeRendererIpcChannel(() => win as never)
    channel.forwardIpcEvent(event)
    channel.forwardIpcEvent(event)
    expect(queueOf(channel)).toHaveLength(2)

    channel.clearIpcQueue()
    expect(queueOf(channel)).toHaveLength(0)
  })

  it('队列为空时是空操作', () => {
    const channel = new BridgeRendererIpcChannel(() => makeWindow() as never)
    expect(() => channel.clearIpcQueue()).not.toThrow()
    expect(queueOf(channel)).toHaveLength(0)
  })
})
