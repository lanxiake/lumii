/**
 * PetFakeLipSync - 伪口型同步器（无音频源）
 *
 * 方向 A（活跃保活 + 连续正弦）：口型跟着"是否还在喂字"走，而非固定内部时钟。
 *   - notifyTextActivity(n) 把"活跃截止时间"往后推 ACTIVE_HOLD_MS（喂字期间持续续期）
 *   - loop：now < activeUntil → 能量拉满，用连续多正弦合成自然张合（旧版好看的波形）
 *   - 喂字停顿超过 ACTIVE_HOLD_MS 或 finish 后 → 能量平滑衰减闭嘴
 *   - finish() 后能量衰减到阈值即自停并回调 onDrained
 *   - stop() 为硬停（打断/错误），立即归零
 *
 * 这样滑块无论多快多慢，只要还在喂字口型就连续起伏，喂完才收尾，
 * 不再出现"开头动几下后面闭嘴"的死区。
 *
 * 与 PetLipSync（真音频 RMS 驱动）二选一，互不并存。
 */

import type { PetRendererProvider } from '../renderer/types'

const log = {
  info: (...args: unknown[]) => console.log('[PetFakeLipSync]', ...args),
}

/** 基础张合频率（Hz）——每秒约开合 3.5 次，接近自然语速 */
const BASE_FREQ_HZ = 3.5
/** 叠加的次谐波频率（Hz），让节奏不机械 */
const SUB_FREQ_HZ = 7.0
/** 平滑系数（指数移动平均，与真口型一致的手感） */
const SMOOTHING = 0.5
/** 能量衰减比例（每秒），喂字停顿/finish 后平滑收尾闭嘴 */
const ENERGY_DECAY_PER_SEC = 0.85
/** 收尾阈值：finish 后能量低于此值即自停 */
const TAIL_ENERGY_EPS = 0.05
/**
 * 活跃保活时长（ms）：每次喂字把活跃截止时间续到 now+此值。
 * 需 ≥ 最慢喂字间隔（Lab 滑块最大 400ms/块），留足余量取 500ms，
 * 保证喂字期间口型连续起伏，不会在 chunk 间隙掉下去。
 */
const ACTIVE_HOLD_MS = 500
/**
 * 已读进度推进语速（字/秒）：纯文字（无 TTS）时，卡拉OK高亮与"读到位置再播动作"
 * 靠此节奏把"已读字符数"随时间向"已注入字符数"追进，而非喂字瞬间跳到末尾。
 * ~6 字/秒接近中文自然朗读语速；上限永远不超过已注入进度（不会读到还没喂的字）。
 */
const READING_CHARS_PER_SEC = 6

export class PetFakeLipSync {
  private rafId: number | null = null
  private running = false
  private startTs = 0
  private smoothedValue = 0
  private lastFrameTs = 0
  /** 文字驱动模式：true=活跃保活正弦；false=旧静态匀速（兼容未接线场景） */
  private textDriven = false
  /** 活跃截止时间戳（performance.now 基准）：now < 此值 → 视为仍在说话 */
  private activeUntil = 0
  /** 本轮累计注入字符数（喂字上界，已读进度不会超过它） */
  private totalInjected = 0
  /** 已读字符进度（浮点累加，按语速随时间向 totalInjected 追进）；上报时取整 */
  private readChars = 0
  /** 最近一次上报的已读整数字符数（去抖，避免同一整数重复上报） */
  private lastReportedRead = -1
  /** 朗读进度回调：loop 按语速推进已读字符数时上报（非喂字瞬间） */
  private onProgress: ((charsRead: number) => void) | null = null
  /** 上游已停止喂字（finish 调用）：能量衰减完即自停 */
  private inputEnded = false
  /** 自然收尾回调（finish 注册，硬 stop 不触发） */
  private onDrained: (() => void) | null = null
  /** 当前张合能量 0~1：活跃期维持 1，停顿后衰减 */
  private energy = 0
  /**
   * 静默进度模式：切到真音频口型后，嘴由 PetLipSync 跟随 TTS 振幅驱动，
   * 但卡拉OK高亮/动作对齐仍需按语速推进已读进度。此时循环继续跑（只推进进度、
   * 不写 setMouthOpen），避免抢夺真口型对嘴的控制。
   */
  private progressOnly = false
  /**
   * 逐字脉冲口型模式：由 AudioPlaybackEngine 的逐字边界事件驱动，
   * 每弹出一字触发一次口型张合脉冲（一字一合），时长对齐 AudioContext 时钟。
   * 替代 RMS 连续振幅方案，提供更稳定的"一个字一个口型动作"。
   */
  private audioCharPulse = false
  /** 消费 AudioPlaybackEngine.pollCharEvents(audioCtx.currentTime) 的闭包 */
  private pollCharEvents: (() => number) | null = null
  /**
   * 探测音频是否仍在播放（含已调度未播的后续块）的闭包。收尾判定据此改为"音频真正播完"，
   * 而非"逐字事件静默 500ms"——后者在 TTS 合成断流（事件出现间隙）时会误判提前闭嘴。
   */
  private isAudioPlaying: (() => boolean) | null = null
  /** 脉冲能量 0~N：每弹出一字 +1，每帧衰减，驱动 setMouthOpen */
  private pulseEnergy = 0
  /** 脉冲衰减时间常数（/秒）：约 100ms 从 1 衰减到 ~0.1，一字一合 */
  private static readonly PULSE_DECAY_PER_SEC = 22
  /** audioCharPulse 收尾中：finish() 后等待脉冲耗尽自动收尾 */
  private audioCharDraining = false
  /** audioCharPulse 收尾连续无脉冲帧计数（用于判定脉冲耗尽） */
  private audioCharDrainSilentFrames = 0
  /**
   * 收尾期/逐字脉冲是否已收到过至少一次脉冲。TTS 合成有网络延迟（~1s+），
   * finish() 可能在第一块音频到达前就被调用。若直接按"无脉冲"判定收尾，
   * 会在音频尚未播放时提前闭嘴（口型全程不动）。故要求先收到脉冲，才允许
   * 收尾判定生效。
   */
  private heardPulse = false

  constructor(private readonly renderer: PetRendererProvider) {}

  setOnProgress(handler: ((charsRead: number) => void) | null): void {
    this.onProgress = handler
  }

  /**
   * 切到「只推进已读进度、不驱动嘴」模式（真音频口型接管嘴时用）。
   * 循环继续按语速追进 readChars → 上报 onProgress，供卡拉OK高亮/动作对齐，
   * 但不再调用 renderer.setMouthOpen，把嘴让给 PetLipSync。
   * 若循环未在跑（尚无喂字），先以文字驱动方式启动，保证进度能推进。
   */
  enterProgressOnly(): void {
    if (!this.running) {
      this.beginLoop(true)
    }
    // beginLoop→resetTextState 会把 progressOnly 复位，故在其后置位
    this.progressOnly = true
  }

  /**
   * 切到「逐字脉冲口型」模式（TTS 真音频播放时用）。
   * 循环每帧消费 audioPlaybackEngine 的逐字边界事件，每弹出一字触发一次口型脉冲
   * （一字一合），脉冲时长对齐 AudioContext 时钟，不再依赖 AnalyserNode RMS。
   * @param pollFn 闭包 () => audioPlaybackEngine.pollCharEvents(audioCtx.currentTime)
   * @param isAudioPlayingFn 闭包 () => audioPlaybackEngine.isPlaying()，收尾判定用（音频播完才闭嘴）
   */
  enterAudioCharPulse(pollFn: () => number, isAudioPlayingFn?: () => boolean): void {
    if (!this.running) {
      this.beginLoop(true)
    }
    // beginLoop→resetTextState 会复位状态，故在其后置位
    this.audioCharPulse = true
    this.progressOnly = false
    this.pollCharEvents = pollFn
    this.isAudioPlaying = isAudioPlayingFn ?? null
    this.pulseEnergy = 0
  }

  start(): void {
    this.beginLoop(false)
  }

  startTextDriven(): void {
    this.beginLoop(true)
  }

  /** 重置一轮文字驱动的所有状态（新一轮开始时用） */
  private resetTextState(): void {
    this.textDriven = true
    this.activeUntil = 0
    this.totalInjected = 0
    this.readChars = 0
    this.lastReportedRead = -1
    this.inputEnded = false
    this.onDrained = null
    this.energy = 0
    this.progressOnly = false
    this.audioCharPulse = false
    this.pollCharEvents = null
    this.isAudioPlaying = null
    this.pulseEnergy = 0
  }

  private beginLoop(textDriven: boolean): void {
    if (this.running) {
      // 已在跑（如上一轮仍在收尾）：不重建循环，但彻底重置文字驱动状态，
      // 避免继承上轮 inputEnded/energy 导致新一轮不动或提前自停。
      if (textDriven) {
        this.resetTextState()
        log.info('[start] 循环已运行，重置为新一轮文字驱动')
      }
      return
    }
    this.running = true
    if (textDriven) {
      this.resetTextState()
    } else {
      this.textDriven = false
      this.energy = 1
    }
    this.startTs = performance.now()
    this.lastFrameTs = this.startTs
    log.info(`[start] 伪口型循环启动 mode=${textDriven ? 'text' : 'static'}`)
    this.loop()
  }

  /**
   * 文字 delta 到达：续期活跃截止时间，口型在活跃期连续起伏。
   * 无论生成早结束还是慢速喂字，只要持续喂字口型就持续动。
   */
  notifyTextActivity(charCount: number): void {
    if (charCount <= 0) return
    if (!this.textDriven) this.textDriven = true
    // 只抬高"已喂上界"，不立即上报进度；已读进度由 loop 按语速追进（时间驱动对齐）
    this.totalInjected += charCount
    this.activeUntil = performance.now() + ACTIVE_HOLD_MS
    this.energy = 1
  }

  /** 按帧时长把已读进度向已注入上界追进，取整后去抖上报（供卡拉OK高亮/动作对齐） */
  private advanceReadProgress(dt: number): void {
    if (this.readChars < this.totalInjected) {
      this.readChars = Math.min(this.totalInjected, this.readChars + READING_CHARS_PER_SEC * dt)
    }
    const n = Math.floor(this.readChars)
    if (n !== this.lastReportedRead) {
      this.lastReportedRead = n
      this.onProgress?.(n)
    }
  }

  /**
   * 上游文本流结束：等活跃期自然过期 + 能量衰减完后自停。
   * @param onDrained 自然收尾时回调（编排器在口型真正结束后再转待机/冷却）
   */
  finish(onDrained?: () => void): void {
    if (!this.running) {
      onDrained?.()
      return
    }
    // 逐字脉冲模式：不依赖能量衰减，改为等脉冲耗尽（poll 归零 + 能量收敛）后收尾
    if (this.audioCharPulse) {
      this.audioCharDraining = true
      this.onDrained = onDrained ?? null
      this.audioCharDrainSilentFrames = 0
      log.info('[finish] 逐字脉冲收尾：等待脉冲耗尽后自动闭合')
      return
    }
    this.inputEnded = true
    this.onDrained = onDrained ?? null
    log.info('[finish] 标记输入结束，活跃期过期后收尾')
  }

  stop(): void {
    const wasRunning = this.running
    const wasProgressOnly = this.progressOnly
    this.running = false
    this.textDriven = false
    this.activeUntil = 0
    this.totalInjected = 0
    this.readChars = 0
    this.lastReportedRead = -1
    this.inputEnded = false
    this.onDrained = null
    this.energy = 0
    this.progressOnly = false
    this.audioCharPulse = false
    this.pollCharEvents = null
    this.isAudioPlaying = null
    this.pulseEnergy = 0
    this.audioCharDraining = false
    this.audioCharDrainSilentFrames = 0
    this.heardPulse = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (wasRunning) {
      const durMs = Math.round(performance.now() - this.startTs)
      log.info(`[stop] 伪口型停止，本次持续 ${durMs}ms`)
    }
    this.smoothedValue = 0
    // progressOnly 期间嘴归真口型驱动，别抢着归零（否则与 PetLipSync 抖动打架）
    if (!wasProgressOnly) {
      this.renderer.setMouthOpen(0)
    }
  }

  isRunning(): boolean {
    return this.running
  }

  /**
   * 诊断快照：暴露内部时序状态，供 Lab 逐帧记录、定位"口型不动"断在哪一环。
   * remainMs>0 表示仍在活跃保活期内（应连续张合）。
   */
  getDiagState(): {
    running: boolean
    textDriven: boolean
    energy: number
    inputEnded: boolean
    totalInjected: number
    activeRemainMs: number
    smoothedValue: number
    audioCharPulse: boolean
    heardPulse: boolean
    pulseEnergy: number
    audioCharDraining: boolean
  } {
    return {
      running: this.running,
      textDriven: this.textDriven,
      energy: this.energy,
      inputEnded: this.inputEnded,
      totalInjected: this.totalInjected,
      activeRemainMs: this.running ? Math.round(this.activeUntil - performance.now()) : 0,
      smoothedValue: this.smoothedValue,
      audioCharPulse: this.audioCharPulse,
      heardPulse: this.heardPulse,
      pulseEnergy: this.pulseEnergy,
      audioCharDraining: this.audioCharDraining,
    }
  }

  private loop = (): void => {
    if (!this.running) return
    try {
      const now = performance.now()
      const dt = Math.max(0, (now - this.lastFrameTs) / 1000)
      this.lastFrameTs = now

      let target: number
      if (this.textDriven) {
        // 已读进度按语速随时间追进（卡拉OK高亮/动作对齐），上限为已注入字符数
        this.advanceReadProgress(dt)
        // 逐字脉冲口型：每帧消费 AudioPlaybackEngine 的逐字事件，一字一脉冲
        if (this.audioCharPulse) {
          const pulses = this.pollCharEvents?.() ?? 0
          if (pulses > 0) {
            this.pulseEnergy = Math.min(this.pulseEnergy + pulses, 3)
            // 首次收到脉冲：从正弦占位切换到逐字衰减模式，重置收尾计数器
            if (!this.heardPulse) {
              this.heardPulse = true
              this.audioCharDrainSilentFrames = 0
              log.info('[loop] 收到首帧逐字脉冲，切出正弦占位模式')
            }
          }
          // 尚未收到任何脉冲（TTS 合成延迟期）：用正弦波占位，嘴保持自然张合。
          // 避免"说话态已进入但嘴僵住不动"的死区。
          if (!this.heardPulse) {
            // 收尾期兜底超时：若始终无音频（TTS 失败/网络异常），>15s 后强制收尾
            if (this.audioCharDraining) {
              this.audioCharDrainSilentFrames++
              if (this.audioCharDrainSilentFrames > 900) {
                log.info('[loop] 逐字脉冲收尾超时（始终无脉冲），强制停止')
                this.readChars = this.totalInjected
                const n = Math.floor(this.readChars)
                if (n !== this.lastReportedRead) {
                  this.lastReportedRead = n
                  this.onProgress?.(n)
                }
                const cb = this.onDrained
                this.stop()
                cb?.()
                return
              }
            }
            this.energy = 1
            const t = (now - this.startTs) / 1000
            target = this.computeMouthOpen(t)
            this.smoothedValue = this.smoothedValue * SMOOTHING + target * (1 - SMOOTHING)
            this.renderer.setMouthOpen(this.smoothedValue)
            this.rafId = requestAnimationFrame(this.loop)
            return
          }
          // 已收到脉冲：逐字衰减驱动嘴，不再用正弦
          this.energy = 0
          this.pulseEnergy *= Math.exp(-PetFakeLipSync.PULSE_DECAY_PER_SEC * dt)
          // 音频是否仍在播放（含已调度未播的后续块）。收尾以此为准：只要还有音频，就绝不闭嘴。
          const audioAlive = this.isAudioPlaying?.() ?? false
          // 收尾判定：heardPulse 已保证至少收到过一次脉冲。
          // 关键修复（口型早停）：逐字事件常在音频真正播完前数秒就耗尽（末块 char 事件早于音频尾），
          // 且合成断流会出现事件间隙。故不能只凭"事件静默 500ms"判定收尾，必须同时确认音频已播完。
          if (this.audioCharDraining) {
            if (pulses === 0 && this.pulseEnergy < 0.02 && !audioAlive) {
              this.audioCharDrainSilentFrames++
            } else {
              this.audioCharDrainSilentFrames = 0
            }
            // 音频已播完 + ~300ms 无脉冲且能量收敛 → 判定耗尽
            if (this.audioCharDrainSilentFrames > 18) {
              log.info('[loop] 音频播完且逐字脉冲耗尽，自动收尾停止')
              this.readChars = this.totalInjected
              const n = Math.floor(this.readChars)
              if (n !== this.lastReportedRead) {
                this.lastReportedRead = n
                this.onProgress?.(n)
              }
              const cb = this.onDrained
              this.stop()
              cb?.()
              return
            }
          }
          // 逐字事件出现间隙但音频仍在播（合成断流 / 末块事件早于音频尾）：
          // 用低幅正弦维持自然张合，避免"音频还在放、嘴却僵住不动"的死区。
          let mouth: number
          if (audioAlive && pulses === 0 && this.pulseEnergy < 0.05) {
            const t = (now - this.startTs) / 1000
            mouth = this.computeMouthOpen(t) * 0.5
          } else {
            mouth = Math.min(1, this.pulseEnergy * 0.6)
          }
          this.smoothedValue = this.smoothedValue * SMOOTHING + mouth * (1 - SMOOTHING)
          this.renderer.setMouthOpen(this.smoothedValue)
          this.rafId = requestAnimationFrame(this.loop)
          return
        }
        // 静默进度模式：嘴归真音频口型驱动，这里只推进已读进度，不写 setMouthOpen
        if (this.progressOnly) {
          this.rafId = requestAnimationFrame(this.loop)
          return
        }
        const active = now < this.activeUntil
        if (active) {
          // 活跃期：能量拉满，连续多正弦合成自然张合
          this.energy = 1
        } else {
          // 喂字停顿超时或 finish：能量平滑衰减闭嘴
          this.energy *= Math.pow(1 - ENERGY_DECAY_PER_SEC, dt)
          // 输入已结束且能量收敛 → 自动收尾停止，通知编排器转待机
          if (this.inputEnded && this.energy < TAIL_ENERGY_EPS) {
            log.info('[loop] 活跃期结束、能量收敛，自动收尾停止')
            // 收尾前补齐剩余已读进度，避免末尾字符的高亮/动作丢失
            this.readChars = this.totalInjected
            const n = Math.floor(this.readChars)
            if (n !== this.lastReportedRead) {
              this.lastReportedRead = n
              this.onProgress?.(n)
            }
            const cb = this.onDrained
            this.stop()
            cb?.()
            return
          }
        }
        target = this.computeMouthOpen((now - this.startTs) / 1000) * this.energy
      } else {
        this.energy = 1
        target = this.computeMouthOpen((now - this.startTs) / 1000)
      }

      this.smoothedValue = this.smoothedValue * SMOOTHING + target * (1 - SMOOTHING)
      this.renderer.setMouthOpen(this.smoothedValue)
    } catch (err) {
      console.warn('[PetFakeLipSync] loop 异常，停止:', err)
      this.stop()
      return
    }
    this.rafId = requestAnimationFrame(this.loop)
  }

  /** 纯函数：按时间 t（秒）合成 0~1 的嘴开度。多正弦叠加，整流到非负。 */
  computeMouthOpen(t: number): number {
    const TWO_PI = Math.PI * 2
    const primary = Math.sin(t * BASE_FREQ_HZ * TWO_PI)
    const sub = 0.4 * Math.sin(t * SUB_FREQ_HZ * TWO_PI)
    // 半波整流到 0~1，再压一点幅度避免一直大张嘴
    const raw = (primary + sub + 1.4) / 2.8
    return Math.max(0, Math.min(1, raw * 1.15))
  }

  dispose(): void {
    this.stop()
  }
}
