/**
 * 渲染进程 IPC：窗口可用时直发，否则入队；flush 时丢弃过期项
 */

import type { BrowserWindow } from 'electron'
import type { AgentRuntimeEvent } from '@mtbot/agent-runtime'
import type { AgentRuntimeEvent as IpcEvent } from '../../shared/agent-runtime-events'
import { getPetWindowManager } from '../pet/pet-mode-ipc.js'
import { agentRuntimeLog as log } from './bridge-utils'
import { voiceEventBus } from '../voice/voice-event-bus.js'

type Queued = { event: IpcEvent; timestamp: number }

/**
 * 封装主窗口 webContents.send 与离线消息队列
 */
export class BridgeRendererIpcChannel {
  private ipcMessageQueue: Queued[] = []

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /**
   * 判断主窗口渲染进程是否可接收 IPC（窗口/webContents 未销毁）。
   */
  canReachRenderer(): boolean {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return false
    const wc = win.webContents
    return !wc.isDestroyed()
  }

  /**
   * 向宠物模式独立窗口镜像 Agent Runtime 事件。
   * 宠物窗口与主窗口分离，主进程 Bridge 默认只推主窗口；虚拟人 UI 依赖此镜像收流式 delta。
   */
  private mirrorToPetWindow(event: AgentRuntimeEvent | IpcEvent): void {
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
  private trySendToRenderer(event: AgentRuntimeEvent | IpcEvent): boolean {
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
   * 发送旧格式 Agent 运行时事件（不经队列包装）
   * 注意：语音通话服务通过 forwardIpcEvent（新格式）订阅事件，此处不重复通知
   */
  forwardToRenderer(event: AgentRuntimeEvent | IpcEvent): void {
    const evtType = (event as { type?: string }).type
    if (evtType === 'agent:end' || evtType === 'agent:start') {
      log.info(`[forwardToRenderer] 发送旧格式事件 type=${evtType}`)
    }
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
    if (evtType === 'conversation:message:new' || evtType === 'agent:idle' || evtType === 'agent:turn:start' || evtType === 'agent:turn:end') {
      log.info(`[forwardIpcEvent] type=${evtType}`)
    }
    const sent = this.trySendToRenderer(event)
    if (!sent) {
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
