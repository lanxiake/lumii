/**
 * PetOrchestrator - 宠物编排器
 *
 * 设计依据：00-修订版设计 §2.1 / §2.5（独立 orchestrator，不复用 ChatPage 订阅）
 *
 * 职责（无业务状态，纯事件→动画映射）：
 *  - 订阅 PetBus 语音状态事件
 *  - 6 态语音状态 → 宠物动画（idle/listening/recognizing/thinking/speaking）
 *  - speaking 进入 → 启动 PetLipSync；离开/打断 → 停口型回 idle
 *  - dispose 解绑全部监听
 *
 * 状态→动画映射（MVP 用动作组，无表情）：
 *  listening   → Idle（待机，等待用户说话）
 *  recognizing → Idle（识别中，可加倾听动作）
 *  thinking    → Idle（思考，可加点头）
 *  speaking    → Talk + 口型
 *  ended/idle  → Idle
 */

import type { PetRendererProvider, PetMotionPlayedInfo } from '../renderer/types'
import type { PetModelConfig } from '../config/pet-model-types'
import { PET_MOTION_GROUP_UNNAMED } from '../config/pet-model-types'
import { PetBus } from './pet-bus'
import { bindPetEventAdapter } from './pet-event-adapter'
import { PetLipSync } from './PetLipSync'
import { PetFakeLipSync } from './PetFakeLipSync'

const log = {
  info: (...args: unknown[]) => console.log('[PetOrchestrator]', ...args),
}

/** 待机随机动作的间隔范围（ms）：8~15s 随机，避免机械轮播 */
const IDLE_MOTION_MIN_MS = 8000
const IDLE_MOTION_MAX_MS = 15000
/** 对话结束后恢复随机待机动作的冷却时间（ms） */
const POST_DIALOGUE_IDLE_DELAY_MS = 10_000

/** 动作展示类型（UI 层转中文） */
export type PetMotionKind = 'none' | 'idle' | 'idle-random' | 'talk' | 'cooldown'

/** 虚拟人当前表情/动作可观测状态（供控制坞展示） */
export interface PetAvatarStatus {
  /** 递增序号，保证每次 patch 后 React 能感知变化 */
  statusSeq: number
  /** 语音/对话阶段 */
  phase:
    | 'idle'
    | 'listening'
    | 'recognizing'
    | 'thinking'
    | 'speaking'
    | 'text-reply'
    | 'ending'
    | 'error'
  /** 当前表情 key（emotionMap） */
  expressionKey?: string
  expressionIndex?: number
  /** 当前动作类型与组名 */
  motionKind?: PetMotionKind
  motionGroup?: string
  /** 实际播放的 motion3 文件（来自渲染器回调） */
  motionDetail?: string
  /** 随机待机动作是否开启 */
  idleMotionEnabled: boolean
  /** 对话结束后冷却中（尚未恢复随机待机） */
  postDialogueCooldown?: boolean
}

export class PetOrchestrator {
  private bus = new PetBus()
  private lipSync: PetLipSync
  private fakeLipSync: PetFakeLipSync
  private unbindAdapter: (() => void) | null = null
  private unbindBus: (() => void) | null = null
  private modelConfig: PetModelConfig | null = null
  /** 当前是否处于 speaking 态（避免重复触发动作） */
  private speaking = false
  /** 待机随机动作定时器 */
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** 对话结束后恢复随机待机的冷却定时器 */
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null
  /** 当前是否处于待机态（控制随机动作调度） */
  private idling = false
  /** 是否启用待机随机动作轮播 */
  private enableIdleMotion = true
  /** Agent 对话进行中（阻止随机待机打断回复） */
  private dialogueActive = false
  /** 对话已结束但 TTS/口型仍在播放，待结束后进入冷却 */
  private dialogueEndPendingCooldown = false
  /** 对话结束冷却中（10s 内不播随机待机） */
  private inPostDialogueCooldown = false
  /** 文字回复口型进行中（与语音通话 speaking 区分） */
  private textReplyActive = false
  /** 文字回复伪口型收尾中（turn:end 后 backlog 仍在读完）：阻止此期间播待机动作/冷却，避免身体先于嘴结束 */
  private textReplyDraining = false
  /** 文字回复是否走真音频口型（否则伪口型） */
  private textReplyUseRealVoice = false
  /** 可触发动作标签 → { 动作组, index }（由 setActionMotions 注入，来自 VH 上下文） */
  private actionMotions: Record<string, { group: string; index?: number }> = {}
  /** 待按朗读进度触发的动作队列（atChar 升序）：由伪口型进度回调驱动，实现"读到此处再做动作" */
  private pendingActionMotions: { tag: string; atChar: number }[] = []
  /** 待按朗读进度触发的表情队列（atChar 升序）：与动作同一朗读时钟，实现"读到此处再切表情" */
  private pendingExpressions: { index: number; name: string; atChar: number }[] = []
  /** 伪口型已读字符数（朗读进度回调更新，用于判断动作标签是否已可触发） */
  private lastReadChars = 0
  private statusListener: ((status: PetAvatarStatus) => void) | null = null
  /** 朗读进度监听（可观测/调试）：伪口型每帧上报已读字符数，供字幕卡拉OK高亮对齐 */
  private readingProgressListener: ((charsRead: number) => void) | null = null
  /** 动作实际播放监听（可观测/调试）：仅在动作真正开始播放时触发（被优先级拦截不触发） */
  private debugMotionListener: ((info: PetMotionPlayedInfo) => void) | null = null
  private statusSeq = 0
  private status: PetAvatarStatus = {
    statusSeq: 0,
    phase: 'idle',
    motionKind: 'none',
    idleMotionEnabled: true,
  }

  constructor(private readonly renderer: PetRendererProvider) {
    this.lipSync = new PetLipSync(renderer)
    this.fakeLipSync = new PetFakeLipSync(renderer)
    this.fakeLipSync.setOnProgress((charsRead) => this.onReadingProgress(charsRead))
    this.bindMotionListener()
  }

  /** 绑定渲染器动作播放回调，同步真实动作名到控制坞 */
  private bindMotionListener(): void {
    this.renderer.setMotionPlayedListener?.((info) => this.onMotionPlayed(info))
  }

  /** 渲染器实际开始播放某动作时更新可观测状态 */
  private onMotionPlayed(info: PetMotionPlayedInfo): void {
    // 调试监听：无条件转发真正播放的动作（含对话中的 [motion:tag]），供 Lab 反馈"是否播放成功"
    this.debugMotionListener?.(info)
    if (this.textReplyActive) {
      // 对话中：仅忽略库原生自动续播的基础待机循环（IDLE 优先级），
      // 允许 [motion:tag] 主动触发的动作（NORMAL 优先级，非 idleGroup）更新控制坞展示
      if (info.group === this.idleGroup) {
        log.info(
          `[onMotionPlayed] 对话中忽略基础待机循环 group=${info.group} file=${info.fileName ?? '(none)'}`,
        )
        return
      }
    }
    const kind: PetMotionKind = this.speaking
      ? 'talk'
      : this.inPostDialogueCooldown
        ? 'cooldown'
        : this.idling && this.enableIdleMotion
          ? 'idle-random'
          : 'idle'
    log.info(
      `[onMotionPlayed] kind=${kind} group=${info.group} index=${info.index} file=${info.fileName ?? '(none)'}`,
    )
    this.patchStatus({
      motionKind: kind,
      motionGroup: info.group,
      motionDetail: info.fileName,
    })
  }

  /** 绑定模型配置（用于取 idle/talk 动作组名）。模型热切换时复用同一编排器，仅换配置。 */
  setModelConfig(config: PetModelConfig): void {
    this.modelConfig = config
  }

  /** 订阅表情/动作状态变化（控制坞展示） */
  setStatusListener(listener: ((status: PetAvatarStatus) => void) | null): void {
    this.statusListener = listener
    if (listener) listener({ ...this.status })
  }

  /** 订阅朗读进度（伪口型已读字符数，卡拉OK式字幕高亮/调试用）。传 null 解绑。 */
  setReadingProgressListener(listener: ((charsRead: number) => void) | null): void {
    this.readingProgressListener = listener
  }

  /** 订阅动作实际播放（真正开始播放才触发，被优先级拦截不触发；调试反馈用）。传 null 解绑。 */
  setDebugMotionListener(listener: ((info: PetMotionPlayedInfo) => void) | null): void {
    this.debugMotionListener = listener
  }

  /** 开关待机随机动作；关闭时停止定时器并仅保持基础 Idle */
  setEnableIdleMotion(enabled: boolean): void {
    this.enableIdleMotion = enabled
    this.patchStatus({ idleMotionEnabled: enabled })
    log.info(`[setEnableIdleMotion] enabled=${enabled}`)
    if (!enabled) {
      this.clearIdleMotionTimer()
      // 基础待机由库原生续播，无需手动 playMotion(idle)（会与库 IDLE 预约冲突被拦截）。
      // 关闭随机轮播仅需停掉装饰定时器，库仍持续循环基础待机。
      if (this.idling && !this.speaking) {
        this.patchStatus({ motionKind: 'idle', motionGroup: this.idleGroup })
      }
      return
    }
    if (this.idling && !this.speaking && !this.dialogueActive && !this.inPostDialogueCooldown) {
      if (this.hasRandomIdleSource()) {
        this.playRandomIdleNow()
      }
      this.scheduleNextIdleMotion()
    }
  }

  /** 标记 Agent 对话开始/结束；结束时进入 10s 冷却再恢复随机待机 */
  setDialogueActive(active: boolean): void {
    log.info(`[setDialogueActive] active=${active}`)
    if (active) {
      this.dialogueActive = true
      this.dialogueEndPendingCooldown = false
      this.clearPostDialogueCooldown()
      this.exitIdle()
      return
    }
    this.dialogueActive = false
    this.onDialogueEnded()
  }

  /**
   * AI 回复结束：进入 10s 冷却后再恢复随机待机。
   * 若 TTS/口型仍在播放，待 speaking 结束后再启动冷却。
   */
  onDialogueEnded(): void {
    this.dialogueActive = false
    log.info(
      `[onDialogueEnded] speaking=${this.speaking} draining=${this.textReplyDraining} pending=${this.dialogueEndPendingCooldown}`,
    )
    // 真音频 speaking 或 伪口型仍在收尾读 backlog：都先挂起冷却，待口型真正结束再触发，
    // 否则身体会先于嘴巴进入待机动作（口型还在动，却已播 Idle）。
    if (this.speaking || this.textReplyDraining) {
      this.dialogueEndPendingCooldown = true
      return
    }
    this.beginPostDialogueCooldown()
  }

  /** 是否允许调度随机待机动作 */
  private canScheduleRandomIdle(): boolean {
    return (
      this.enableIdleMotion &&
      !this.dialogueActive &&
      !this.inPostDialogueCooldown &&
      !this.speaking &&
      this.hasRandomIdleSource()
    )
  }

  /**
   * 是否存在可随机轮播的"装饰性"待机动作来源。
   *
   * 基础待机组（config.idleMotionGroup，已喂给库）由库原生在每次动作播完时自动随机续播，
   * 故编排器只负责库不管的"额外装饰组"轮播（如 mao_pro 的 $unnamed、shizuku 的 FlickUp/Flick3）。
   * 与库 idle 同组的轮播是冗余且会被库 IDLE 预约拦截，一律排除。
   */
  private hasRandomIdleSource(): boolean {
    // 显式空数组：作者声明"不随机轮播待机"（如 baimeimo 的 Idle 组实为动作组，
    // 由 [motion:tag] 触发，不应被待机轮播占用）
    const pools = this.modelConfig?.idleMotionRandomGroups
    if (Array.isArray(pools) && pools.length === 0) return false
    return this.resolveDecorativeIdleGroups().length > 0
  }

  /**
   * 解析"装饰性"待机轮播组：与库基础 idle 组不同、且组内至少 1 个动作。
   * - 多组池：取池中 ≠ idleGroup 的组
   * - 无池：用 resolveIdleMotionGroup() 的回退组（mao_pro=$unnamed），仅当它 ≠ idleGroup 且 >1 个动作
   */
  private resolveDecorativeIdleGroups(): string[] {
    const idleGroup = this.idleGroup
    const pools = this.modelConfig?.idleMotionRandomGroups
    if (pools && pools.length > 0) {
      return pools.filter((g) => g !== idleGroup && this.renderer.getMotionCount(g) > 0)
    }
    const fallback = this.resolveIdleMotionGroup()
    if (fallback !== idleGroup && this.renderer.getMotionCount(fallback) > 1) {
      return [fallback]
    }
    return []
  }

  /** 立即播放一次装饰性随机待机动作（开随动或定时器触发时调用） */
  private playRandomIdleNow(): void {
    const groups = this.resolveDecorativeIdleGroups()
    if (groups.length === 0) return
    const group = groups[Math.floor(Math.random() * groups.length)]!
    const count = this.renderer.getMotionCount(group)
    log.info(`[playRandomIdleNow] 装饰待机组="${group}" count=${count}`)
    this.patchStatus({ motionKind: 'idle-random', motionGroup: group })
    if (count > 1) {
      this.renderer.playRandomMotion(group)
    } else {
      this.renderer.playMotion(group, 0)
    }
  }

  /** 清除对话结束冷却定时器与状态 */
  private clearPostDialogueCooldown(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer)
      this.cooldownTimer = null
    }
    this.inPostDialogueCooldown = false
    this.patchStatus({ postDialogueCooldown: false })
  }

  /** 对话结束后：基础待机由库续播，仅冷却 10s 抑制装饰随机轮播，到点再恢复 */
  private beginPostDialogueCooldown(): void {
    if (this.inPostDialogueCooldown) return
    this.dialogueEndPendingCooldown = false
    this.clearIdleMotionTimer()
    this.idling = true
    const base = this.idleGroup
    this.inPostDialogueCooldown = true
    this.patchStatus({
      phase: 'idle',
      motionKind: 'cooldown',
      motionGroup: base,
      postDialogueCooldown: true,
    })
    // 不手动 playMotion(base)：库在动作播完后已自动续播 groups.idle（基础待机），
    // 手动 NORMAL 触发同组反而被库的 IDLE 预约拦截，且会打断库的自动续播节奏。
    log.info(`[beginPostDialogueCooldown] ${POST_DIALOGUE_IDLE_DELAY_MS}ms 后恢复随机待机`)
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null
      this.inPostDialogueCooldown = false
      this.patchStatus({ postDialogueCooldown: false })
      log.info('[beginPostDialogueCooldown] 冷却结束，恢复待机调度')
      if (this.idling && !this.speaking && !this.dialogueActive) {
        this.enterIdle()
      }
    }, POST_DIALOGUE_IDLE_DELAY_MS)
  }

  /** 仅清除随机待机定时器（不改变 idling） */
  private clearIdleMotionTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** speaking 结束后若对话已结束，启动冷却 */
  private maybeStartDialogueCooldown(): void {
    if (this.dialogueEndPendingCooldown && !this.speaking) {
      this.beginPostDialogueCooldown()
    }
  }

  /** 立即设置表情（emotionMap 索引）。用于内部即时归位（如新一轮开始/结束重置为平静 index=0）。 */
  setExpression(expressionIndex: number, emotionName?: string): void {
    log.info(
      `[setExpression] orchestrator → renderer index=${expressionIndex} name=${emotionName ?? '(unknown)'}`,
    )
    this.patchStatus({
      expressionKey: emotionName,
      expressionIndex,
    })
    this.renderer.setExpression(expressionIndex)
  }

  /**
   * 回复中命中 [emotion] 标签：按朗读进度对齐切表情（与 [motion:tag] 同一朗读时钟），
   * 实现"读到此处才切表情，没读到保持当前（默认平静）"。
   * @param index emotionMap 解析后的表情索引
   * @param name 表情名（可观测/日志）
   * @param atChar 该标签在清洁文本流中的字符偏移；省略或伪口型未在跑时立即切换（无朗读进度可对齐）。
   */
  playExpression(index: number, name: string, atChar?: number): void {
    // 无偏移或朗读进度循环未在跑（纯即时场景）：无进度可对齐，立即切换
    if (atChar === undefined || !this.fakeLipSync.isRunning()) {
      this.setExpression(index, name)
      return
    }
    // 已读过该位置则立即切，否则按 atChar 升序入队，等朗读进度到达再切换
    if (atChar <= this.lastReadChars) {
      this.setExpression(index, name)
      return
    }
    this.pendingExpressions.push({ index, name, atChar })
    this.pendingExpressions.sort((a, b) => a.atChar - b.atChar)
    log.info(`[playExpression] ${name}(index=${index}) 入队 atChar=${atChar}（待读到此处再切），队列深度=${this.pendingExpressions.length}`)
  }

  /** 是否处于文字回复口型阶段 */
  isTextReplyActive(): boolean {
    return this.textReplyActive
  }

  /**
   * 诊断快照：暴露伪口型内部状态 + 编排器门控标志，供 Lab 逐帧记录。
   * gateBlocked=true 表示 notifyTextDelta 会被真口型门挡掉（喂字丢弃）。
   */
  getFakeLipSyncDiag(): {
    running: boolean
    textDriven: boolean
    energy: number
    inputEnded: boolean
    totalInjected: number
    activeRemainMs: number
    smoothedValue: number
    gateBlocked: boolean
    textReplyActive: boolean
    textReplyDraining: boolean
  } {
    const s = this.fakeLipSync.getDiagState()
    return {
      ...s,
      gateBlocked: this.lipSync.isRunning() || this.lipSync.isPendingStart(),
      textReplyActive: this.textReplyActive,
      textReplyDraining: this.textReplyDraining,
    }
  }

  /** 绑定 TTS 播放分析节点（startCall 后从 useVoiceCall 拿） */
  setPlaybackAnalyser(analyser: AnalyserNode | null): void {
    this.lipSync.setAnalyser(analyser)
  }

  /**
   * 绑定逐字脉冲口型回调（startCall 后从 useVoiceCall 拿）。
   * 消费 AudioPlaybackEngine 的逐字边界事件（对齐 AudioContext 时钟），
   * 替代 RMS 连续振幅分析，实现一字一合。
   * @param pollFn 逐字事件消费闭包
   * @param isAudioPlayingFn 音频是否仍在播放的探测闭包（收尾判定用，避免口型早于音频停止）
   */
  setCharPulsePoll(pollFn: (() => number) | null, isAudioPlayingFn?: (() => boolean) | null): void {
    this.charPulsePoll = pollFn
    this.audioPlayingProbe = isAudioPlayingFn ?? null
    // 真音频 RMS 直驱依赖"音频是否播放中"探测：句间弱音时给保活开口，修复"经常没口型"。
    this.lipSync.setAudioPlayingProbe(this.audioPlayingProbe)
    // pollFn 延迟就位（AudioPlaybackEngine 初始化慢于 speaking 状态切换）时，
    // startSpeaking 可能因 analyser 尚未绑定而挂起 lipSync（pendingStart）。此处仅需确保
    // 探测闭包已就位；lipSync 会在 setPlaybackAnalyser 绑定 analyser 后自动启动，无需补切。
  }

  /** 逐字脉冲口型回调：消费 AudioPlaybackEngine.pollCharEvents(audioCtx.currentTime) */
  private charPulsePoll: (() => number) | null = null
  /** 音频是否仍在播放的探测闭包（收尾判定用） */
  private audioPlayingProbe: (() => boolean) | null = null

  /**
   * 文字流式输出到达：让伪口型节奏跟随文字输出速度。
   * 仅在纯文字回复（伪口型驱动、无真音频）时生效；真音频口型由 AnalyserNode RMS 驱动，无需此信号。
   */
  notifyTextDelta(text: string): void {
    if (!text) return
    // 真音频口型（RMS）驱动嘴时，伪口型转「只推进朗读进度」模式仍在跑：
    // 仍需喂入字符数抬高已注入上界，进度循环才能按语速追进 → 驱动动作对齐。
    // 仅当伪口型完全停止（既非张合、也非只推进进度）时才跳过。
    if ((this.lipSync.isRunning() || this.lipSync.isPendingStart()) && !this.fakeLipSync.isRunning()) {
      return
    }
    this.fakeLipSync.notifyTextActivity(text.length)
  }

  /** 注入可触发动作映射（tag → 动作组/index），来自 VH 上下文解析。 */
  setActionMotions(map: Record<string, { group: string; index?: number }>): void {
    this.actionMotions = map ?? {}
  }

  /**
   * 模型在回复中触发 [motion:tag]：按朗读进度对齐播放（karaoke 式），实现"边说边做、读到位置再做"。
   * @param tag 动作标签
   * @param atChar 该标签在清洁文本流中的字符偏移；省略或为真音频口型时立即播放（无朗读进度可对齐）。
   *
   * 动作播放不影响口型（口型由 LipSync 独立驱动 ParamMouthOpenY）。
   */
  playActionMotion(tag: string, atChar?: number): void {
    if (!this.actionMotions[tag]) {
      log.info(`[playActionMotion] 未知动作 tag=${tag}，忽略`)
      return
    }
    // 无偏移（真音频口型 / 兜底）或伪口型未在跑：无朗读进度可对齐，立即播放
    if (atChar === undefined || !this.fakeLipSync.isRunning()) {
      this.runActionMotion(tag)
      return
    }
    // 已读过该位置则立即播，否则按 atChar 升序入队，等朗读进度到达再触发
    if (atChar <= this.lastReadChars) {
      this.runActionMotion(tag)
      return
    }
    this.pendingActionMotions.push({ tag, atChar })
    this.pendingActionMotions.sort((a, b) => a.atChar - b.atChar)
    log.info(`[playActionMotion] tag=${tag} 入队 atChar=${atChar}（待读到此处再播），队列深度=${this.pendingActionMotions.length}`)
  }

  /** 实际播放动作（查表 → 渲染器）。 */
  private runActionMotion(tag: string): void {
    const entry = this.actionMotions[tag]
    if (!entry) return
    log.info(`[runActionMotion] tag=${tag} → group=${entry.group} index=${entry.index ?? '(random)'}`)
    if (typeof entry.index === 'number') {
      this.renderer.playMotion(entry.group, entry.index)
    } else {
      this.renderer.playRandomMotion(entry.group)
    }
  }

  /**
   * 伪口型朗读进度回调（每帧）：触发所有"已读到"的待播表情与动作。
   * charsRead 单调递增（backlog 匀速消费），与 PetEmotionMapper 标注的 atChar 同坐标系。
   * 表情先于动作应用（同一位置时先切表情再做动作，观感更自然）。
   */
  private onReadingProgress(charsRead: number): void {
    this.lastReadChars = charsRead
    this.readingProgressListener?.(charsRead)
    while (this.pendingExpressions.length > 0 && this.pendingExpressions[0]!.atChar <= charsRead) {
      const next = this.pendingExpressions.shift()!
      log.info(`[onReadingProgress] 读到 atChar=${next.atChar}（已读 ${charsRead.toFixed(0)}）→ 切表情 ${next.name}`)
      this.setExpression(next.index, next.name)
    }
    while (this.pendingActionMotions.length > 0 && this.pendingActionMotions[0]!.atChar <= charsRead) {
      const next = this.pendingActionMotions.shift()!
      log.info(`[onReadingProgress] 读到 atChar=${next.atChar}（已读 ${charsRead.toFixed(0)}）→ 播放 ${next.tag}`)
      this.runActionMotion(next.tag)
    }
  }

  /** 清空待播动作/表情队列（打断/错误/新一轮回复开始时调用）。 */
  private clearPendingActionMotions(): void {
    if (this.pendingActionMotions.length > 0) {
      log.info(`[clearPendingActionMotions] 丢弃 ${this.pendingActionMotions.length} 个未触发动作`)
    }
    if (this.pendingExpressions.length > 0) {
      log.info(`[clearPendingActionMotions] 丢弃 ${this.pendingExpressions.length} 个未触发表情`)
    }
    this.pendingActionMotions = []
    this.pendingExpressions = []
    this.lastReadChars = 0
  }

  /** 启动编排：订阅事件 + 进入待机随机轮播 */
  start(): void {
    this.unbindAdapter = bindPetEventAdapter(this.bus)
    this.unbindBus = this.bus.on((event) => {
      if (event.kind === 'voice:state') {
        this.onVoiceState(event.state, event.interrupted)
      } else if (event.kind === 'voice:ended') {
        this.onCallEnded()
      }
    })
    this.enterIdle()
    log.info('编排器已启动')
  }

  private get idleGroup(): string {
    return this.modelConfig?.idleMotionGroup ?? 'Idle'
  }
  private get talkGroup(): string {
    return this.resolveTalkMotionGroup()
  }

  /** 合并并广播可观测状态 */
  private patchStatus(partial: Partial<PetAvatarStatus>): void {
    this.statusSeq += 1
    this.status = { ...this.status, ...partial, statusSeq: this.statusSeq }
    this.statusListener?.({ ...this.status })
  }

  /** 解析说话动作组：配置的组不存在时回退到多动作组 */
  private resolveTalkMotionGroup(): string {
    const primary = this.modelConfig?.talkMotionGroup ?? 'Talk'
    if (this.renderer.getMotionCount(primary) > 0) return primary
    const fallback = this.modelConfig?.idleMotionFallbackGroup ?? PET_MOTION_GROUP_UNNAMED
    if (fallback && this.renderer.getMotionCount(fallback) > 0) {
      log.info(`[resolveTalkMotionGroup] "${primary}" 无动作，回退 "${fallback}"`)
      return fallback
    }
    return primary
  }

  /**
   * 文字回复开始：启动口型（不播 Talk 动作，避免 motion 关键帧覆盖嘴型）。
   * useRealVoice=true 时先伪口型，TTS speaking 后切真口型。
   */
  startTextReply(useRealVoice: boolean): void {
    if (this.textReplyActive) {
      if (!this.fakeLipSync.isRunning() && !this.lipSync.isRunning() && !this.lipSync.isPendingStart()) {
        this.fakeLipSync.startTextDriven()
      }
      return
    }
    this.exitIdle()
    this.textReplyActive = true
    this.textReplyUseRealVoice = useRealVoice
    this.speaking = true
    this.clearPendingActionMotions()
    // 每次新一轮回复开始时重置表情为平静（index=0），
    // 由后续 PetEmotionMapper 按 emotion 标签覆盖。若 AI 回复无表情标签，始终平静。
    this.renderer.setExpression(0)
    this.patchStatus({
      phase: 'text-reply',
      motionKind: 'none',
      motionGroup: undefined,
      motionDetail: undefined,
    })
    this.lipSync.stop()
    // 文字驱动伪口型：嘴从闭合开始，按文字 backlog 张合（真音频可用时由 startSpeaking 切真口型）
    this.fakeLipSync.startTextDriven()
    log.info(`[startTextReply] 伪口型已启动 realVoice=${useRealVoice}`)
  }

  /**
   * 文字回复结束：
   * - 自然结束（agent:turn:end / agent:idle，immediate=false）：不立即停口型——文本生成往往
   *   1-2s 就结束，但 TTS 音频/字幕按自然语速播完需更久。
   *   · 真音频口型（TTS 出声）：走 lipSync.finish()，跟随音频振幅直到"连续无音"判定播放
   *     真正结束才闭嘴，使口型时长贴合音频实际时长（修复"口型先停、音频还在读"）。
   *   · 伪口型（静默）：走 fakeLipSync.finish()，读完字符 backlog 后自停。
   *   两者收尾完成后再转待机/冷却（onDrained 回调），避免口型未停就播待机动作。
   * - 打断/错误（immediate=true）：硬停口型并立即转待机。
   */
  endTextReply(immediate = false): void {
    if (!immediate && this.textReplyDraining) {
      log.info('[endTextReply] 口型已在收尾中，忽略重复自然结束')
      return
    }
    if (!this.textReplyActive && !this.fakeLipSync.isRunning() && !this.lipSync.isRunning() && !this.lipSync.isPendingStart()) {
      return
    }
    this.textReplyActive = false
    this.textReplyUseRealVoice = false
    this.speaking = false

    // 自然结束：优先跟随实际播放收尾（真口型跟音频、伪口型跟字符 backlog），收尾完成后转待机。
    // 期间置 textReplyDraining，让 onDialogueEnded 挂起冷却（避免身体先于嘴进入待机动作）。
    if (!immediate) {
      const realRunning = this.lipSync.isRunning() || this.lipSync.isPendingStart()
      const charPulseRunning = this.charPulsePoll !== null && this.fakeLipSync.isRunning()
      if (realRunning) {
        this.textReplyDraining = true
        log.info('[endTextReply] 标记真音频口型收尾（跟随 TTS 音频直到播放结束）')
        this.lipSync.finish(() => {
          log.info('[endTextReply] 真音频口型收尾完成 → 转待机/冷却')
          // 收尾完成再停伪口型的「只推进进度」循环：drain 期间它继续按语速追进已读进度，
          // 保证末尾字符的卡拉OK高亮/动作在音频播完前触发，不因提前 stop 冻结。
          this.fakeLipSync.stop()
          this.textReplyDraining = false
          this.afterTextReplyEnded()
        })
        return
      }
      if (charPulseRunning) {
        this.textReplyDraining = true
        this.lipSync.stop()
        log.info('[endTextReply] 标记逐字脉冲口型收尾（跟随逐字事件直到脉冲耗尽）')
        this.fakeLipSync.finish(() => {
          log.info('[endTextReply] 逐字脉冲收尾完成 → 转待机/冷却')
          this.textReplyDraining = false
          this.afterTextReplyEnded()
        })
        return
      }
      if (this.fakeLipSync.isRunning()) {
        this.textReplyDraining = true
        this.lipSync.stop()
        log.info('[endTextReply] 标记伪口型收尾（读完 backlog 后自停）')
        this.fakeLipSync.finish(() => {
          log.info('[endTextReply] 伪口型收尾完成 → 转待机/冷却')
          this.textReplyDraining = false
          this.afterTextReplyEnded()
        })
        return
      }
    }

    // 打断/错误 或 口型均未在跑：硬停并立即转待机
    this.textReplyDraining = false
    this.clearPendingActionMotions()
    this.lipSync.stop()
    this.fakeLipSync.stop()
    log.info(`[endTextReply] 口型已停止 immediate=${immediate}`)
    this.afterTextReplyEnded()
  }

  /**
   * 文字回复口型真正结束后的统一收尾：按需进入冷却或恢复待机。
   * 收尾期间若上游已发过 turn:end/idle（dialogueEndPendingCooldown），此时才真正启动冷却。
   */
  private afterTextReplyEnded(): void {
    // 回复结束，重置表情为平静（index=0），搭配基础待机动作。
    // 若期间 PetEmotionMapper 已设过表情，此处兜底确保"无语音/文字/表情/动作时归位平静"。
    this.renderer.setExpression(0)
    this.patchStatus({ expressionKey: 'neutral', expressionIndex: 0 })
    if (this.dialogueEndPendingCooldown) {
      this.beginPostDialogueCooldown()
      return
    }
    this.maybeStartDialogueCooldown()
    if (!this.inPostDialogueCooldown) {
      this.enterIdle()
    }
  }

  /** 语音状态 → 动画（文字回复期间忽略 thinking/listening 等中间态） */
  private onVoiceState(state: string, interrupted: boolean): void {
    log.info(`[onVoiceState] state=${state} interrupted=${interrupted} textReply=${this.textReplyActive}`)

    if (interrupted) {
      if (this.textReplyActive) {
        this.endTextReply(true)
        return
      }
      // 收尾期被打断：硬停口型（放弃跟随剩余音频），立即转待机
      if (this.textReplyDraining) {
        this.textReplyDraining = false
        this.lipSync.stop()
        this.fakeLipSync.stop()
        this.enterIdle()
        return
      }
      this.stopSpeaking()
      this.enterIdle()
      return
    }

    // 文字回复收尾期（真口型正跟随 TTS 音频播完）：主进程"合成完成"会把状态机推到
    // ending/listening，但客户端音频仍在 Web Audio 缓冲里播放。此时任何瞬态状态都不能
    // 硬停口型——否则嘴在音频还剩一大半时就闭上。统一交给 lipSync.finish() 的"连续无音
    // 判定"决定何时闭嘴转待机，与音频真实播放时长对齐。
    if (this.textReplyDraining) {
      log.info(`[onVoiceState] 收尾期忽略瞬态状态 state=${state}（等音频播完自然收尾）`)
      return
    }

    switch (state) {
      case 'speaking':
        this.startSpeaking()
        break
      case 'listening':
        if (this.textReplyActive) {
          this.patchStatus({ phase: 'text-reply' })
          return
        }
        this.patchStatus({ phase: 'listening' })
        this.stopSpeaking()
        this.enterIdle()
        break
      case 'recognizing':
        if (this.textReplyActive) {
          this.patchStatus({ phase: 'text-reply' })
          return
        }
        this.patchStatus({ phase: 'recognizing' })
        this.stopSpeaking()
        this.enterIdle()
        break
      case 'thinking':
        if (this.textReplyActive) {
          this.patchStatus({ phase: 'text-reply' })
          return
        }
        this.patchStatus({ phase: 'thinking' })
        this.stopSpeaking()
        this.enterIdle()
        break
      case 'initializing':
        if (this.textReplyActive) return
        this.patchStatus({ phase: 'idle' })
        this.stopSpeaking()
        this.enterIdle()
        break
      case 'ending':
        if (this.textReplyActive) {
          // 文字回复期间不在此停口型：micless TTS 队列清空会触发 ending，
          // 但 AI 流可能仍在继续，统一等 agent:turn:end / agent:idle 事件结束
          this.patchStatus({ phase: 'text-reply' })
          return
        }
        this.patchStatus({ phase: 'ending' })
        this.stopSpeaking()
        this.enterIdle()
        break
      case 'error':
        if (this.textReplyActive) {
          this.endTextReply(true)
          return
        }
        this.patchStatus({ phase: 'error' })
        this.stopSpeaking()
        this.enterIdle()
        break
      default:
        break
    }
  }

  /** 纯语音通话 speaking：播放 talk 动作并驱动真口型 */
  private startSpeaking(): void {
    if (this.textReplyActive) {
      if (this.textReplyUseRealVoice) {
        // 真音频 RMS 直驱口型：从 AudioPlaybackEngine 的 AnalyserNode 取振幅，天然与音频同一时间线，
        // 不再用逐字脉冲估算（字数/时长 + 多句串接会漂移 3-5s）。analyser 未就绪时 lipSync 会
        // 挂起 pendingStart，待 setPlaybackAnalyser 绑定后自动启动；期间保留伪口型兜底不写嘴。
        //
        // 伪口型不硬停，转「只推进朗读进度」模式：嘴让给真口型 RMS，但朗读进度循环继续按语速
        // 追进 → 驱动 onReadingProgress 消费 pendingActionMotions，实现"读到位置再做动作"。
        // 若此处 stop()，进度循环即停、待播动作队列失去驱动，全部 [motion] 会在别处兜底立即触发
        // （所有动作一开口全播完）——这正是要修复的 bug。
        this.fakeLipSync.enterProgressOnly()
        this.lipSync.start()
        log.info('[startSpeaking] 文字回复切真音频 RMS 直驱口型（伪口型转只推进朗读进度，供动作对齐）')
      }
      return
    }
    if (this.speaking) return
    this.exitIdle()
    this.speaking = true
    const group = this.talkGroup
    this.patchStatus({
      phase: 'speaking',
      motionKind: 'talk',
      motionGroup: group,
    })
    this.renderer.playMotion(group)
    this.fakeLipSync.stop()
    this.lipSync.start()
    log.info('[startSpeaking] 真口型已启动')
  }

  private stopSpeaking(): void {
    if (this.textReplyActive) {
      return
    }
    this.fakeLipSync.stop()
    if (!this.speaking) {
      this.lipSync.stop()
      this.maybeStartDialogueCooldown()
      return
    }
    this.speaking = false
    this.lipSync.stop()
    this.maybeStartDialogueCooldown()
  }

  private onCallEnded(): void {
    // 收尾期（真口型正跟随剩余 TTS 音频）：通话结束事件仅表示主进程不再合成，
    // 客户端音频仍在播放缓冲里。不硬停口型，交给 lipSync.finish() 的无音判定收尾。
    if (this.textReplyDraining) {
      log.info('[onCallEnded] 收尾期忽略通话结束（等音频播完自然收尾）')
      return
    }
    this.stopSpeaking()
    this.enterIdle()
  }

  /** 进入待机：按设置播放 idle 动作并可选启动随机轮播 */
  private enterIdle(): void {
    if (this.dialogueActive) {
      log.info('[enterIdle] 对话进行中，跳过待机动作')
      return
    }
    this.idling = true
    const group = this.resolveIdleMotionGroup()
    const count = this.renderer.getMotionCount(group)
    const canRandom = this.canScheduleRandomIdle()
    log.info(
      `[enterIdle] 待机动作组="${group}" count=${count} random=${canRandom} cooldown=${this.inPostDialogueCooldown}`,
    )
    if (canRandom) {
      this.playRandomIdleNow()
      this.scheduleNextIdleMotion()
    } else {
      // 无装饰随机源：基础待机完全交给库原生续播（库已在循环 groups.idle），
      // 此处只更新可观测状态，绝不手动 playMotion(idle)——否则与库 IDLE 预约冲突被拦截、
      // 且动作播完会卡在末帧（库正是靠自动续播脱离末帧）。
      this.patchStatus({
        phase: 'idle',
        motionKind: this.inPostDialogueCooldown ? 'cooldown' : 'idle',
        motionGroup: this.idleGroup,
      })
    }
  }

  /**
   * 解析待机动作组：主组仅 1 个动作时回退到模型内多动作组（mao_pro 的 "" 组）。
   */
  private resolveIdleMotionGroup(): string {
    const primary = this.idleGroup
    if (this.renderer.getMotionCount(primary) > 1) return primary
    const fallback = this.modelConfig?.idleMotionFallbackGroup ?? PET_MOTION_GROUP_UNNAMED
    if (fallback && this.renderer.getMotionCount(fallback) > 1) {
      log.info(
        `[resolveIdleMotionGroup] 主组 "${primary}" 仅 ${this.renderer.getMotionCount(primary)} 个，回退 "${fallback}"`,
      )
      return fallback
    }
    return primary
  }

  /** 退出待机：停止随机轮播（speaking 期间不打断 talk 动作） */
  private exitIdle(): void {
    this.idling = false
    this.clearIdleMotionTimer()
  }

  /** 安排下一次随机待机动作（8~15s 随机间隔） */
  private scheduleNextIdleMotion(): void {
    if (!this.canScheduleRandomIdle()) return
    this.clearIdleMotionTimer()
    const delay =
      IDLE_MOTION_MIN_MS + Math.random() * (IDLE_MOTION_MAX_MS - IDLE_MOTION_MIN_MS)
    this.idleTimer = setTimeout(() => {
      if (!this.idling || !this.canScheduleRandomIdle()) return
      log.info('[scheduleNextIdleMotion] 触发随机待机')
      this.playRandomIdleNow()
      this.scheduleNextIdleMotion()
    }, delay)
  }

  /** 可观测：当前口型延迟 */
  getLipSyncLatencyMs(): number {
    return this.lipSync.getLastLatencyMs()
  }

  /** 解绑全部监听，释放资源 */
  dispose(): void {
    this.exitIdle()
    this.clearPostDialogueCooldown()
    this.unbindAdapter?.()
    this.unbindBus?.()
    this.unbindAdapter = null
    this.unbindBus = null
    this.statusListener = null
    this.renderer.setMotionPlayedListener?.(null)
    this.lipSync.dispose()
    this.fakeLipSync.dispose()
    this.bus.clear()
    log.info('编排器已销毁')
  }
}
