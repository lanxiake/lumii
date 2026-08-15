/**
 * ScreenRecordCapture — 渲染进程桌面采集 + 麦混轨 + MediaRecorder 分片
 * 设计 §2.2；MVP 已知限制：音画偏移 <500ms 不做补偿。
 */

import {
  MEDIA_RECORDER_TIMESLICE_MS,
  MAX_CHUNK_BYTES_PER_IPC,
} from '../../shared/screen-record'
import {
  arrayBufferToBase64,
  mixMicIntoDestination,
  pickSupportedMime,
  splitBlobToChunks,
} from './mix-audio-tracks'

/** 采集层 IPC 依赖 */
export interface ScreenRecordCaptureIpc {
  sendChunk: (sessionId: string, chunkBase64: string, index: number, isLast: boolean) => void
  notifyStreamEnded: (sessionId: string) => void
  notifyCaptureError: (sessionId: string, reason: string) => void
}

/** ScreenRecordCapture 依赖 */
export interface ScreenRecordCaptureDeps {
  ipc: ScreenRecordCaptureIpc
  nowMs: () => number
}

type ActiveSession = {
  sessionId: string
  mediaStream: MediaStream
  desktopStream: MediaStream
  micStream: MediaStream | null
  audioCtx: AudioContext | null
  mediaRecorder: MediaRecorder
  nextChunkIndex: number
  startTime: number
  stopping: boolean
}

/**
 * 渲染进程录屏采集器（单会话）。
 */
export class ScreenRecordCapture {
  private session: ActiveSession | null = null
  private readonly deps: ScreenRecordCaptureDeps

  constructor(deps: ScreenRecordCaptureDeps) {
    this.deps = deps
  }

  /** 当前是否在录 */
  isActive(): boolean {
    return this.session != null
  }

  /**
   * 开始采集：desktop getUserMedia + 可选麦混轨 + MediaRecorder。
   * 麦失败时降级无声并通知 mic_unavailable（主进程标 warning，不整体失败）。
   */
  async start(params: {
    sessionId: string
    sourceId: string
    includeMic: boolean
  }): Promise<void> {
    if (this.session) {
      await this.stop()
    }

    // Electron 桌面捕获约束
    const desktopStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // @ts-expect-error Electron chromeMediaSource 扩展
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: params.sourceId,
          maxFrameRate: 30,
        },
      },
    })

    let micStream: MediaStream | null = null
    if (params.includeMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      } catch {
        this.deps.ipc.notifyCaptureError(params.sessionId, 'mic_unavailable')
        micStream = null
      }
    }

    const outTracks: MediaStreamTrack[] = [...desktopStream.getVideoTracks()]
    let audioCtx: AudioContext | null = null
    if (micStream) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctx()
      const mixed = mixMicIntoDestination(audioCtx, micStream)
      outTracks.push(...mixed.getAudioTracks())
    }
    const combined = new MediaStream(outTracks)

    const mimeType = pickSupportedMime([
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp8',
      'video/webm',
    ])
    if (!mimeType) {
      this.cleanupStreams(desktopStream, micStream, audioCtx)
      this.deps.ipc.notifyCaptureError(params.sessionId, 'capture_failed')
      throw new Error('capture_failed: no webm encoder')
    }

    const mr = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 2_500_000 })
    this.session = {
      sessionId: params.sessionId,
      mediaStream: combined,
      desktopStream,
      micStream,
      audioCtx,
      mediaRecorder: mr,
      nextChunkIndex: 0,
      startTime: this.deps.nowMs(),
      stopping: false,
    }

    mr.ondataavailable = (e) => {
      if (!this.session || e.data.size === 0) return
      void this.emitChunk(e.data, false)
    }
    mr.onerror = () => {
      this.deps.ipc.notifyCaptureError(params.sessionId, 'media_recorder_error')
    }
    mr.start(MEDIA_RECORDER_TIMESLICE_MS)

    const videoTrack = desktopStream.getVideoTracks()[0]
    videoTrack?.addEventListener('ended', () => {
      if (!this.session || this.session.stopping) return
      this.deps.ipc.notifyStreamEnded(params.sessionId)
      void this.stopInternal(true)
    })
  }

  /**
   * 正常停止采集，返回已录时长。
   */
  async stop(): Promise<{ recordedMs: number }> {
    return this.stopInternal(false)
  }

  /** 内部停止；fromEnded 时不再重复 notifyStreamEnded */
  private async stopInternal(fromEnded: boolean): Promise<{ recordedMs: number }> {
    const s = this.session
    if (!s) return { recordedMs: 0 }
    if (s.stopping) return { recordedMs: Math.max(0, this.deps.nowMs() - s.startTime) }
    s.stopping = true

    const recordedMs = Math.max(0, this.deps.nowMs() - s.startTime)

    await new Promise<void>((resolve) => {
      const mr = s.mediaRecorder
      if (mr.state === 'inactive') {
        resolve()
        return
      }
      mr.onstop = () => resolve()
      try {
        mr.stop()
      } catch {
        resolve()
      }
    })

    // 最后一包 isLast（空包也可标记结束序号）
    this.deps.ipc.sendChunk(s.sessionId, '', s.nextChunkIndex, true)

    this.cleanupStreams(s.desktopStream, s.micStream, s.audioCtx)
    this.session = null
    void fromEnded
    return { recordedMs }
  }

  /** 分片编码并发送（超 2MB 拆分） */
  private async emitChunk(blob: Blob, forceLast: boolean): Promise<void> {
    const s = this.session
    if (!s) return
    const parts = await splitBlobToChunks(blob, MAX_CHUNK_BYTES_PER_IPC)
    for (let i = 0; i < parts.length; i++) {
      const isLast = forceLast && i === parts.length - 1
      const b64 = arrayBufferToBase64(parts[i]!)
      this.deps.ipc.sendChunk(s.sessionId, b64, s.nextChunkIndex, isLast)
      s.nextChunkIndex += 1
    }
  }

  /** 释放媒体流与 AudioContext */
  private cleanupStreams(
    desktop: MediaStream,
    mic: MediaStream | null,
    audioCtx: AudioContext | null,
  ): void {
    for (const t of desktop.getTracks()) t.stop()
    if (mic) for (const t of mic.getTracks()) t.stop()
    if (audioCtx) {
      void audioCtx.close().catch(() => undefined)
    }
  }
}
