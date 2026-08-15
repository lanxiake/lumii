/**
 * 渲染进程对 ElectronAPI.screenRecord 的薄封装
 */
import type {
  ScreenRecordEvent,
  ScreenRecordStartParams,
  ScreenRecordStartResult,
  ScreenRecordStopResult,
  ScreenRecordPauseResult,
  ScreenRecordResumeResult,
  ScreenRecordStatusResult,
  ScreenRecordListSourcesResult,
  ScreenRecordNarrateParams,
  ScreenRecordNarrateResult,
  ScreenRecordListRecordingsResult,
  ScreenRecordLoadSubtitleProjectResult,
  ScreenRecordSaveSubtitleProjectResult,
  ScreenRecordBurnSubtitlesParams,
  ScreenRecordBurnSubtitlesResult,
  ScreenRecordSubtitleCue,
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

/** 停止录制（可选导出 MP4） */
export async function stop(params?: {
  exportMp4?: boolean
}): Promise<ScreenRecordStopResult> {
  const capture = getScreenRecordCapture()
  if (capture.isActive()) {
    await capture.stop()
  }
  return (await window.electronAPI.screenRecord.stop(params)) as ScreenRecordStopResult
}

/** 成片旁白（SRT + TTS，默认烧字幕） */
export async function narrate(
  params: ScreenRecordNarrateParams,
): Promise<ScreenRecordNarrateResult> {
  return (await window.electronAPI.screenRecord.narrate(params)) as ScreenRecordNarrateResult
}

/** 列出 recordings 成片（mtime 降序） */
export async function listRecordings(): Promise<ScreenRecordListRecordingsResult> {
  return (await window.electronAPI.screenRecord.listRecordings()) as ScreenRecordListRecordingsResult
}

/** 加载字幕 sidecar 项目 */
export async function loadSubtitleProject(
  filePath: string,
): Promise<ScreenRecordLoadSubtitleProjectResult> {
  return (await window.electronAPI.screenRecord.loadSubtitleProject(
    filePath,
  )) as ScreenRecordLoadSubtitleProjectResult
}

/** 保存字幕项目（仅 srt + json） */
export async function saveSubtitleProject(
  filePath: string,
  cues: ScreenRecordSubtitleCue[],
): Promise<ScreenRecordSaveSubtitleProjectResult> {
  return (await window.electronAPI.screenRecord.saveSubtitleProject(
    filePath,
    cues,
  )) as ScreenRecordSaveSubtitleProjectResult
}

/** 增量配音并烧录成片 */
export async function burnSubtitles(
  params: ScreenRecordBurnSubtitlesParams,
): Promise<ScreenRecordBurnSubtitlesResult> {
  return (await window.electronAPI.screenRecord.burnSubtitles(
    params,
  )) as ScreenRecordBurnSubtitlesResult
}

/**
 * 构造 lumii-local 媒体 URL（与主进程 buildLocalMediaUrl 一致）。
 */
export function buildRecordingMediaUrl(absPath: string): string {
  return `lumii-local://media/?path=${encodeURIComponent(absPath)}`
}

/** 暂停录制 */
export async function pause(): Promise<ScreenRecordPauseResult> {
  return (await window.electronAPI.screenRecord.pause()) as ScreenRecordPauseResult
}

/** 继续录制 */
export async function resume(): Promise<ScreenRecordResumeResult> {
  return (await window.electronAPI.screenRecord.resume()) as ScreenRecordResumeResult
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
 * 订阅录屏事件；自动响应 start/stop/pause/resume-capture 驱动采集层。
 */
export function onEvent(cb: (event: ScreenRecordEvent) => void): () => void {
  const capture = getScreenRecordCapture()
  return window.electronAPI.screenRecord.onEvent((raw) => {
    const event = raw as ScreenRecordEvent
    if (event.type === 'screen-record:event:start-capture') {
      const e = event as Extract<ScreenRecordEvent, { type: 'screen-record:event:start-capture' }>
      void capture
        .start({
          sessionId: e.sessionId,
          sourceId: e.sourceId,
          includeMic: e.includeMic,
          includeSystemAudio: e.includeSystemAudio,
        })
        .catch((err) => {
          window.electronAPI.screenRecord.notifyCaptureError({
            sessionId: e.sessionId,
            reason: err instanceof Error ? err.message : 'capture_failed',
          })
        })
    } else if (event.type === 'screen-record:event:stop-capture') {
      void capture.stop()
    } else if (event.type === 'screen-record:event:pause-capture') {
      capture.pause()
    } else if (event.type === 'screen-record:event:resume-capture') {
      capture.resume()
    }
    cb(event)
  })
}
