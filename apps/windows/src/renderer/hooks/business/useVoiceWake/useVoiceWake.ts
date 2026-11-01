/**
 * 语音唤醒采集（渲染层）。
 *
 * 麦克风只有渲染层拿得到，所以这里负责：开麦 → AudioWorklet 分帧 → 以固定
 * `__wake__` callId 推给主进程；判定在主进程（`voice-wake-hub.ts`）。
 *
 * ## 什么时候停
 *
 * - 用户关掉唤醒开关
 * - 进入通话（主进程会推 `voice:wake:state{active:false}`，通话本身还要用麦克风）
 * - 进宠物模式并且已经在对话（宠物窗口有自己的通话，同样占麦）
 *
 * 这些都用同一条 `voice:wake:state` 事件归一，下发方只有主进程一处，
 * 免得渲染层自己再判一套状态导致两边不一致。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadAudioWorkletModule } from '../useVoiceCall/load-audio-worklet.js'
import { loadCaptureConfig, micConstraints } from '../useVoiceCall/capture-constraints.js'
import pcmProcessorSource from '../useVoiceCall/worklets/pcm-processor.js?raw'

/** 与主进程 voice-ipc.ts 的 WAKE_CALL_ID 保持一致 */
const WAKE_CALL_ID = '__wake__'

const log = {
  info: (...args: unknown[]) => console.log('[voice-wake]', ...args),
  warn: (...args: unknown[]) => console.warn('[voice-wake]', ...args),
  error: (...args: unknown[]) => console.error('[voice-wake]', ...args),
}

export interface VoiceWakeState {
  /** 监听是否真的在跑（含麦克风已开） */
  listening: boolean
  /** 最近一次错误（权限被拒 / 引擎不可用） */
  error: string | null
  /** 最近一次命中（供 UI 闪一下"被叫醒了"） */
  lastHitAt: number
}

/**
 * 挂一次就够：它自己读配置、自己开麦、自己跟着主进程的 state 事件起停。
 * 组件里当纯副作用用（返回值给状态条用）。
 */
export function useVoiceWake(): VoiceWakeState {
  const [state, setState] = useState<VoiceWakeState>({ listening: false, error: null, lastHitAt: 0 })

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const startingRef = useRef(false)

  const stopCapture = useCallback(() => {
    try { nodeRef.current?.disconnect() } catch { /* 已断开 */ }
    nodeRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
    setState((s) => (s.listening ? { ...s, listening: false } : s))
  }, [])

  const startCapture = useCallback(async () => {
    if (startingRef.current || nodeRef.current) return
    startingRef.current = true
    try {
      const electronAPI = (window as any).electronAPI
      if (!electronAPI?.voice?.sendCommand) return

      // 先问主进程能不能听（配置关着 / 通话中都会拒绝）——别白开一次麦克风
      const res = (await electronAPI.voice.sendCommand({ type: 'voice:wake:attach' })) as
        | { ok?: boolean; reason?: string }
        | undefined
      if (!res?.ok) {
        log.info(`唤醒未启动：${res?.reason ?? '未知原因'}`)
        setState((s) => ({ ...s, listening: false }))
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia(
        micConstraints(await loadCaptureConfig()),
      )
      streamRef.current = stream

      const ctx = new AudioContext()
      ctxRef.current = ctx
      if (ctx.state === 'suspended') await ctx.resume()

      await loadAudioWorkletModule(ctx, pcmProcessorSource)
      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'pcm-processor')
      nodeRef.current = node
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        // 通话断了/停了采集时 node 已被置空，这里再判一次避免半开状态
        if (!nodeRef.current) return
        electronAPI.voice.sendAudioChunk(WAKE_CALL_ID, e.data)
      }
      source.connect(node)
      // 不连 destination：只听不发，避免自激

      setState((s) => ({ ...s, listening: true, error: null }))
      log.info('唤醒监听已启动')
    } catch (e) {
      const msg = (e as Error).message
      log.warn(`唤醒监听启动失败: ${msg}`)
      stopCapture()
      setState((s) => ({
        ...s,
        listening: false,
        error: msg.includes('Permission') ? '麦克风权限被拒绝，无法监听唤醒词' : msg,
      }))
    } finally {
      startingRef.current = false
    }
  }, [stopCapture])

  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.onEvent) return

    // 起停由主进程的 state 事件统一下发：配置变更、通话开始/结束都由它在源头判定，
    // 渲染层只跟随，避免两边各判一套。
    const unsubscribe = electronAPI.voice.onEvent((event: any) => {
      if (event.type === 'voice:wake:state') {
        log.info(`唤醒状态: active=${event.active}${event.reason ? ` reason=${event.reason}` : ''}`)
        if (event.active) void startCapture()
        else stopCapture()
        return
      }
      if (event.type === 'voice:wake:detected') {
        setState((s) => ({ ...s, lastHitAt: event.timestamp ?? Date.now() }))
        // 命中后主进程会 suppress：麦克风要让给宠物通话，这里立刻收手
        stopCapture()
      }
    })

    // 挂载时对齐一次：主进程可能已经因为配置开启而处于 listening
    void electronAPI.voice
      .sendCommand({ type: 'voice:wake:status' })
      .then((r: { active?: boolean } | undefined) => {
        if (r?.active) void startCapture()
      })
      .catch(() => {})

    return () => {
      unsubscribe?.()
      stopCapture()
      // 页面卸载时让主进程也别再等帧
      void electronAPI.voice.sendCommand({ type: 'voice:wake:detach' }).catch(() => {})
    }
  }, [startCapture, stopCapture])

  return state
}
