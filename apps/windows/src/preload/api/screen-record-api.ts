/**
 * 录屏 API（主进程 ScreenRecordService + 渲染采集）
 */
import { ipcRenderer } from 'electron'

const screenRecordEventSubscribers = new Set<(event: unknown) => void>()
let screenRecordEventIpcBound = false
const SCREEN_RECORD_EVENT_CHANNELS = [
  'screen-record:event:status-changed',
  'screen-record:event:confirm-requested',
  'screen-record:event:start-capture',
  'screen-record:event:stop-capture',
  'screen-record:event:pause-capture',
  'screen-record:event:resume-capture',
  'screen-record:event:cancelled',
  'screen-record:event:recording-saved',
  'screen-record:open-panel',
  'screen-record:persist-always-allow',
] as const

/**
 * 订阅录屏事件（内部只挂一次 ipcRenderer 监听）
 */
function subscribeScreenRecordEvent(callback: (event: unknown) => void): () => void {
  screenRecordEventSubscribers.add(callback)
  if (!screenRecordEventIpcBound) {
    screenRecordEventIpcBound = true
    for (const ch of SCREEN_RECORD_EVENT_CHANNELS) {
      ipcRenderer.on(ch, (_evt, data: unknown) => {
        const payload =
          data && typeof data === 'object' && 'type' in (data as object)
            ? data
            : { type: ch, ...(typeof data === 'object' && data ? data : { value: data }) }
        for (const cb of screenRecordEventSubscribers) {
          try {
            cb(payload)
          } catch (e) {
            console.error('[Preload] screen-record event 订阅回调异常:', e)
          }
        }
      })
    }
  }
  return () => {
    screenRecordEventSubscribers.delete(callback)
  }
}

export const screenRecordApi = {
  listSources: (includeThumbnail?: boolean) =>
    ipcRenderer.invoke('screen-record:list-sources', { includeThumbnail }),
  start: (params: {
    sourceId: string
    includeMic?: boolean
    includeSystemAudio?: boolean
    maxDurationSec?: number
  }) =>
    ipcRenderer.invoke('screen-record:start', { params }),
  stop: (params?: { exportMp4?: boolean }) =>
    ipcRenderer.invoke('screen-record:stop', { params }),
  narrate: (params: {
    path: string
    cues: Array<{ startMs: number; text: string; endMs?: number }>
    writeSrt?: boolean
    dub?: boolean
    subtitleMode?: 'soft' | 'burn'
    originalAudioGain?: number
    exportMp4?: boolean
  }) => ipcRenderer.invoke('screen-record:narrate', { params }),
  listRecordings: () => ipcRenderer.invoke('screen-record:list-recordings'),
  deleteRecording: (filePath: string) =>
    ipcRenderer.invoke('screen-record:delete-recording', { path: filePath }),
  restoreOriginal: (filePath: string) =>
    ipcRenderer.invoke('screen-record:restore-original', { path: filePath }),
  loadSubtitleProject: (filePath: string) =>
    ipcRenderer.invoke('screen-record:load-subtitle-project', { path: filePath }),
  saveSubtitleProject: (
    filePath: string,
    cues: Array<{ id?: string; startMs: number; endMs?: number; text: string; audioFile?: string }>,
    style?: { fontSize?: number; primaryColor?: string; outline?: number },
  ) => ipcRenderer.invoke('screen-record:save-subtitle-project', { path: filePath, cues, style }),
  burnSubtitles: (params: {
    path: string
    cues?: Array<{ id?: string; startMs: number; endMs?: number; text: string; audioFile?: string }>
    dub?: boolean
    subtitleMode?: 'soft' | 'burn'
    originalAudioGain?: number
    exportMp4?: boolean
    style?: { fontSize?: number; primaryColor?: string; outline?: number }
  }) => ipcRenderer.invoke('screen-record:burn-subtitles', { params }),
  pause: () => ipcRenderer.invoke('screen-record:pause'),
  resume: () => ipcRenderer.invoke('screen-record:resume'),
  status: () => ipcRenderer.invoke('screen-record:status'),
  respondConfirm: (p: {
    sessionId: string
    allow: boolean
    rememberAlwaysAllow?: boolean
  }) => {
    ipcRenderer.send('screen-record:confirm-respond', p)
  },
  sendChunk: (p: {
    sessionId: string
    chunkBase64: string
    index: number
    isLast: boolean
  }) => {
    ipcRenderer.send('screen-record:chunk', p)
  },
  notifyStreamEnded: (p: { sessionId: string }) => {
    ipcRenderer.send('screen-record:stream-ended', p)
  },
  notifyCaptureError: (p: { sessionId: string; reason: string }) => {
    ipcRenderer.send('screen-record:capture-error', p)
  },
  onEvent: (callback: (event: unknown) => void) => subscribeScreenRecordEvent(callback),
}
