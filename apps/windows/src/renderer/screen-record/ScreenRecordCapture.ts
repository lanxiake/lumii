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
  mixDesktopAndMic,
  pickSupportedMime,
  splitBlobToChunks,
} from './mix-audio-tracks'
import { BLANK_HOLD_MS, computeCaptureSize, isBlankFrame } from './frame-guard'

/** 合成帧率（与桌面捕获 maxFrameRate 保持一致） */
const COMPOSITE_FPS = 30
/** 空帧采样分辨率 */
const SAMPLE_W = 32
const SAMPLE_H = 18

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
  /** 画布合成资源（目标窗口最小化时冻结最后有效帧） */
  composite: CompositeHandle | null
}

/** 画布合成句柄 */
interface CompositeHandle {
  stream: MediaStream
  stop: () => void
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
    includeSystemAudio?: boolean
  }): Promise<void> {
    if (this.session) {
      await this.stop()
    }

    const wantSystemAudio = params.includeSystemAudio !== false
    // Electron 桌面捕获：系统声走 desktop 流 audio 轨（整屏较可靠）
    let desktopStream: MediaStream
    try {
      desktopStream = await navigator.mediaDevices.getUserMedia({
        audio: wantSystemAudio
          ? ({
              // Electron chromeMediaSource 扩展，标准 MediaTrackConstraints 未声明
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: params.sourceId,
              },
            } as MediaTrackConstraints)
          : false,
        video: {
          // @ts-expect-error Electron chromeMediaSource 扩展
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: params.sourceId,
            maxFrameRate: 30,
          },
        },
      })
    } catch (e) {
      if (wantSystemAudio) {
        // 系统声失败：降级为无系统声再开一次
        this.deps.ipc.notifyCaptureError(params.sessionId, 'system_audio_unavailable')
        desktopStream = await navigator.mediaDevices.getUserMedia({
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
      } else {
        throw e
      }
    }

    // 若要求系统声但最终无音轨，也标降级
    if (wantSystemAudio && desktopStream.getAudioTracks().length === 0) {
      this.deps.ipc.notifyCaptureError(params.sessionId, 'system_audio_unavailable')
    }

    let micStream: MediaStream | null = null
    if (params.includeMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      } catch {
        this.deps.ipc.notifyCaptureError(params.sessionId, 'mic_unavailable')
        micStream = null
      }
    }

    // 画面经画布合成：输出分辨率固定，窗口缩放/最小化不再产生黑白屏或尺寸突变
    let composite: CompositeHandle | null = null
    try {
      composite = await this.createComposite(desktopStream, params.sessionId)
    } catch (e) {
      // 合成失败会退回原始桌面流（最小化时可能出现黑/白屏），需要能在日志中看到
      console.error('[ScreenRecordCapture] 画布合成初始化失败，回退原始桌面流', e)
      composite = null
    }
    if (!composite) {
      console.warn('[ScreenRecordCapture] 未启用画布合成，黑/白屏保护不可用')
    }

    const outTracks: MediaStreamTrack[] = composite
      ? [...composite.stream.getVideoTracks()]
      : [...desktopStream.getVideoTracks()]
    let audioCtx: AudioContext | null = null
    const hasDesktopAudio = desktopStream.getAudioTracks().length > 0
    if (hasDesktopAudio || micStream) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctx()
      const mixed = mixDesktopAndMic(
        audioCtx,
        hasDesktopAudio ? desktopStream : null,
        micStream,
      )
      if (mixed) outTracks.push(...mixed.getAudioTracks())
    }
    const combined = new MediaStream(outTracks)

    const mimeType = pickSupportedMime([
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp8',
      'video/webm',
    ])
    if (!mimeType) {
      composite?.stop()
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
      composite,
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
   * 暂停采集（MediaRecorder.pause）；不写新分片。
   */
  pause(): void {
    const s = this.session
    if (!s || s.stopping) return
    try {
      if (s.mediaRecorder.state === 'recording') s.mediaRecorder.pause()
    } catch {
      // ignore
    }
  }

  /**
   * 继续采集（MediaRecorder.resume）。
   */
  resume(): void {
    const s = this.session
    if (!s || s.stopping) return
    try {
      if (s.mediaRecorder.state === 'paused') s.mediaRecorder.resume()
    } catch {
      // ignore
    }
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

    s.composite?.stop()
    this.cleanupStreams(s.desktopStream, s.micStream, s.audioCtx)
    this.session = null
    void fromEnded
    return { recordedMs }
  }

  /**
   * 把桌面流经 <video> → <canvas> 定尺寸合成为新视频流。
   *
   * 目标窗口最小化/隐藏时桌面捕获会输出纯黑或纯白帧，此处逐帧采样，
   * 一旦判定为空帧立即停止绘制（画布保留最后一张有内容的帧），
   * 持续超过 BLANK_HOLD_MS 再上报 target_window_hidden 供主进程提示；
   * 画面恢复后自动继续绘制。窗口缩放时输出分辨率保持不变，避免编码异常。
   */
  private async createComposite(
    desktopStream: MediaStream,
    sessionId: string,
  ): Promise<CompositeHandle | null> {
    const videoEl = document.createElement('video')
    videoEl.muted = true
    videoEl.playsInline = true
    videoEl.autoplay = true
    // 脱离文档的 <video> 在部分环境下不解码帧，挂到屏幕外保证持续出帧
    videoEl.setAttribute(
      'style',
      'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none',
    )
    document.body.appendChild(videoEl)
    videoEl.srcObject = desktopStream

    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      videoEl.onloadedmetadata = done
      // 元数据迟迟不到时不阻塞录制启动
      setTimeout(done, 1500)
    })
    try {
      await videoEl.play()
    } catch {
      // 自动播放失败时仍可能有帧，继续尝试合成
    }

    const { width, height } = computeCaptureSize(videoEl.videoWidth, videoEl.videoHeight)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) {
      videoEl.srcObject = null
      videoEl.remove()
      return null
    }
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)

    const sampleCanvas = document.createElement('canvas')
    sampleCanvas.width = SAMPLE_W
    sampleCanvas.height = SAMPLE_H
    const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })

    let blankSince: number | null = null
    let hasGoodFrame = false
    let hiddenReported = false

    /** 单帧合成：等比居中绘制；判定为空帧时直接跳过绘制以冻结最后有效帧 */
    const drawFrame = () => {
      const now = this.deps.nowMs()
      const vw = videoEl.videoWidth
      const vh = videoEl.videoHeight
      if (vw < 2 || vh < 2) return

      let blankNow = false
      if (sampleCtx) {
        try {
          sampleCtx.drawImage(videoEl, 0, 0, SAMPLE_W, SAMPLE_H)
          blankNow = isBlankFrame(sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data)
        } catch {
          blankNow = false
        }
      }

      if (blankNow) {
        if (blankSince == null) blankSince = now
        // 已有有效画面时立刻停更画布，白/黑帧不会被写入成片
        if (hasGoodFrame) {
          if (!hiddenReported && now - blankSince >= BLANK_HOLD_MS) {
            hiddenReported = true
            this.deps.ipc.notifyCaptureError(sessionId, 'target_window_hidden')
          }
          return
        }
      } else {
        blankSince = null
        if (hiddenReported) {
          hiddenReported = false
          this.deps.ipc.notifyCaptureError(sessionId, 'target_window_visible')
        }
      }

      const scale = Math.min(width / vw, height / vh)
      const dw = Math.max(2, Math.round(vw * scale))
      const dh = Math.max(2, Math.round(vh * scale))
      const dx = Math.round((width - dw) / 2)
      const dy = Math.round((height - dh) / 2)
      if (dw !== width || dh !== height) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, width, height)
      }
      try {
        ctx.drawImage(videoEl, dx, dy, dw, dh)
        if (!blankNow) hasGoodFrame = true
      } catch {
        // 单帧绘制失败忽略，下一帧继续
      }
    }

    // 用 setInterval 而非 rAF：窗口最小化时 rAF 会被暂停，导致录制卡死
    const timer = setInterval(drawFrame, Math.round(1000 / COMPOSITE_FPS))
    drawFrame()

    const stream = canvas.captureStream(COMPOSITE_FPS)
    return {
      stream,
      stop: () => {
        clearInterval(timer)
        for (const t of stream.getTracks()) t.stop()
        try {
          videoEl.pause()
        } catch {
          // ignore
        }
        videoEl.srcObject = null
        videoEl.remove()
      },
    }
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
