/**
 * ASR 实时识别测试面板（设置页）
 * 采麦推送 PCM，订阅 voice:transcript 展示中间/最终结果。
 * 仅用户点击「开始 ASR 测试」后开麦；测试中显示麦克风音量。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { loadAudioWorkletModule } from '../../../../hooks/business/useVoiceCall/load-audio-worklet'
import { pcmProcessorSource } from '../../../../hooks/business/useVoiceCall/worklets/pcm-processor-source'
import styles from './AsrLiveTestPanel.module.css'

/**
 * 将 AnalyserNode 时域数据映射为 0–100 音量
 */
function computeVolumeLevel(analyser: AnalyserNode): number {
  const buf = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / buf.length)
  return Math.min(100, Math.round(rms * 280))
}

/**
 * 设置页内 ASR 流式识别试麦
 */
export function AsrLiveTestPanel(): React.ReactElement {
  const [running, setRunning] = useState(false)
  const [partial, setPartial] = useState('')
  const [finals, setFinals] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [callState, setCallState] = useState<string>('idle')
  const [asrReady, setAsrReady] = useState(false)
  const [vadReady, setVadReady] = useState(false)
  /** 是否曾成功启动过测试（用于按钮文案「重新开始」） */
  const [hasStartedOnce, setHasStartedOnce] = useState(false)
  /** 麦克风音量 0–100，仅测试中更新 */
  const [micLevel, setMicLevel] = useState(0)

  const callIdRef = useRef<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const startingRef = useRef(false)

  /**
   * 刷新 VAD/ASR 就绪状态
   */
  const refreshReady = useCallback(async () => {
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    const list = await api.voice.sendCommand({ type: 'voice:models:get' })
    if (!Array.isArray(list)) return
    setVadReady(Boolean(list.find((m: any) => m.id === 'vad')?.downloaded))
    setAsrReady(Boolean(list.find((m: any) => m.id === 'asr-paraformer-zh')?.downloaded))
  }, [])

  useEffect(() => {
    void refreshReady()
    const api = (window as any).electronAPI
    if (!api?.voice?.onEvent) return
    const unsub = api.voice.onEvent((event: any) => {
      if (event.type === 'voice:models:status' || event.type === 'voice:models:progress') {
        void refreshReady()
        return
      }
      if (!callIdRef.current) return
      if (event.callId && event.callId !== callIdRef.current) return
      if (event.type === 'voice:transcript') {
        if (event.isFinal) {
          setFinals((prev) => [...prev, event.text].slice(-8))
          setPartial('')
        } else {
          setPartial(event.text)
        }
      }
      if (event.type === 'voice:call:state') {
        setCallState(event.state)
      }
      if (event.type === 'voice:call:ended' && event.callId === callIdRef.current) {
        callIdRef.current = null
        setRunning(false)
        setCallState('idle')
      }
      if (event.type === 'voice:error') {
        setError(event.message ?? '识别出错')
      }
    })
    return () => {
      if (typeof unsub === 'function') unsub()
    }
  }, [refreshReady])

  /**
   * 停止音量 RAF 轮询
   */
  const stopVolumeMeter = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    analyserRef.current = null
    setMicLevel(0)
  }, [])

  /**
   * 启动音量 RAF 轮询
   */
  const startVolumeMeter = useCallback((analyser: AnalyserNode) => {
    analyserRef.current = analyser
    const tick = () => {
      if (!analyserRef.current) return
      setMicLevel(computeVolumeLevel(analyserRef.current))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const stopCapture = useCallback(async () => {
    stopVolumeMeter()
    workletRef.current?.port.close()
    workletRef.current?.disconnect()
    workletRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioCtxRef.current) {
      await audioCtxRef.current.close().catch(() => undefined)
      audioCtxRef.current = null
    }
  }, [stopVolumeMeter])

  const stop = useCallback(async () => {
    const api = (window as any).electronAPI
    await stopCapture()
    if (api?.voice?.sendCommand) {
      await api.voice.sendCommand({ type: 'voice:asr:test:stop' }).catch(() => undefined)
    }
    callIdRef.current = null
    startingRef.current = false
    setRunning(false)
    setCallState('idle')
  }, [stopCapture])

  useEffect(() => {
    return () => {
      void stop()
    }
  }, [stop])

  /**
   * 启动 ASR 测试（采麦 + 主进程识别会话 + 音量监测）
   */
  const start = useCallback(async () => {
    if (startingRef.current || callIdRef.current) return
    startingRef.current = true
    setError(null)
    setPartial('')
    setFinals([])
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) {
      setError('语音 API 不可用')
      startingRef.current = false
      return
    }

    try {
      const result = await api.voice.sendCommand({ type: 'voice:asr:test:start' })
      if (result?.error === 'models_not_ready') {
        setError('请先下载 VAD 与 ASR 模型')
        return
      }
      if (result?.error) {
        setError(String(result.error))
        return
      }

      const callId = result?.callId as string
      callIdRef.current = callId

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      streamRef.current = stream

      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      if (audioCtx.state === 'suspended') await audioCtx.resume()

      await loadAudioWorkletModule(audioCtx, pcmProcessorSource)
      const source = audioCtx.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(audioCtx, 'pcm-processor')
      workletRef.current = worklet
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (callIdRef.current) {
          api.voice.sendAudioChunk(callIdRef.current, e.data)
        }
      }

      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.7
      source.connect(analyser)
      source.connect(worklet)
      startVolumeMeter(analyser)

      setHasStartedOnce(true)
      setRunning(true)
      setCallState('listening')
    } catch (e) {
      setError((e as Error).message || '无法访问麦克风')
      await api.voice.sendCommand({ type: 'voice:asr:test:stop' }).catch(() => undefined)
      callIdRef.current = null
      await stopCapture()
    } finally {
      startingRef.current = false
    }
  }, [startVolumeMeter, stopCapture])

  const ready = asrReady && vadReady

  return (
    <div className={styles.panel}>
      <h4 className={styles.title}>ASR 识别测试</h4>
      <p className={styles.hint}>
        点击「开始 ASR 测试」后才会开麦识别。测试中可查看麦克风音量，确认是否正常收音；说话时显示中间结果，停顿后给出最终句子。
      </p>
      {!ready && (
        <p className={styles.warn}>
          {!vadReady && !asrReady
            ? '请先下载 Silero VAD 与 Paraformer ASR'
            : !vadReady
              ? '请先下载 Silero VAD'
              : '请先下载 Paraformer ASR'}
        </p>
      )}
      <div className={styles.toolbar}>
        {!running ? (
          <Button variant="primary" size="sm" disabled={!ready} onClick={() => void start()}>
            {hasStartedOnce ? '重新开始' : '开始 ASR 测试'}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => void stop()}>
            停止
          </Button>
        )}
        {running && (
          <span className={styles.state}>
            {callState === 'recognizing' ? '识别中…' : '聆听中…'}
          </span>
        )}
      </div>
      {running && (
        <div className={styles.volumeRow} aria-label="麦克风音量">
          <span className={styles.volumeLabel}>麦克风</span>
          <div className={styles.volumeBarTrack}>
            <div
              className={styles.volumeBarFill}
              style={{ width: `${micLevel}%` }}
              data-level={micLevel > 40 ? 'high' : micLevel > 8 ? 'mid' : 'low'}
            />
          </div>
          <span className={styles.volumeValue}>{micLevel}</span>
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.transcript}>
        {finals.map((t, i) => (
          <div key={`${i}-${t.slice(0, 12)}`} className={styles.finalLine}>
            {t}
          </div>
        ))}
        {partial && <div className={styles.partialLine}>{partial}</div>}
        {!partial && finals.length === 0 && (
          <div className={styles.placeholder}>
            {running
              ? '请对着麦克风说话…'
              : ready
                ? '点击上方按钮开始测试'
                : '请先下载模型'}
          </div>
        )}
      </div>
    </div>
  )
}

export default AsrLiveTestPanel
