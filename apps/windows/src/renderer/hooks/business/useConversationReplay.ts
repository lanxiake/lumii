/**
 * 对话回放 Hook
 * 从指定消息开始，依序通过 TTS 朗读用户和 Agent 消息
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import type { ChatMessage } from './useChat/useChat.types'

export interface ConversationReplayState {
  isReplaying: boolean
  replayMessageId: string | null
}

export interface ConversationReplayActions {
  startReplay: (fromMessageId: string, messages: readonly ChatMessage[]) => void
  stopReplay: () => void
}

export function useConversationReplay(): ConversationReplayState & ConversationReplayActions {
  const [isReplaying, setIsReplaying] = useState(false)
  const [replayMessageId, setReplayMessageId] = useState<string | null>(null)

  // 当前正在回放的 AudioContext
  const audioCtxRef = useRef<AudioContext | null>(null)
  const nextPlayTimeRef = useRef<number>(0)
  const abortRef = useRef<boolean>(false)
  // 当前朗读会话标识：只播放本会话发起的 chunk，隔离设置页试听等其它来源
  const previewIdRef = useRef<string | null>(null)

  // 等待当前消息音频播放完毕的 resolve 函数
  const audioFinishedRef = useRef<(() => void) | null>(null)

  // 订阅 voice:tts:preview:chunk 事件
  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.onEvent) return

    const unsubscribe = electronAPI.voice.onEvent((event: any) => {
      if (!isReplaying) return

      if (event.type === 'voice:tts:preview:chunk') {
        // 只处理本朗读会话的 chunk，丢弃设置页试听等其它来源，避免串流
        if (previewIdRef.current && event.previewId !== previewIdRef.current) return
        const ctx = audioCtxRef.current
        if (!ctx) return

        if (event.sampleRate === -1) {
          // Edge TTS mp3
          void (async () => {
            try {
              const buffer = new Uint8Array(event.samples).buffer
              const decoded = await ctx.decodeAudioData(buffer)
              const source = ctx.createBufferSource()
              source.buffer = decoded
              source.connect(ctx.destination)
              const startAt = Math.max(nextPlayTimeRef.current, ctx.currentTime)
              source.start(startAt)
              nextPlayTimeRef.current = startAt + decoded.duration
              if (event.isFinal) {
                // 等待最后一个 chunk 播放完毕再继续
                const playDuration = (nextPlayTimeRef.current - ctx.currentTime) * 1000
                setTimeout(() => {
                  audioFinishedRef.current?.()
                  audioFinishedRef.current = null
                }, Math.max(playDuration, 0) + 100)
              }
            } catch {
              audioFinishedRef.current?.()
              audioFinishedRef.current = null
            }
          })()
        } else {
          // VITS PCM
          try {
            // event.samples 的类型宽于 Float32Array<ArrayBuffer>（IPC 反序列化后可能是
            // Float32Array<ArrayBufferLike> 视图或 number[]），copyToChannel 要求具体
            // ArrayBuffer 支撑，两种输入都统一走 new Float32Array(...) 以获得新的具体缓冲区
            const samples = new Float32Array(event.samples)
            const sampleRate: number = event.sampleRate > 0 ? event.sampleRate : 22050
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
            if (event.isFinal) {
              const playDuration = (nextPlayTimeRef.current - ctx.currentTime) * 1000
              setTimeout(() => {
                audioFinishedRef.current?.()
                audioFinishedRef.current = null
              }, Math.max(playDuration, 0) + 100)
            }
          } catch {
            audioFinishedRef.current?.()
            audioFinishedRef.current = null
          }
        }
      }
    })

    return unsubscribe
  }, [isReplaying])

  const stopReplay = useCallback(() => {
    abortRef.current = true
    previewIdRef.current = null
    setIsReplaying(false)
    setReplayMessageId(null)
    audioFinishedRef.current?.()
    audioFinishedRef.current = null
    const electronAPI = (window as any).electronAPI
    electronAPI?.voice?.sendCommand({ type: 'voice:tts:stop-preview' }).catch(() => {})
    audioCtxRef.current?.suspend()
  }, [])

  const startReplay = useCallback(async (fromMessageId: string, messages: readonly ChatMessage[]) => {
    // 停止已有回放
    abortRef.current = true
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.sendCommand) return
    await electronAPI.voice.sendCommand({ type: 'voice:tts:stop-preview' }).catch(() => {})

    // 初始化 AudioContext
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext({ sampleRate: 22050 })
    }
    if (audioCtxRef.current.state === 'suspended') {
      await audioCtxRef.current.resume()
    }
    nextPlayTimeRef.current = audioCtxRef.current.currentTime

    // 找起始消息索引
    const fromIndex = messages.findIndex((m) => m.id === fromMessageId)
    if (fromIndex < 0) return

    abortRef.current = false
    setIsReplaying(true)
    setReplayMessageId(fromMessageId)

    for (let i = fromIndex; i < messages.length; i++) {
      if (abortRef.current) break
      const msg = messages[i]
      // 只朗读 user 和 assistant 消息
      if (msg.role !== 'user' && msg.role !== 'assistant') continue
      if (!msg.content) continue

      setReplayMessageId(msg.id)

      // 每条消息一个 previewId，主进程会原样带回 chunk，事件处理据此过滤
      const previewId = `replay-${msg.id}-${Date.now()}`
      previewIdRef.current = previewId
      nextPlayTimeRef.current = audioCtxRef.current?.currentTime ?? 0

      // 等待当前消息音频播放完毕
      await new Promise<void>((resolve) => {
        if (abortRef.current) { resolve(); return }
        audioFinishedRef.current = resolve
        electronAPI.voice.sendCommand({
          type: 'voice:tts:preview',
          text: msg.content,
          maxChars: 8000,
          previewId,
        }).catch(() => {
          resolve()
        })
      })

      if (abortRef.current) break
      // 消息间短暂停顿
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
    }

    if (!abortRef.current) {
      setIsReplaying(false)
      setReplayMessageId(null)
    }
  }, [])

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      abortRef.current = true
      const electronAPI = (window as any).electronAPI
      electronAPI?.voice?.sendCommand({ type: 'voice:tts:stop-preview' }).catch(() => {})
      audioCtxRef.current?.close()
    }
  }, [])

  return { isReplaying, replayMessageId, startReplay, stopReplay }
}
