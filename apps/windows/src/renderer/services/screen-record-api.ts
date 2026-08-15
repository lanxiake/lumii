/**
 * 渲染进程对 ElectronAPI.screenRecord 的薄封装
 */
import type {
  ScreenRecordEvent,
  ScreenRecordStartParams,
  ScreenRecordStartResult,
  ScreenRecordStopResult,
  ScreenRecordStatusResult,
  ScreenRecordListSourcesResult,
} from '../../shared/screen-record'
import { ScreenRecordCapture } from '../screen-record'

/** 最近一条成片信息 */
export interface LastRecordingInfo {
  path: string
  durationMs: number
  bytes: number
}

let captureSingleton: ScreenRecordCapture | null = null

/**
 * 获取全局 ScreenRecordCapture 单例（组件卸载不销毁）。
 */
export function getScreenRecordCapture(): ScreenRecordCapture {
  if (!captureSingleton) {
    captureSingleton = new ScreenRecordCapture({
      nowMs: () => Date.now(),
      ipc: {
        sendChunk: (sessionId, chunkBase64, index, isLast) => {
          window.electronAPI?.screenRecord?.sendChunk({
            sessionId,
            chunkBase64,
            index,
            isLast,
          })
        },
        notifyStreamEnded: (sessionId) => {
          window.electronAPI?.screenRecord?.notifyStreamEnded({ sessionId })
        },
        notifyCaptureError: (sessionId, reason) => {
          window.electronAPI?.screenRecord?.notifyCaptureError({ sessionId, reason })
        },
      },
    })
  }
  return captureSingleton
}

/** 列出录屏源 */
export async function listSources(
  includeThumbnail = false,
): Promise<ScreenRecordListSourcesResult> {
  return (await window.electronAPI.screenRecord.listSources(
    includeThumbnail,
  )) as ScreenRecordListSourcesResult
}

/** 开始录制 */
export async function start(
  params: ScreenRecordStartParams,
): Promise<ScreenRecordStartResult> {
  return (await window.electronAPI.screenRecord.start(params)) as ScreenRecordStartResult
}

/** 停止录制 */
export async function stop(): Promise<ScreenRecordStopResult> {
  const capture = getScreenRecordCapture()
  if (capture.isActive()) {
    await capture.stop()
  }
  return (await window.electronAPI.screenRecord.stop()) as ScreenRecordStopResult
}

/** 查询状态 */
export async function status(): Promise<ScreenRecordStatusResult> {
  return (await window.electronAPI.screenRecord.status()) as ScreenRecordStatusResult
}

/** 回应用户确认 */
export function respondConfirm(
  sessionId: string,
  allow: boolean,
  rememberAlwaysAllow?: boolean,
): void {
  window.electronAPI.screenRecord.respondConfirm({
    sessionId,
    allow,
    rememberAlwaysAllow,
  })
}

/**
 * 订阅录屏事件；自动响应 start-capture / stop-capture 驱动采集层。
 */
export function onEvent(cb: (event: ScreenRecordEvent | { type: string; [k: string]: unknown }) => void): () => void {
  const capture = getScreenRecordCapture()
  return window.electronAPI.screenRecord.onEvent((raw) => {
    const event = raw as ScreenRecordEvent & { type: string }
    if (event.type === 'screen-record:event:start-capture') {
      const e = event as Extract<ScreenRecordEvent, { type: 'screen-record:event:start-capture' }>
      void capture
        .start({
          sessionId: e.sessionId,
          sourceId: e.sourceId,
          includeMic: e.includeMic,
        })
        .catch((err) => {
          window.electronAPI.screenRecord.notifyCaptureError({
            sessionId: e.sessionId,
            reason: err instanceof Error ? err.message : 'capture_failed',
          })
        })
    } else if (event.type === 'screen-record:event:stop-capture') {
      void capture.stop()
    }
    cb(event)
  })
}
