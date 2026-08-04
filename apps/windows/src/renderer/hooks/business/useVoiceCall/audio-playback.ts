/**
 * 音频播放引擎
 * 基于 Web Audio API AudioBufferSourceNode 链式时间调度
 * 实现多段 TTS 音频无缝连续播放
 */

export class AudioPlaybackEngine {
  private nextStartTime = 0
  private activeSources: AudioBufferSourceNode[] = []
  private idleCallback: (() => void) | null = null
  private gainNode: GainNode
  /** 口型分析节点（懒创建，挂在 gainNode 后，只读不影响播放） */
  private analyserNode: AnalyserNode | null = null
  /**
   * 逐字边界事件队列（按 AudioContext 时间升序）。
   * 每个元素是 AudioContext 秒数，表示该时刻应触发一次口型脉冲（一字一合）。
   * 由 pollCharEvents(now) 消费，now 取 audioCtx.currentTime。
   */
  private charEvents: number[] = []
  /** 首次调度时间戳，用作进度基准（AudioContext 秒） */
  private firstScheduleTime = 0
  /** 累计已调度音频总时长 */
  private totalScheduledDuration = 0
  /** 累计已调度字符数（用于 Lab 诊断） */
  private totalScheduledChars = 0

  constructor(private audioCtx: AudioContext) {
    this.gainNode = audioCtx.createGain()
    this.gainNode.gain.value = 0.8
    this.gainNode.connect(audioCtx.destination)
  }

  /** 设置播放音量（0.0 ~ 1.0） */
  setVolume(value: number): void {
    this.gainNode.gain.value = Math.max(0, Math.min(1, value))
  }

  get volume(): number {
    return this.gainNode.gain.value
  }

  /**
   * 获取口型分析节点（懒创建）。
   * 在 gainNode 后挂一个 AnalyserNode 做实时振幅分析，供宠物口型同步使用。
   * 只读旁路，不串入播放主链路（gainNode→destination 不变），不影响 TTS 播放。
   * VITS（PCM）与 Edge（解码后）两种 TTS 都经 gainNode 输出，天然统一。
   */
  getAnalyserNode(): AnalyserNode {
    if (!this.analyserNode) {
      const analyser = this.audioCtx.createAnalyser()
      analyser.fftSize = 1024
      // 下调平滑常数（0.5→0.3）：与 PetLipSync 侧的 SMOOTHING 叠加会累积迟滞，让口型比音频"钝半拍"。
      // 收紧此处使 analyser 更快跟随音频包络，减少口型渲染滞后（问题4）。
      analyser.smoothingTimeConstant = 0.3
      // gainNode 已连 destination；此处再并联到 analyser（旁路，不改变播放）
      this.gainNode.connect(analyser)
      this.analyserNode = analyser
    }
    return this.analyserNode
  }

  /**
   * 将一段音频加入播放队列，无缝接在上一段之后。
   * @param text 本段音频对应的清洁文字（用于计算逐字口型脉冲间隔）；
   *   传入空字符串或不传则跳过逐字事件调度（兼容旧调用路径）。
   */
  enqueue(samples: Float32Array, sampleRate: number, isFinal: boolean, text?: string): void {
    if (samples.length === 0) return

    try {
      // 确保 AudioContext 处于运行态（透明窗口可能被浏览器策略自动暂停）
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch((e) =>
          console.warn('[AudioPlaybackEngine] resume 失败:', e),
        )
      }
      const buffer = this.audioCtx.createBuffer(1, samples.length, sampleRate)
      buffer.copyToChannel(new Float32Array(samples), 0)

      const source = this.audioCtx.createBufferSource()
      source.buffer = buffer
      source.connect(this.gainNode)

      // 链式调度：每段接在上一段结束时播放，预缓冲 40ms 避免断音
      const now = this.audioCtx.currentTime
      const startTime = Math.max(now + 0.04, this.nextStartTime)
      source.start(startTime)
      this.nextStartTime = startTime + buffer.duration

      // 逐字边界事件：根据文字长度 + 音频时长，在 AudioContext 时间线上排布
      if (text && text.length > 0) {
        if (this.firstScheduleTime === 0) this.firstScheduleTime = startTime
        const perChar = buffer.duration / text.length
        for (let i = 0; i < text.length; i++) {
          this.charEvents.push(startTime + (i + 0.5) * perChar) // 每字中点触发脉冲
        }
        this.totalScheduledDuration = Math.max(
          this.totalScheduledDuration,
          startTime + buffer.duration - this.firstScheduleTime,
        )
        this.totalScheduledChars += text.length
        // 保持时间升序（跨句子可能因异步合成打乱顺序）
        this.charEvents.sort((a, b) => a - b)
        console.log(
          `[AudioPlaybackEngine] enqueue text="${text}" len=${text.length} dur=${buffer.duration.toFixed(2)}s startTime=${startTime.toFixed(2)} charEvents[0]=${this.charEvents[0]?.toFixed(2)} charEvents[last]=${this.charEvents[this.charEvents.length - 1]?.toFixed(2)}`,
        )
      }

      this.activeSources.push(source)
      source.addEventListener('ended', () => {
        this.activeSources = this.activeSources.filter((s) => s !== source)
        // 所有音频播放完毕，触发 idle 回调
        if (this.activeSources.length === 0 && this.idleCallback) {
          const cb = this.idleCallback
          this.idleCallback = null
          cb()
        }
      })
    } catch (e) {
      console.warn('[AudioPlaybackEngine] enqueue 失败:', e)
    }
  }

  /**
   * 注册一个回调，在所有已入队音频播放完毕时触发（一次性）
   * 若当前无音频在播放，立即触发
   */
  onIdle(callback: () => void): void {
    if (this.activeSources.length === 0) {
      callback()
    } else {
      this.idleCallback = callback
    }
  }

  /**
   * 打断时清空所有待播放/正在播放的音频
   */
  flush(): void {
    this.idleCallback = null // 清除待触发的 idle 回调
    this.charEvents = []
    this.firstScheduleTime = 0
    this.totalScheduledDuration = 0
    this.totalScheduledChars = 0
    for (const source of this.activeSources) {
      try { source.stop() } catch { /* 已停止 */ }
      try { source.disconnect() } catch { /* 已断开 */ }
    }
    this.activeSources = []
    this.nextStartTime = 0
  }

  destroy(): void {
    this.flush()
    if (this.analyserNode) {
      try { this.analyserNode.disconnect() } catch { /* 已断开 */ }
      this.analyserNode = null
    }
    this.gainNode.disconnect()
  }

  /** 当前是否有音频在播放 */
  isPlaying(): boolean {
    return this.activeSources.length > 0
  }

  /**
   * 消费逐字边界事件：弹出所有不晚于 now（AudioContext 秒）的事件，返回弹出数量。
   * 口型循环每帧用 audioCtx.currentTime 调用一次，每弹出一字触发一次口型脉冲（一字一合）。
   */
  pollCharEvents(now: number): number {
    let count = 0
    while (this.charEvents.length > 0 && this.charEvents[0]! <= now) {
      this.charEvents.shift()
      count++
    }
    return count
  }

  /** 诊断：当前排队的逐字事件数 + 首个事件时间 */
  getCharEventsDiag(): { queued: number; firstAt: number | null; totalScheduledChars: number } {
    return {
      queued: this.charEvents.length,
      firstAt: this.charEvents[0] ?? null,
      totalScheduledChars: this.totalScheduledChars,
    }
  }

  /** 已调度音频总时长（AudioContext 秒），供估算播放进度 */
  getTotalScheduledDuration(): number {
    return this.totalScheduledDuration
  }

  /** 已调度字符总数，供 Lab 诊断比对 injected vs scheduled */
  getTotalScheduledChars(): number {
    return this.totalScheduledChars
  }

  /** 首次调度时间（AudioContext 秒），0 表示尚无音频入队 */
  getFirstScheduleTime(): number {
    return this.firstScheduleTime
  }
}
