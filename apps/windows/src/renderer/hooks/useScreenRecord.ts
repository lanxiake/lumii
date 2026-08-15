/**
 * useScreenRecord — 录屏状态订阅 + 面板/确认弹窗控制
 */
import { useCallback, useEffect, useState } from 'react'
import type {
  ScreenRecordSource,
  ScreenRecordStatus,
  ScreenRecordStartParams,
} from '../../shared/screen-record'
import * as screenRecordApi from '../services/screen-record-api'
import type { LastRecordingInfo } from '../services/screen-record-api'

/** AI 确认弹窗载荷 */
export interface ScreenRecordConfirmPayload {
  sessionId: string
  sourceName: string
  sourceType: string
  sourceId: string
  thumbnailDataUrl?: string
  timeoutSec: number
  startedAt: number
}

/**
 * 录屏 React Hook：状态、源列表、开停录、确认弹窗、面板开关。
 */
export function useScreenRecord() {
  const [status, setStatus] = useState<ScreenRecordStatus>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [sources, setSources] = useState<ScreenRecordSource[]>([])
  const [lastRecording, setLastRecording] = useState<LastRecordingInfo | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<ScreenRecordConfirmPayload | null>(null)
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [sourceName, setSourceName] = useState<string | undefined>()
  /** 目标窗口被最小化/遮挡时画面已冻结 */
  const [targetHidden, setTargetHidden] = useState(false)
  /** 需要在成片库中定位高亮的路径（录制完成后自动跳转） */
  const [focusRecordingPath, setFocusRecordingPath] = useState<string | null>(null)

  useEffect(() => {
    const unsub = screenRecordApi.onEvent((event) => {
      if (event.type === 'screen-record:event:status-changed') {
        const detail = event.detail
        if (detail.ok) {
          setStatus(detail.status)
          setElapsedMs(detail.elapsedMs ?? 0)
          setSessionId(detail.sessionId)
          setSourceName(detail.sourceName)
          setTargetHidden(detail.targetHidden === true)
          if (detail.status === 'idle') {
            setPendingConfirm(null)
          }
        }
      } else if (event.type === 'screen-record:event:recording-saved') {
        // 录制完成：回填最近成片并自动打开面板定位到成片库
        setLastRecording({
          path: event.path,
          durationMs: event.durationMs,
          bytes: event.bytes,
        })
        setFocusRecordingPath(event.path)
        setPanelOpen(true)
      } else if (event.type === 'screen-record:event:confirm-requested') {
        setPendingConfirm({
          sessionId: event.sessionId,
          sourceName: event.sourceName,
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          thumbnailDataUrl: event.thumbnailDataUrl,
          timeoutSec: event.timeoutSec,
          startedAt: event.startedAt,
        })
      } else if (event.type === 'screen-record:event:cancelled') {
        setPendingConfirm(null)
      } else if (event.type === 'screen-record:open-panel') {
        setPanelOpen(true)
      } else if (event.type === 'screen-record:persist-always-allow') {
        // 由 ScreenRecordRoot 监听并写 settings
      }
    })

    void screenRecordApi.status().then((s) => {
      if (s.ok) {
        setStatus(s.status)
        setElapsedMs(s.elapsedMs ?? 0)
        setSessionId(s.sessionId)
        setSourceName(s.sourceName)
      }
    })

    return unsub
  }, [])

  // recording 时本地计时刷新
  useEffect(() => {
    if (status !== 'recording') return
    const t = setInterval(() => {
      void screenRecordApi.status().then((s) => {
        if (s.ok) setElapsedMs(s.elapsedMs ?? 0)
      })
    }, 1000)
    return () => clearInterval(t)
  }, [status])

  /** 刷新源列表 */
  const refreshSources = useCallback(async (includeThumbnail = false) => {
    const r = await screenRecordApi.listSources(includeThumbnail)
    if (r.ok) setSources(r.sources)
    return r
  }, [])

  /** 开始录制 */
  const start = useCallback(async (params: ScreenRecordStartParams) => {
    const r = await screenRecordApi.start(params)
    if (r.ok && r.status === 'recording') {
      setStatus('recording')
      setSessionId(r.sessionId)
    } else if (r.ok && r.status === 'needs_confirmation') {
      setStatus('pending_confirm')
      setSessionId(r.sessionId)
    }
    return r
  }, [])

  /** 停止录制（可选导出 MP4） */
  const stop = useCallback(async (params?: { exportMp4?: boolean }) => {
    const r = await screenRecordApi.stop(params)
    if (r.ok && r.path) {
      setLastRecording({ path: r.path, durationMs: r.durationMs, bytes: r.bytes })
      setFocusRecordingPath(r.path)
      setPanelOpen(true)
    }
    setStatus('idle')
    setTargetHidden(false)
    return r
  }, [])

  /** 暂停录制 */
  const pause = useCallback(async () => {
    const r = await screenRecordApi.pause()
    if (r.ok) {
      setStatus('paused')
      setElapsedMs(r.elapsedMs)
    }
    return r
  }, [])

  /** 继续录制 */
  const resume = useCallback(async () => {
    const r = await screenRecordApi.resume()
    if (r.ok) {
      setStatus('recording')
      setElapsedMs(r.elapsedMs)
    }
    return r
  }, [])

  /** 回应用户确认 */
  const respondConfirm = useCallback(
    (allow: boolean, rememberAlwaysAllow?: boolean) => {
      if (!pendingConfirm) return
      screenRecordApi.respondConfirm(pendingConfirm.sessionId, allow, rememberAlwaysAllow)
      if (!allow) setPendingConfirm(null)
    },
    [pendingConfirm],
  )

  return {
    status,
    elapsedMs,
    sources,
    lastRecording,
    panelOpen,
    setPanelOpen,
    pendingConfirm,
    sessionId,
    sourceName,
    targetHidden,
    focusRecordingPath,
    clearFocusRecording: useCallback(() => setFocusRecordingPath(null), []),
    refreshSources,
    start,
    stop,
    pause,
    resume,
    respondConfirm,
  }
}
