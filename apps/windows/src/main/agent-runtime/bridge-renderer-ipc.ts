/**
 * 渲染进程 IPC：窗口可用时直发，否则入队；flush 时丢弃过期项
 */

import type { BrowserWindow } from 'electron'
import type { AgentRuntimeEvent as IpcEvent } from '../../shared/agent-runtime-events'
import { getPetWindowManager } from '../pet/pet-mode-ipc.js'
import { agentRuntimeLog as log } from './bridge-utils'
import { voiceEventBus } from '../voice/voice-event-bus.js'

type Queued = { event: IpcEvent; timestamp: number }

/**
 * 离线队列上限。队列只在渲染进程不可达期间暂存事件，且 flush 依赖窗口恢复；
 * 没有上限时，渲染进程崩溃后主进程会一直往里堆事件（含完整消息正文）而不释放，
 * 变成一条只写不读的泄漏路径。超限丢弃最旧的一条，UI 侧本就以 DB 为准。
 */
const MAX_QUEUED_IPC_EVENTS = 500

/**
 * 封装主窗口 webContents.send 与离线消息队列
 */
export class BridgeRendererIpcChannel {
  private ipcMessageQueue: Queued[] = []

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /**
   * 判断主窗口渲染进程是否可接收 IPC。
   *
   * 除窗口/webContents 未销毁外，还必须排除「渲染进程已崩溃但 webContents 对象还在」
   * 的中间态：此时 frame 已被 dispose，`webContents.send` 会在 Electron 内部抛错并
   * 由 Electron 自己 `console.error("Error sending from webFrameMain: ...")`，
   * 调用方的 try/catch 拦不住，只会刷屏。必须在这里提前判定，别让它走到 send。
   */
  canReachRenderer(): boolean {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return false
    const wc = win.webContents
    return !wc.isDestroyed() && !wc.isCrashed()
  }

  /**
   * 丢弃离线队列。渲染进程崩溃重载后 UI 会从 DB 重建状态，
   * 旧事件既送不到也没有重放价值，留着只会占用主进程内存。
   */
  clearIpcQueue(): void {
    if (this.ipcMessageQueue.length === 0) return
    log.info(`[clearIpcQueue] 丢弃 ${this.ipcMessageQueue.length} 条离线事件`)
    this.ipcMessageQueue = []
  }

  /**
   * 向宠物模式独立窗口镜像 Agent Runtime 事件。
   * 宠物窗口与主窗口分离，主进程 Bridge 默认只推主窗口；虚拟人 UI 依赖此镜像收流式 delta。
   */
  private mirrorToPetWindow(event: IpcEvent): void {
    const petWin = getPetWindowManager()?.getPetBrowserWindow()
    const mainWin = this.getWindow()
    if (!petWin || petWin.isDestroyed()) return
    if (mainWin && petWin === mainWin) return
    try {
      petWin.webContents.send('agent-runtime:event', event)
    } catch (e) {
      const msg = (e as Error).message ?? String(e)
      if (!msg.includes('disposed') && !msg.includes('destroyed')) {
        const evtType = (event as { type?: string }).type
        log.warn(`[mirrorToPetWindow] IPC 发送失败 type=${evtType}: ${msg}`)
      }
    }
  }

  /**
   * 尝试向渲染进程发送事件；失败时返回 false（不抛错、不刷 Electron 内部错误日志）。
   */
  private trySendToRenderer(event: IpcEvent): boolean {
    if (!this.canReachRenderer()) return false
    const win = this.getWindow()!
    try {
      win.webContents.send('agent-runtime:event', event)
      this.mirrorToPetWindow(event)
      return true
    } catch (e) {
      const msg = (e as Error).message ?? String(e)
      if (!msg.includes('disposed') && !msg.includes('destroyed')) {
        const evtType = (event as { type?: string }).type
        log.warn(`[trySendToRenderer] IPC 发送失败 type=${evtType}: ${msg}`)
      }
      return false
    }
  }

  /**
   * 直发渲染进程，不经离线队列（当前仅 runtime:ready 用）。
   * 与 forwardIpcEvent 的区别：不入队、不通知 voiceEventBus。
   * 送不到就丢——runtime:ready 是一次性通知，渲染侧另有挂载即拉的兜底。
   */
  forwardToRenderer(event: IpcEvent): void {
    const evtType = (event as { type?: string }).type
    if (!this.trySendToRenderer(event)) {
      log.warn(`[forwardToRenderer] 渲染进程不可达，已跳过 type=${evtType}`)
      // 主窗口不可达时仍尝试推送给宠物窗口（桌面隐藏、仅虚拟人可见时）
      this.mirrorToPetWindow(event)
    }
  }

  /**
   * 发送新格式 IPC 事件；失败或窗口不可用时入队。
   * 同时通知语音通话服务——renderer 与 voice service 共用同一套新格式事件。
   *
   * @returns 是否已成功送达渲染进程
   */
  forwardIpcEvent(event: IpcEvent): boolean {
    const evtType = (event as { type?: string }).type
    if (evtType === 'conversation:created' || evtType === 'conversation:message:new' || evtType === 'agent:idle' || evtType === 'agent:turn:start' || evtType === 'agent:turn:end') {
      log.info(`[forwardIpcEvent] type=${evtType}`)
    }
    const sent = this.trySendToRenderer(event)
    if (!sent) {
      // 渲染进程崩溃后 canReachRenderer 恒为 false，若不设上限这里会一直堆事件
      if (this.ipcMessageQueue.length >= MAX_QUEUED_IPC_EVENTS) this.ipcMessageQueue.shift()
      this.ipcMessageQueue.push({ event, timestamp: Date.now() })
      // 主窗口离线时宠物窗口仍可展示流式字幕/表情
      this.mirrorToPetWindow(event)
    }
    // renderer 与 voice service 共用新格式事件，统一从此处分发
    try {
      voiceEventBus.emit('agent-event', event)
    } catch (e) {
      log.error(`[forwardIpcEvent] voiceEventBus 回调异常 type=${evtType}: ${(e as Error).message}`)
    }
    return sent
  }

  /**
   * 窗口恢复后调用，flush 队列（丢弃超过 60 秒的过期消息）
   */
  flushIpcQueue(): void {
    const cutoff = Date.now() - 60_000
    const pending = this.ipcMessageQueue.filter((m) => m.timestamp > cutoff)
    this.ipcMessageQueue = []
    if (!this.canReachRenderer()) return
    let sentCount = 0
    for (const { event } of pending) {
      if (this.trySendToRenderer(event)) {
        sentCount++
      } else {
        this.mirrorToPetWindow(event)
      }
    }
    if (sentCount > 0) {
      log.info(`[flushIpcQueue] 已发送 ${sentCount} 条缓存事件`)
    }
  }
}
