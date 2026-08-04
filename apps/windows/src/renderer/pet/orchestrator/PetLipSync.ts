/**
 * PetLipSync - 口型同步器
 *
 * 设计依据：00-修订版设计 §2.4 / ADR-03（AnalyserNode 取振幅，不引入第二播放器）
 *
 * 每帧从 AudioPlaybackEngine 的 AnalyserNode 取时域数据，计算 RMS 振幅，
 * 归一化后映射到 Live2D 的 ParamMouthOpenY（renderer.setMouthOpen）。
 *
 * 仅 speaking 态轮询（start/stop 由 PetOrchestrator 按语音状态控制），
 * 非 speaking 态停止 rAF，避免无谓计算（性能策略）。
 */

import type { PetRendererProvider } from '../renderer/types'

const log = {
  info: (...args: unknown[]) => console.log('[PetLipSync]', ...args),
}

/** RMS → 嘴开度的增益（经验值，RMS 通常很小，需放大）。上调以让中小音量口型更明显（问题3） */
const RMS_GAIN = 6.0
/**
 * 平滑系数（指数移动平均，越大越平滑但越迟钝）。下调以减少滞后——
 * analyser 侧已有 smoothingTimeConstant，此处再平滑会叠加迟滞，让口型比音频"钝半拍"（问题4）。
 */
const SMOOTHING = 0.25
/**
 * 噪声门（归一化后）：低于此值视为环境底噪/静音，直接归零，避免静音时嘴微抖。
 * 与 SILENCE_MOUTH_EPS 区分：后者用于 drain 收尾判定，此处用于每帧输出整形。
 * 说明：取值偏低——TTS 播放期间正常语音 RMS 常低于旧阈值(0.06)，导致"经常没口型"，
 * 故下调并配合 audioPlaying 保活（低于门限但音频在播时给小幅开口）。
 */
const NOISE_GATE = 0.02
/**
 * 音频播放中但 RMS 低于噪声门时的保活开口幅度：句间弱音/齿音期间给一点点开口，
 * 避免嘴完全闭死造成"没口型"的错觉；有真实音频驱动时会被更大的 RMS 值覆盖。
 */
const AUDIO_PLAYING_KEEPALIVE = 0.1
/**
 * 张口度幂曲线整形指数（<1 为凸曲线）：提升中小音量的可见度，
 * 使小声也能看出在说话、大声趋于饱和，比线性映射更贴近真人嘴幅感知。
 * 下调（更凸）以进一步放大中小音量的张口，配合 RMS_GAIN 让口型幅度更明显（问题3）。
 */
const SHAPE_EXP = 0.6
/**
 * 发声帧最小可见开口：越过噪声门（判定为"正在出声"）时，把整形后的开口重映射到
 * [SPEAKING_MIN_OPEN, 1.0]，保底一个肉眼可辨的张开度并保留 RMS 起伏变化。
 * 实机日志显示中低能量语音段（rms≈0.02~0.06）经整形后 mouth 常只有 0.1~0.3，
 * 在 mao_pro 的 ParamA 上肉眼几乎看不出"在说话"。抬高发声下限后，只要有语音就明显张嘴。
 */
const SPEAKING_MIN_OPEN = 0.45
/** 诊断日志节流间隔（ms） */
const DIAG_LOG_INTERVAL_MS = 1000
/**
 * 收尾无音阈值（computeMouthOpen 归一化后的口开度）：低于此值视为"当前无音频"。
 * finish() 后连续无音超过 SILENCE_HOLD_MS 才判定 TTS 播放真正结束并闭嘴收尾。
 */
const SILENCE_MOUTH_EPS = 0.03
/** finish() 后需连续无音多久才收尾（ms）：略大于 chunk 间的自然间隙，避免句间停顿被误判为结束 */
const SILENCE_HOLD_MS = 450
/**
 * finish() 后的最大兜底 drain 时长（ms）：防止 analyser/探测异常导致口型无法收尾。
 * 上调至 60s——长回复的 TTS 音频可达 20s+（多句串接），旧值 15s 会在音频还剩数秒时
 * 强制闭嘴，造成"口型时长比朗读声音短"（问题2）。正常收尾由 isAudioPlaying + 静音判定负责，
 * 此值仅兜底极端异常。
 */
const MAX_DRAIN_MS = 60_000

export class PetLipSync {
  private analyser: AnalyserNode | null = null
  private buffer: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(0))
  private rafId: number | null = null
  private running = false
  private smoothedValue = 0
  /** analyser 就绪前 start() 被调用，等 analyser 到位后自动启动 */
  private pendingStart = false
  /** 最近一次 setMouthOpen 时间戳，用于可观测延迟 */
  private lastUpdateTs = 0
  /** 诊断：本次循环起始时间 + 上次输出日志时间 */
  private startTs = 0
  private lastDiagTs = 0
  /** 诊断：本帧 computeMouthOpen 读到的归一化前 RMS 原值（日志用，观察声音幅度） */
  private lastRawRms = 0
  /** 诊断：音频首次被探测到"在播"的时间戳（0=尚未），用于计算音频→口型延迟（问题1/4） */
  private firstAudioTs = 0
  /** 诊断：口型首次张开（>SILENCE_MOUTH_EPS）的时间戳（0=尚未），配合 firstAudioTs 算延迟 */
  private firstMouthTs = 0
  /** 诊断：最近一次口型张开的时间戳，用于估算口型累计张开时长（对比朗读时长，问题2） */
  private lastMouthOpenTs = 0
  /**
   * 收尾模式：上游已停止喂 TTS 文本（agent:turn:end），但音频可能仍在播放。
   * 置位后 loop 持续跟随音频振幅，直到检测到连续无音（TTS 真正播完）才闭嘴收尾。
   */
  private draining = false
  /** drain 起始时间（兜底超时用） */
  private drainStartTs = 0
  /** 最近一次"有音频"的时间戳（口开度高于 SILENCE_MOUTH_EPS）：用于判定连续无音时长 */
  private lastVoiceTs = 0
  /**
   * 收尾期是否已听到过音频。TTS 合成有网络延迟（~1s+），而文字生成/turn:end 往往更快，
   * finish() 可能在第一块音频到达前就被调用。若此时直接按"连续静音"判定收尾，会在音频
   * 尚未开始播放时就闭嘴（口型全程不动）。故要求先听到音频，静音超时才允许收尾。
   */
  private heardVoice = false
  /** drain 自然收尾（音频播完）回调，仅收尾时触发一次；硬 stop 不触发 */
  private onDrained: (() => void) | null = null
  /**
   * 音频是否仍在播放的探测闭包（来自 AudioPlaybackEngine.isPlaying）。
   * RMS 低于噪声门但音频仍在播时，给一个保活开口，修复"经常没口型"。
   */
  private audioPlayingProbe: (() => boolean) | null = null

  constructor(private readonly renderer: PetRendererProvider) {}

  /** 绑定"音频是否播放中"探测闭包（startCall 后从 useVoiceCall 拿 isAudioPlaying） */
  setAudioPlayingProbe(probe: (() => boolean) | null): void {
    this.audioPlayingProbe = probe
  }

  /** 绑定播放分析节点（startCall 后从 useVoiceCall 拿到 playbackAnalyserNode）。
   *  若此前 start() 因无 analyser 被挂起，绑定后立即启动循环。 */
  setAnalyser(analyser: AnalyserNode | null): void {
    this.analyser = analyser
    if (analyser) {
      this.buffer = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT))
      if (this.pendingStart) {
        this.pendingStart = false
        log.info('[setAnalyser] analyser 就绪，启动挂起的口型循环')
        this.running = true
        this.startTs = performance.now()
        this.lastDiagTs = this.startTs
        this.resetDiagTimestamps()
        // 若挂起期间上游已 finish（draining 置位），以 analyser 就绪时刻重置收尾计时，
        // 避免用挂起前的旧时间戳立即误判为无音收尾
        if (this.draining) {
          this.drainStartTs = this.startTs
          this.lastVoiceTs = this.startTs
        }
        this.loop()
      }
    }
  }

  /** 开始口型轮询（speaking 态进入时调用）。
   *  analyser 尚未就绪时记录 pendingStart，等 setAnalyser 触发。 */
  start(): void {
    this.draining = false
    this.onDrained = null
    this.heardVoice = false
    if (this.running) return
    if (!this.analyser) {
      log.info('[start] 无 analyser，标记 pendingStart 等待就绪')
      this.pendingStart = true
      return
    }
    this.pendingStart = false
    this.running = true
    this.startTs = performance.now()
    this.lastDiagTs = this.startTs
    this.resetDiagTimestamps()
    log.info('[start] 真音频口型循环启动')
    this.loop()
  }

  /** 重置对齐诊断时间戳（每轮口型循环起始调用），避免沿用上一轮的延迟/时长统计 */
  private resetDiagTimestamps(): void {
    this.firstAudioTs = 0
    this.firstMouthTs = 0
    this.lastMouthOpenTs = 0
    this.lastRawRms = 0
  }

  /**
   * 上游 TTS 文本流结束（agent:turn:end）：音频可能仍在播放。
   * 进入 drain 模式，loop 继续跟随音频振幅，直到检测到连续无音（≥SILENCE_HOLD_MS）
   * 才闭嘴收尾并回调，使口型时长贴合"音频实际播放时长"而非"文本生成时长"。
   * @param onDrained 音频播完自然收尾时回调（编排器据此转待机/冷却）
   */
  finish(onDrained?: () => void): void {
    // 已收尾或从未运行（含 pendingStart 但音频始终未来）：直接回调，交由上游转待机
    if (!this.running && !this.pendingStart) {
      onDrained?.()
      return
    }
    if (this.draining) {
      // 已在收尾中：更新回调，避免丢失
      if (onDrained) this.onDrained = onDrained
      return
    }
    this.draining = true
    this.onDrained = onDrained ?? null
    const now = performance.now()
    this.drainStartTs = now
    this.lastVoiceTs = now
    log.info('[finish] 进入收尾：跟随音频直到播放结束再闭嘴')
  }

  /** 停止口型轮询并归零嘴型（speaking 结束 / 打断时调用） */
  stop(): void {
    const wasRunning = this.running
    this.running = false
    this.pendingStart = false
    this.draining = false
    this.onDrained = null
    this.heardVoice = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (wasRunning) {
      const durMs = Math.round(performance.now() - this.startTs)
      log.info(`[stop] 真音频口型停止，本次持续 ${durMs}ms`)
    }
    this.smoothedValue = 0
    // 交还嘴部控制给动作（清除口型接管标志并归零）；无该实现的后端退化为 setMouthOpen(0)
    if (this.renderer.releaseLipSync) {
      this.renderer.releaseLipSync()
    } else {
      this.renderer.setMouthOpen(0)
    }
  }

  /** 当前是否在运行（rAF 循环已启动） */
  isRunning(): boolean {
    return this.running
  }

  /** analyser 就绪待自动启动（start 已调用但 analyser 尚未绑定） */
  isPendingStart(): boolean {
    return this.pendingStart
  }

  /** 最近一次口型更新延迟（ms），可观测指标 pet_lipsync_latency_ms */
  getLastLatencyMs(): number {
    return this.lastUpdateTs > 0 ? performance.now() - this.lastUpdateTs : 0
  }

  private loop = (): void => {
    if (!this.running || !this.analyser) return

    try {
      const rawRms = this.lastRawRms
      const value = this.computeMouthOpen()
      this.smoothedValue = this.smoothedValue * SMOOTHING + value * (1 - SMOOTHING)
      this.renderer.setMouthOpen(this.smoothedValue)
      this.lastUpdateTs = performance.now()

      const audioPlaying = this.audioPlayingProbe?.() ?? false
      // 对齐诊断：记录"音频首次可听"与"口型首次张开"的时刻，事后可算真实延迟（问题4）。
      if (audioPlaying && this.firstAudioTs === 0) {
        this.firstAudioTs = this.lastUpdateTs
        log.info(
          `[loop] 音频首次可听 @+${(this.firstAudioTs - this.startTs).toFixed(0)}ms（相对口型循环启动）`,
        )
      }
      if (this.smoothedValue > SILENCE_MOUTH_EPS && this.firstMouthTs === 0) {
        this.firstMouthTs = this.lastUpdateTs
        const audioToMouth = this.firstAudioTs > 0 ? this.firstMouthTs - this.firstAudioTs : -1
        log.info(
          `[loop] 口型首次张开 @+${(this.firstMouthTs - this.startTs).toFixed(0)}ms, 音频→口型延迟=${audioToMouth >= 0 ? audioToMouth.toFixed(0) + 'ms' : '(音频未探测到)'}（问题1指标）`,
        )
      }
      if (this.smoothedValue > SILENCE_MOUTH_EPS) this.lastMouthOpenTs = this.lastUpdateTs

      // 节流诊断：每 ~1s 输出对齐关键指标——RMS 原值/增益后口开度/噪声门保活/音频是否在播，
      // 用于比对"口型幅度 vs 声音幅度""口型时长 vs 朗读时长"（问题2/3/4）。
      if (this.lastUpdateTs - this.lastDiagTs >= DIAG_LOG_INTERVAL_MS) {
        const mouthOpenMs = this.firstMouthTs > 0 ? this.lastMouthOpenTs - this.firstMouthTs : 0
        log.info(
          `[loop][对齐] mouth=${this.smoothedValue.toFixed(2)} raw=${value.toFixed(2)} rms=${rawRms.toFixed(3)} gain=${RMS_GAIN} audioPlaying=${audioPlaying} 口型累计张开=${mouthOpenMs.toFixed(0)}ms draining=${this.draining}`,
        )
        this.lastDiagTs = this.lastUpdateTs
      }

      // 收尾模式：跟随音频直到播放真正结束再闭嘴回调。
      // 关键修复（问题2）：以 isAudioPlaying() 为权威信号——只要 AudioPlaybackEngine 仍有音频源
      // 在播（含已调度未播的后续块），就绝不闭嘴，哪怕 RMS 落入句间静音。仅当音频真正停止
      // （所有源播完）后再看连续无音，避免"口型比朗读声音短"（旧逻辑只看 RMS 静音会提前收尾）。
      if (this.draining) {
        const now = this.lastUpdateTs
        if (this.smoothedValue > SILENCE_MOUTH_EPS) {
          this.lastVoiceTs = now
          this.heardVoice = true
        }
        // 音频还在播 → 刷新"最近有音"时间戳，静音计时不推进（等于"音频在播就不收尾"）
        if (audioPlaying) {
          this.lastVoiceTs = now
          this.heardVoice = true
        }
        const silentMs = now - this.lastVoiceTs
        const drainMs = now - this.drainStartTs
        // 只有"已听到过音频"且"音频已停止播放"后，连续无音超阈值才收尾；音频始终未到靠 MAX_DRAIN 兜底。
        const silentDone = this.heardVoice && !audioPlaying && silentMs >= SILENCE_HOLD_MS
        if (silentDone || drainMs >= MAX_DRAIN_MS) {
          const mouthOpenMs = this.firstMouthTs > 0 ? this.lastMouthOpenTs - this.firstMouthTs : 0
          log.info(
            `[loop] 收尾完成 heard=${this.heardVoice} audioPlaying=${audioPlaying} silent=${silentMs.toFixed(0)}ms drain=${drainMs.toFixed(0)}ms 口型总时长=${mouthOpenMs.toFixed(0)}ms → 闭嘴`,
          )
          const cb = this.onDrained
          this.stop()
          cb?.()
          return
        }
      }
    } catch (err) {
      log.info(`[loop] 异常，停止: ${err instanceof Error ? err.message : String(err)}`)
      this.stop()
      return
    }

    this.rafId = requestAnimationFrame(this.loop)
  }

  /** 从 AnalyserNode 取时域 RMS，归一化到 0~1 */
  private computeMouthOpen(): number {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.buffer)
    let sumSquares = 0
    for (let i = 0; i < this.buffer.length; i++) {
      const v = this.buffer[i]
      sumSquares += v * v
    }
    const rms = Math.sqrt(sumSquares / this.buffer.length)
    this.lastRawRms = rms
    let v = Math.max(0, Math.min(1, rms * RMS_GAIN))
    // 噪声门：抑制静音底噪抖动（配合 speaking 态无条件覆写，静音间隙嘴稳定闭合）。
    // 关键修复：音频仍在播放（句间弱音/齿音/网络间隙）时，低于门限也给一点保活开口，
    // 避免嘴完全闭死造成"经常没口型"的错觉。真实音频到来时会被更大 RMS 覆盖。
    if (v < NOISE_GATE) {
      const audioPlaying = this.audioPlayingProbe?.() ?? false
      return audioPlaying ? AUDIO_PLAYING_KEEPALIVE : 0
    }
    // 幂曲线整形：凸显中小音量，避免线性映射下"嘴不够张"
    v = Math.pow(v, SHAPE_EXP)
    // 发声帧保底可见开口：越过噪声门即判定"正在出声"，把整形后的开口重映射到
    // [SPEAKING_MIN_OPEN, 1.0]，保底一个肉眼可辨的张开度并保留 RMS 起伏的张合变化。
    // 修复实机观察："中间/结尾没口型"——中低能量语音段(rms≈0.02~0.06)经整形后
    // mouth 常只有 0.1~0.3，在 mao_pro 的 ParamA 上肉眼几乎看不出在说话。
    v = SPEAKING_MIN_OPEN + v * (1 - SPEAKING_MIN_OPEN)
    return v
  }

  dispose(): void {
    this.stop()
    this.analyser = null
    this.pendingStart = false
  }
}
