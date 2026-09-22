/**
 * useTtsPreview - 朗读一段文本（流式 chunk 排进 AudioContext 顺序播放）
 *
 * 从 MessageActions 抽出来：气泡的朗读是同一件事 —— 发 `voice:tts:preview`，
 * 订阅 `voice:tts:preview:chunk` 把 PCM/MP3 排进播放队列。
 *
 * 两条必须遵守的既有结论（都踩过坑）：
 * - `voice:tts:stop-preview` **不带 id 是全局停**。所以只有本次挂载确实起过朗读时，
 *   卸载才去停它 —— 否则「滚动导致某行卸载」会把用户正在听的朗读掐断。
 * - 最大字数由调用方按场景给：设置页试听有 100 字上限，消息/气泡朗读不能用它，
 *   否则后半段会被静默截断。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** AudioContext 采样率与本地 VITS 对齐 */
const SAMPLE_RATE = 22050

/** 播放队列排空后熄灭「朗读中」的余量 */
const PLAYBACK_TAIL_MS = 120

interface TtsChunkEvent {
  type: string
  samples: Float32Array | ArrayLike<number>
  /** -1 表示 MP3 字节（Edge TTS），>0 表示 PCM 的采样率 */
  sampleRate: number
  isFinal?: boolean
}

function readEvent(event: unknown): TtsChunkEvent | null {
  if (!event || typeof event !== 'object') return null
  const e = event as TtsChunkEvent
  return e.type === 'voice:tts:preview:chunk' ? e : null
}

export interface UseTtsPreviewResult {
  isSpeaking: boolean
  /**
   * 正在准备朗读（`voice:tts:preview` 还没返回）。
   *
   * 这一位是防重点击用的：合成请求是异步的，返回前 `isSpeaking` 早就为真了，
   * 但用户看到按钮还没变化就会再点一下 —— 那一下会走「停止」分支，把刚起的朗读掐掉。
   * 调用方在 busy 为真时把入口置灰。
   */
  busy: boolean
  /** 开始朗读；已在朗读时调用方应改用 stop() */
  speak: (text: string, options: { maxChars: number }) => Promise<void>
  stop: () => Promise<void>
}

export function useTtsPreview(): UseTtsPreviewResult {
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [busy, setBusy] = useState(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  /** 下一个音频块应排到的时刻，保证块与块紧密衔接 */
  const nextPlayTimeRef = useRef(0)
  /** 是否处理进来的预览音频块；停止/播完/出错时置 false */
  const acceptChunksRef = useRef(false)
  /** 本次挂载是否**由本组件**起过朗读 —— 决定卸载时要不要发全局停 */
  const startedRef = useRef(false)
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearEndTimer = useCallback(() => {
    if (endTimerRef.current !== null) {
      clearTimeout(endTimerRef.current)
      endTimerRef.current = null
    }
  }, [])

  const teardown = useCallback(() => {
    acceptChunksRef.current = false
    clearEndTimer()
    audioCtxRef.current?.close()
    audioCtxRef.current = null
    nextPlayTimeRef.current = 0
    setIsSpeaking(false)
  }, [clearEndTimer])

  /** 最后一个块到达后，按队列剩余时长预约 UI 结束（不误用 isFinal 立即熄灭） */
  const scheduleEnd = useCallback(
    (ctx: AudioContext) => {
      clearEndTimer()
      const ms = Math.max(0, (nextPlayTimeRef.current - ctx.currentTime) * 1000) + PLAYBACK_TAIL_MS
      endTimerRef.current = setTimeout(() => {
        endTimerRef.current = null
        acceptChunksRef.current = false
        setIsSpeaking(false)
      }, ms)
    },
    [clearEndTimer],
  )

  useEffect(() => {
    const voice = window.electronAPI?.voice
    if (!voice?.onEvent) return

    const unsubscribe = voice.onEvent((event: unknown) => {
      const chunk = readEvent(event)
      if (!chunk || !acceptChunksRef.current) return
      const ctx = audioCtxRef.current
      if (!ctx) return

      if (chunk.sampleRate === -1) {
        // Edge TTS：mp3 字节，先解码
        void (async () => {
          try {
            const buffer = new Uint8Array(chunk.samples as ArrayLike<number>).buffer
            const decoded = await ctx.decodeAudioData(buffer)
            const source = ctx.createBufferSource()
            source.buffer = decoded
            source.connect(ctx.destination)
            const startAt = Math.max(nextPlayTimeRef.current, ctx.currentTime)
            source.start(startAt)
            nextPlayTimeRef.current = startAt + decoded.duration
            if (chunk.isFinal) scheduleEnd(ctx)
          } catch {
            teardown()
          }
        })()
        return
      }

      // 本地 VITS：PCM Float32 直接排
      try {
        const raw =
          chunk.samples instanceof Float32Array
            ? chunk.samples
            : new Float32Array(chunk.samples as ArrayLike<number>)
        const samples = new Float32Array(raw)
        const sampleRate = chunk.sampleRate > 0 ? chunk.sampleRate : SAMPLE_RATE
        if (ctx.state === 'running' && samples.length > 0) {
          const buffer = ctx.createBuffer(1, samples.length, sampleRate)
          buffer.copyToChannel(samples, 0)
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(ctx.destination)
          const startAt = Math.max(nextPlayTimeRef.current, ctx.currentTime)
          source.start(startAt)
          nextPlayTimeRef.current = startAt + buffer.duration
        }
        if (chunk.isFinal) scheduleEnd(ctx)
      } catch {
        teardown()
      }
    })

    return unsubscribe
  }, [scheduleEnd, teardown])

  const stop = useCallback(async () => {
    const voice = window.electronAPI?.voice
    acceptChunksRef.current = false
    startedRef.current = false
    setBusy(false)
    teardown()
    await voice?.sendCommand?.({ type: 'voice:tts:stop-preview' })?.catch(() => {})
  }, [teardown])

  const speak = useCallback(
    async (text: string, options: { maxChars: number }) => {
      const voice = window.electronAPI?.voice
      if (!voice?.sendCommand) return

      setBusy(true)
      try {
        // 起播前先停上一次（全局停，见文件头说明）
        await voice.sendCommand({ type: 'voice:tts:stop-preview' }).catch(() => {})
        clearEndTimer()
        acceptChunksRef.current = true
        startedRef.current = true

        if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
          audioCtxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE })
        }
        if (audioCtxRef.current.state === 'suspended') {
          await audioCtxRef.current.resume()
        }
        nextPlayTimeRef.current = audioCtxRef.current.currentTime
        setIsSpeaking(true)

        const result = (await voice.sendCommand({
          type: 'voice:tts:preview',
          text,
          maxChars: options.maxChars,
        })) as { error?: string } | undefined

        if (result?.error === 'models_not_ready') {
          acceptChunksRef.current = false
          clearEndTimer()
          setIsSpeaking(false)
          window.dispatchEvent(new CustomEvent('voice:models:need-download'))
        }
      } catch {
        acceptChunksRef.current = false
        clearEndTimer()
        setIsSpeaking(false)
      } finally {
        setBusy(false)
      }
    },
    [clearEndTimer],
  )

  // 卸载：只停自己起过的那一次（全局停，见文件头说明）
  useEffect(() => {
    return () => {
      acceptChunksRef.current = false
      clearEndTimer()
      if (startedRef.current) {
        void window.electronAPI?.voice?.sendCommand?.({ type: 'voice:tts:stop-preview' })?.catch(() => {})
      }
      audioCtxRef.current?.close()
      audioCtxRef.current = null
    }
  }, [clearEndTimer])

  return { isSpeaking, busy, speak, stop }
}
