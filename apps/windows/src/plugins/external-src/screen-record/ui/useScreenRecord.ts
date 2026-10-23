/**
 * 录屏状态订阅 + 面板/确认弹窗控制。
 *
 * 状态放在**模块级外部 store**（而不是 React Context）：顶栏按钮与浮层挂在宿主的
 * 两个不同槽位里，没有共同的 Provider；写成 store 后各自 `useSyncExternalStore`
 * 订阅同一份状态，插件停用时随条目卸载、引用计数归零后自动退订 IPC 事件。
 */
import { useSyncExternalStore } from 'react'
import type {
  ScreenRecordSource,
  ScreenRecordStatus,
  ScreenRecordStartParams,
} from '../../../../shared/screen-record'
import * as screenRecordApi from './screen-record-api'
import type { LastRecordingInfo } from './screen-record-api'

/** AI 确认弹窗载荷 */
export interface ScreenRecordConfirmPayload {
  sessionId: string
  sourceName: string
  sourceType: string
  sourceId: string
  thumbnailDataUrl?: string
  timeoutSec: number
  startedAt: number
  /** 录屏或桌面截图确认 */
  purpose: 'record' | 'screenshot'
  /** 发起方（缺省 = 用户操作）。用户自己点面板也会弹确认，措辞不能一概写成「AI 请求」 */
  initiator?: 'user' | 'agent'
}

export interface ScreenRecordState {
  status: ScreenRecordStatus
  elapsedMs: number
  sources: ScreenRecordSource[]
  lastRecording: LastRecordingInfo | null
  panelOpen: boolean
  pendingConfirm: ScreenRecordConfirmPayload | null
  sessionId?: string
  sourceName?: string
  /** 目标窗口被最小化/遮挡时画面已冻结 */
  targetHidden: boolean
  /** 需要在成片库中定位高亮的路径（录制完成后自动跳转） */
  focusRecordingPath: string | null
}

const INITIAL: ScreenRecordState = {
  status: 'idle',
  elapsedMs: 0,
  sources: [],
  lastRecording: null,
  panelOpen: false,
  pendingConfirm: null,
  targetHidden: false,
  focusRecordingPath: null,
}

let state: ScreenRecordState = INITIAL
const listeners = new Set<() => void>()
/** 订阅者数量：有人看才挂 IPC 事件与计时器，全部卸载即退订 */
let subscribers = 0
let teardown: (() => void) | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(patch: Partial<ScreenRecordState>): void {
  state = { ...state, ...patch }
  emit()
}

/** 计时器跟随录制状态：只在 recording 时每秒问一次主进程 */
let elapsedTimer: ReturnType<typeof setInterval> | null = null
function syncElapsedTimer(): void {
  if (state.status === 'recording' && !elapsedTimer) {
    elapsedTimer = setInterval(() => {
      void screenRecordApi.status().then((s) => {
        if (s.ok) setState({ elapsedMs: s.elapsedMs ?? 0 })
      })
    }, 1000)
  } else if (state.status !== 'recording' && elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

function setStatus(patch: Partial<ScreenRecordState>): void {
  setState(patch)
  syncElapsedTimer()
}

function startEffects(): void {
  if (teardown) return
  const unsub = screenRecordApi.onEvent((event) => {
    if (event.type === 'screen-record:event:status-changed') {
      const detail = event.detail
      if (detail.ok) {
        const patch: Partial<ScreenRecordState> = {
          status: detail.status,
          elapsedMs: detail.elapsedMs ?? 0,
          sessionId: detail.sessionId,
          sourceName: detail.sourceName,
          targetHidden: detail.targetHidden === true,
        }
        if (detail.status === 'idle') patch.pendingConfirm = null
        setStatus(patch)
      }
    } else if (event.type === 'screen-record:event:recording-saved') {
      // 录制完成：回填最近成片并自动打开面板定位到成片库
      setState({
        lastRecording: { path: event.path, durationMs: event.durationMs, bytes: event.bytes },
        focusRecordingPath: event.path,
        panelOpen: true,
      })
    } else if (event.type === 'screen-record:event:confirm-requested') {
      setState({
        pendingConfirm: {
          sessionId: event.sessionId,
          sourceName: event.sourceName,
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          thumbnailDataUrl: event.thumbnailDataUrl,
          timeoutSec: event.timeoutSec,
          startedAt: event.startedAt,
          purpose: event.purpose === 'screenshot' ? 'screenshot' : 'record',
          initiator: event.initiator,
        },
      })
    } else if (event.type === 'screen-record:event:cancelled') {
      setState({ pendingConfirm: null })
    } else if (event.type === 'screen-record:open-panel') {
      setState({ panelOpen: true })
    } else if (event.type === 'screen-record:persist-always-allow') {
      // 由 ScreenRecordRoot 监听并写 settings
    }
  })

  void screenRecordApi.status().then((s) => {
    if (!s.ok) return
    const patch: Partial<ScreenRecordState> = {
      status: s.status,
      elapsedMs: s.elapsedMs ?? 0,
      sessionId: s.sessionId,
      sourceName: s.sourceName,
    }
    if (s.status === 'pending_confirm' && s.pendingConfirm && s.sessionId) {
      // 刷新窗口后恢复确认弹窗（主进程确认态与定时器仍在）；
      // Dialog 倒计时按 timeoutSec-(now-startedAt) 计，故 startedAt 取恢复时刻、
      // timeoutSec 取剩余秒，与主进程超时截止点一致
      patch.pendingConfirm = {
        sessionId: s.sessionId,
        sourceName: s.sourceName ?? '',
        sourceType: s.sourceType ?? 'window',
        sourceId: s.sourceId ?? '',
        timeoutSec: s.confirmTimeoutSec ?? 0,
        startedAt: Date.now(),
        purpose: s.purpose ?? 'record',
        initiator: s.initiator,
      }
    }
    setStatus(patch)
  })

  teardown = () => {
    unsub()
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  }
}

/** 订阅录屏状态；引用计数归零时退订 IPC 事件 */
export function subscribeScreenRecord(listener: () => void): () => void {
  listeners.add(listener)
  subscribers += 1
  if (subscribers === 1) startEffects()
  return () => {
    listeners.delete(listener)
    subscribers -= 1
    if (subscribers === 0) {
      teardown?.()
      teardown = null
    }
  }
}

export function getScreenRecordSnapshot(): ScreenRecordState {
  return state
}

/** 仅供测试：把 store 与副作用恢复到未挂载状态 */
export function __resetScreenRecordStoreForTests(): void {
  teardown?.()
  teardown = null
  listeners.clear()
  subscribers = 0
  elapsedTimer = null
  state = INITIAL
}

export function setPanelOpen(open: boolean): void {
  setState({ panelOpen: open })
}

export function clearFocusRecording(): void {
  setState({ focusRecordingPath: null })
}

/** 刷新源列表 */
export async function refreshSources(includeThumbnail = false) {
  const r = await screenRecordApi.listSources(includeThumbnail)
  if (r.ok) setState({ sources: r.sources })
  return r
}

/** 开始录制 */
export async function startScreenRecord(params: ScreenRecordStartParams) {
  const r = await screenRecordApi.start(params)
  if (r.ok && r.status === 'recording') {
    setStatus({ status: 'recording', sessionId: r.sessionId })
  } else if (r.ok && r.status === 'needs_confirmation') {
    setStatus({ status: 'pending_confirm', sessionId: r.sessionId })
  }
  return r
}

/** 停止录制（可选导出 MP4） */
export async function stopScreenRecord(params?: { exportMp4?: boolean }) {
  const r = await screenRecordApi.stop(params)
  if (r.ok && r.path) {
    setState({
      lastRecording: { path: r.path, durationMs: r.durationMs, bytes: r.bytes },
      focusRecordingPath: r.path,
      panelOpen: true,
    })
  }
  setStatus({ status: 'idle', targetHidden: false })
  return r
}

/** 暂停录制 */
export async function pauseScreenRecord() {
  const r = await screenRecordApi.pause()
  if (r.ok) setStatus({ status: 'paused', elapsedMs: r.elapsedMs })
  return r
}

/** 继续录制 */
export async function resumeScreenRecord() {
  const r = await screenRecordApi.resume()
  if (r.ok) setStatus({ status: 'recording', elapsedMs: r.elapsedMs })
  return r
}

/** 回应用户确认 */
export function respondScreenRecordConfirm(allow: boolean, rememberAlwaysAllow?: boolean): void {
  const pending = state.pendingConfirm
  if (!pending) return
  screenRecordApi.respondConfirm(pending.sessionId, allow, rememberAlwaysAllow)
  if (!allow) setState({ pendingConfirm: null })
}

/**
 * 录屏 React Hook：状态、源列表、开停录、确认弹窗、面板开关。
 */
export function useScreenRecord() {
  const snapshot = useSyncExternalStore(
    subscribeScreenRecord,
    getScreenRecordSnapshot,
    getScreenRecordSnapshot,
  )
  return {
    ...snapshot,
    setPanelOpen,
    clearFocusRecording,
    refreshSources,
    start: startScreenRecord,
    stop: stopScreenRecord,
    pause: pauseScreenRecord,
    resume: resumeScreenRecord,
    respondConfirm: respondScreenRecordConfirm,
  }
}
