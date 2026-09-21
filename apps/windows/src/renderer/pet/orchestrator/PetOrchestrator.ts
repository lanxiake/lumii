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
import type { PetIdleStage, PetPose } from '@mtbot/pet-core'
import {
  activityModulation,
  IDENTITY_MODULATION,
  initialAgentActivity,
  reduceAgentActivity,
  tickAgentActivity,
  type ActivityModulation,
  type AgentActivityEvent,
  type AgentActivityState,
} from '@mtbot/pet-core'
import { PET_MOTION_GROUP_UNNAMED } from '../config/pet-model-types'
import { PetBus } from './pet-bus'
import { bindPetEventAdapter } from './pet-event-adapter'
import { PetLipSync } from './PetLipSync'
import { PetFakeLipSync } from './PetFakeLipSync'
// pet-status-labels 对本模块只有 `import type`，所以这条反向依赖不会形成运行时环
import { resolveEmotionKeyByIndex } from '../utils/pet-status-labels'

const log = {
  info: (...args: unknown[]) => console.log('[PetOrchestrator]', ...args),
}

/** 待机随机动作的间隔范围（ms）：8~15s 随机，避免机械轮播 */
const IDLE_MOTION_MIN_MS = 8000
const IDLE_MOTION_MAX_MS = 15000
/**
 * 打盹时随机动作间隔的倍数：8~15s → 24~45s。
 *
 * 打盹要的是「明显变少」而不是「换个节奏」，所以是乘法不是平移；
 * 睡着则是**完全停掉**（见 canScheduleRandomIdle），不是把间隔再拉长。
 */
const IDLE_MOTION_DROWSY_FACTOR = 3
/** 对话结束后恢复随机待机动作的冷却时间（ms） */
const POST_DIALOGUE_IDLE_DELAY_MS = 10_000
/** 醒来反馈表情的停留时间（ms）：太短看不见，太长会盖住紧接着的对话表情 */
const WAKE_FEEDBACK_MS = 1200

/**
 * agentActivity 状态的推进周期（ms）。
 *
 * 取 ~60fps 而不是低频轮询：调制是连续量，采样率低于显示刷新率就会出现阶梯
 *（600ms 的平滑窗口里只有 6 个采样点时，每步跳 5% 的幅度，肉眼能看出「一格一格」）。
 * 宠物窗口设了 `backgroundThrottling: false`，失焦时不会被降频到 1s。
 */
const AGENT_ACTIVITY_TICK_MS = 16

/**
 * 打盹 / 睡着 / 醒来各自往 `emotionMap` 里找的表情名，**按序探测**，第一个命中的生效。
 *
 * 为什么要一串候选：模型之间的表情集差别很大（见计划 §七），没有一个名字是通用的。
 * - 打盹：demo 两兄弟是 `sleepy`（`eye_sleepy`）；`tired` 排最后是因为它在 demo 里
 *   指的是「无语/冷漠」（index 7 = `eye_half`），只有当模型没有更明确的「困」脸时才用它。
 * - 睡着：`闭眼` 排在 `calm` 前面——万一某个模型里 `calm` 指的是「平静」而不是「闭眼」，
 *   中文名不会歧义。
 * - 醒来：`shocked` 是「被吵醒」最贴切的一张；退而求其次用任何表示精神一振的表情。
 *
 * 全都没有时**脸上不演，只停动作**（与 P1-c/P2-a「不凭空造动作组」同一条原则）——
 * 那不是缺陷，是那类模型确实没有这张脸。
 */
const DROWSY_EMOTIONS = ['sleepy', '困', '打瞌睡', 'drowsy', 'tired']
const ASLEEP_EMOTIONS = ['闭眼', '睡着', 'sleep', 'calm']
const WAKE_EMOTIONS = ['shocked', '惊讶', 'surprise', 'surprised', 'joy', '开心']

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
  /** 用户闲置阶段（打盹/睡着）；控制坞据此显示「它睡着了」而不是让人以为卡死 */
  idleStage?: PetIdleStage
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

  /** 物理交互（抓取/投掷）进行中：暂停待机调度，见 setPicked */
  private interactionActive = false
  /**
   * 自主活动（R9）：驱动报上来的当前姿态。
   *
   * 与 `idleStage` 一样是**正交维度**，不进 `petStateMachine`：那边回答"宠物在跟用户
   * 对话吗"，这边回答"宠物自己溜达到哪一步了"。两者可以同时发生（边走边听）。
   */
  private ambientActivity: PetPose = 'stand'
  /** 活动对应的动作组；null = 没有（用基础待机组） */
  private ambientGroup: string | null = null
  /**
   * Agent 活动（R5/R6）：回答「**Agent 在干活吗**」。
   *
   * 与 `ambientActivity`（宠物自己溜达到哪一步）、`idleStage`（用户在场吗）一样是
   * **正交维度**，故不进 petStateMachine。状态与转移规则全在 pet-core 的纯函数里，
   * 这里只负责持有 + 按帧推进。
   */
  private agentActivity: AgentActivityState = initialAgentActivity
  /** 推进 agentActivity 的定时器（工具段迟滞与 blocked 回落都需要时间流逝，纯函数没有定时器） */
  private agentActivityTimer: ReturnType<typeof setInterval> | null = null
  /** 是否启用 Agent 活动感知（默认开；所有自主行为都必须能关，与 idleMotion 同规格） */
  private enableAgentActivity = true
  /** 上一次送出去的调制量：稳态时它与新值引用相等，可跳过 setter */
  private lastAgentModulation: ActivityModulation = IDENTITY_MODULATION
  /** 用户闲置阶段（P2-c）。**与环境有关，与对话生命周期正交**，故不进 petStateMachine */
  private idleStage: PetIdleStage = 'awake'
  /**
   * 打盹/睡着时**我们自己贴上去**的表情索引。
   *
   * 醒来时只回退「自己贴的那张脸」：别处的表情（`autonomous:mood:emotion`、
   * AI 的 [emotion] 标签）不受我们管辖，醒一次就把它们抹掉是越权。
   * null = 当前脸上没有我们的东西。
   */
  private idleFaceIndex: number | null = null
  /** 醒来反馈表情的回收定时器（见 playWakeFeedback） */
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
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
    idleStage: 'awake',
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

  // ---------------------------------------------------------------------------
  // Agent 活动感知（R5/R6）：把 Agent 的真实活动翻译成宠物的姿态底色
  // ---------------------------------------------------------------------------

  /**
   * 收一条 **Agent 语义事件**（真实事件名由 `PetModeShell` 用 `mapAgentEvent` 翻译好）。
   *
   * 只改状态、不算调制——调制由 {@link pumpAgentActivity} 每帧算，因为平滑吃的是
   * 「事件之间的时间」，而事件之间恰恰什么都没发生。
   */
  pushAgentActivity(event: AgentActivityEvent): void {
    if (!this.enableAgentActivity) return
    const now = performance.now()
    const next = reduceAgentActivity(this.agentActivity, event, now)
    if (next === this.agentActivity) return
    // 只在 **activity 档位**变化时报。`tool-end` 每次都返回新对象（toolCount 在涨），
    // 但它不改档位——照实打会刷出一串 `working → working`，把真正的切换淹掉。
    const changed = next.activity !== this.agentActivity.activity
    this.agentActivity = next
    if (!changed) return
    log.info(
      `[pushAgentActivity] ${next.previousActivity} → ${next.activity} ` +
        `(event=${event.type} tools=${next.toolCount})`,
    )
  }

  /** 当前 Agent 活动状态（只读，供调试与控制坞） */
  getAgentActivity(): AgentActivityState {
    return this.agentActivity
  }

  /**
   * 开关 Agent 活动感知。
   *
   * 关闭时必须**立刻还原恒等调制**，否则最后那一档姿态会挂在宠物身上：状态机不再被
   * 推进，也就不会有下一次 `setAgentActivityModulation` 去覆盖它——宠物会永远停在
   * 「忙」的呼吸幅度上。这是「开关要真的生效」与「关掉就没残留」的分界。
   */
  setEnableAgentActivity(enabled: boolean): void {
    if (this.enableAgentActivity === enabled) return
    this.enableAgentActivity = enabled
    log.info(`[setEnableAgentActivity] enabled=${enabled}`)
    if (enabled) return
    this.agentActivity = initialAgentActivity
    this.publishAgentModulation(IDENTITY_MODULATION)
  }

  private startAgentActivityLoop(): void {
    if (this.agentActivityTimer !== null) return
    this.agentActivityTimer = setInterval(() => this.pumpAgentActivity(), AGENT_ACTIVITY_TICK_MS)
  }

  private stopAgentActivityLoop(): void {
    if (this.agentActivityTimer === null) return
    clearInterval(this.agentActivityTimer)
    this.agentActivityTimer = null
  }

  /**
   * 每帧推进：先让状态机吃掉经过的时间（工具段迟滞、blocked 回落），再算调制交给渲染器。
   *
   * 时钟必须是 `performance.now()`——渲染器 `applyProcedural` 里的程序化原语用的是它。
   * 两边用不同时钟（比如这边 `Date.now()`）会让平滑按两条时间轴走，
   * 观感是"有时一顿、有时飞快"。
   */
  private pumpAgentActivity(): void {
    const now = performance.now()
    const ticked = tickAgentActivity(this.agentActivity, now)
    if (ticked !== this.agentActivity) {
      log.info(`[pumpAgentActivity] ${this.agentActivity.activity} → ${ticked.activity}（时间驱动）`)
      this.agentActivity = ticked
    }

    // 抓取/投掷期间完全不表达：用户手动交互优先于一切自动表达。
    // 状态机照常推进（时间在流逝，松手后该是什么状态就是什么状态），只是不往外送。
    this.publishAgentModulation(
      this.interactionActive ? IDENTITY_MODULATION : activityModulation(this.agentActivity, now),
    )
  }

  /**
   * 送给渲染器。**稳态时跳过**——`activityModulation` 在插值期间每帧返回新对象，
   * 但到达目标后返回的是表里的常量对象（引用相等），此时不必再走一次 setter。
   */
  private publishAgentModulation(mod: ActivityModulation): void {
    if (mod === this.lastAgentModulation) return
    this.lastAgentModulation = mod
    this.renderer.setAgentActivityModulation?.(mod)
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
      // 被抓着/在飞的时候不调度：待机动作会把模型拽回待机姿态，与物理状态打架
      !this.interactionActive &&
      // 睡着时不调度：呼吸（程序化原语）继续跑，停的是随机动作
      this.idleStage !== 'asleep' &&
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
    this.startAgentActivityLoop()
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
    // 被抓着/在飞的时候不待机：待机动作与"被拎起来"的物理状态是冲突的，
    // 而且待机调度会周期性把模型拽回待机姿态
    if (this.interactionActive) {
      log.info('[enterIdle] 物理交互进行中（被抓/在飞），跳过待机动作')
      return
    }
    this.idling = true
    // 对话结束时兜底把闲置阶段的表情落回来：对话开始时我们故意没动脸（见 applyIdleStage），
    // 若这期间用户一直没回来（宠物仍睡着），现在轮到我们演了。
    if (this.idleStage !== 'awake' && this.canShowIdleFace()) this.applyIdleFace()
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
      // 无装饰随机源时的基础待机，**两种后端的行为不同**：
      //
      // - Live2D（autoLoopsIdle 省略）：待机完全交给库原生续播（库已在循环 groups.idle）。
      //   此处绝不能手动 playMotion(idle)——会与库的 IDLE 预约冲突被拦截，
      //   且动作播完会卡在末帧（库正是靠自动续播脱离末帧）。
      // - sprite（autoLoopsIdle === false）：后端只播 playMotion 启动的东西，
      //   不会自己动。不在这里启动，模型就永远停在第一帧——实测表现是「宠物完全不会动」。
      if (this.renderer.autoLoopsIdle === false) {
        // 自主活动优先：宠物在走/在坐时就播那一组，否则播基础待机。
        // 这一句是「环境动作」与「待机」的**唯一汇合点**——驱动只管报状态，
        // 由这里按既有优先级决定播什么。
        this.renderer.playMotion(this.ambientGroup ?? group)
      }
      this.patchStatus({
        phase: 'idle',
        motionKind: this.inPostDialogueCooldown ? 'cooldown' : 'idle',
        motionGroup: this.ambientGroup ?? this.idleGroup,
      })
    }
  }

  /**
   * 抓取/释放（场景 A）。
   *
   * 「被拎起」是**物理**状态，与 `petStateMachine` 那套**对话**生命周期
   * （idle/listening/thinking/speaking）正交——硬塞进状态机会让两个维度互相干扰。
   * 所以这里只用一个布尔标记，作用是：暂停待机调度 + 播约定组的动作。
   *
   * @param picked true = 被抓起来了；false = 松手（接下来是自由落体）
   */
  setPicked(picked: boolean): void {
    this.interactionActive = picked
    if (picked) {
      this.playConventionalMotion('Picked')
      return
    }
    // 松手：物理上接下来是抛物线（由画布负责），表现上该是下落姿势。
    // 用 `Fall` 而不是别的：它在这个模型里是**循环**组——掉多久是物理事实，
    // 不是动画时长，一次性动作会在半空中就播完。
    this.playConventionalMotion('Fall')
  }

  /**
   * 落地。播一次型「落地」动作（模型声明了才播），随后由渲染器按 `next` 回待机。
   */
  notifyLanded(): void {
    this.interactionActive = false
    // 模型没声明 Landing 组时**必须显式回环境动作**：不接这一步的话，
    // 宠物会停在 Fall 的最后一帧上——落地了还保持下落姿势（Shimeji 就没有 Landing 组）。
    // 这不是"退化"，是"用现有的东西把状态机接回去"。
    if (!this.playConventionalMotion('Land') && this.idling) {
      this.playAmbientMotion()
    }
  }

  /**
   * 自主活动（R9）：空闲游走驱动报上来的「该走 / 该坐 / 该站」。
   *
   * 只把结果记成一个**环境动作组**，播不播由 `enterIdle` 决定——那里已经有整套优先级
   * （对话中跳过、物理交互中跳过、闲置阶段降频）。驱动不直接调 `playMotion`，是为了
   * 保持「渲染器的动作入口只有一个写者」：两个写者会互相打断，且谁都不知道对方在干嘛，
   * 表现为动作播到一半被另一个来源切走。
   *
   * 模型没有对应动作组时**静默回落到基础待机**（Live2D 模型普遍没有 Walk/Sit）——
   * 那不是错误，是正常的后端能力差异，不该报错也不该随便挑个动作顶上。
   */
  setAmbientActivity(pose: PetPose): void {
    if (this.ambientActivity === pose) return
    this.ambientActivity = pose
    this.ambientGroup = this.resolveAmbientGroup(pose)
    log.info(
      `[setAmbientActivity] ${pose} → 组 "${this.ambientGroup ?? '(基础待机)'}"`,
    )
    // 正在待机就立刻体现；对话/交互进行中不打扰，等下一次 enterIdle 自然生效
    if (this.idling && !this.dialogueActive && !this.interactionActive) {
      this.playAmbientMotion()
    }
  }

  /** 姿态 → 动作组名。`stand` 返回 null，表示"用基础待机组" */
  private resolveAmbientGroup(pose: PetPose): string | null {
    const want =
      pose === 'walk'
        ? 'Walk'
        : pose === 'sit'
          ? 'Sit'
          : pose === 'climb'
            ? 'Climb'
            : pose === 'crawl'
              ? 'Crawl'
              : pose === 'fall'
                ? 'Fall'
                : null
    if (!want) return null
    // 模型没有这一组时静默回落到基础待机。**攀爬尤其常见**——Live2D 模型不可能有
    // Climb/Crawl，而驱动那边照样会把姿态报上来（它不知道后端有没有那个动作组）
    return this.renderer.getMotionCount(want) > 0 ? want : null
  }

  /** 播当前环境动作（没有环境动作就用基础待机组） */
  private playAmbientMotion(): void {
    const group = this.ambientGroup ?? this.resolveIdleMotionGroup()
    if (this.renderer.getMotionCount(group) <= 0) return
    this.renderer.playMotion(group)
  }

  /**
   * 播放**约定组名**的动作；模型没声明这一组时静默跳过。
   *
   * 不报错也不退化成随便播一个：语义不对的动作比不播更糟（与 P1-c 里
   * 「不凭空造动作组」同一条原则）。
   *
   * @returns 是否真的播了
   */
  private playConventionalMotion(group: string): boolean {
    if (this.renderer.getMotionCount(group) <= 0) return false
    log.info(`[playConventionalMotion] 播放约定动作组 "${group}"`)
    this.renderer.playMotion(group)
    return true
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
    // 对话要开始了：取消醒来反馈的回收定时器，别让 1.2s 后的一刀盖住 AI 刚设的表情。
    // exitIdle 的三个调用方（setDialogueActive(true) / startTextReply / startSpeaking）
    // 恰好都是「对话开始」，放在这里比在每处各写一遍可靠。
    this.clearWakeFeedback()
  }

  /** 安排下一次随机待机动作（醒着 8~15s，打盹 ×3） */
  private scheduleNextIdleMotion(): void {
    if (!this.canScheduleRandomIdle()) return
    this.clearIdleMotionTimer()
    const factor = this.idleStage === 'drowsy' ? IDLE_MOTION_DROWSY_FACTOR : 1
    const delay =
      (IDLE_MOTION_MIN_MS + Math.random() * (IDLE_MOTION_MAX_MS - IDLE_MOTION_MIN_MS)) * factor
    this.idleTimer = setTimeout(() => {
      if (!this.idling || !this.canScheduleRandomIdle()) return
      log.info('[scheduleNextIdleMotion] 触发随机待机')
      this.playRandomIdleNow()
      this.scheduleNextIdleMotion()
    }, delay)
  }

  /**
   * 用户闲置阶段变更（P2-c，由 PetModeShell 从主进程事件转来）。
   *
   * 「用户离开/回来」是**环境**状态，与 `petStateMachine` 那套**对话**生命周期
   * （idle/listening/thinking/speaking）正交——硬塞进去会让两个维度互相干扰。
   * 照抄 `setPicked` 的先例：只用一个标记影响待机调度与表情。
   *
   * 幂等：同一阶段重复到达直接返回（主进程已经只在变化时发，这里是第二道保险）。
   */
  setIdleStage(stage: PetIdleStage): void {
    if (stage === this.idleStage) return
    const prev = this.idleStage
    this.idleStage = stage
    log.info(`[setIdleStage] ${prev} → ${stage}`)
    this.patchStatus({ idleStage: stage })
    this.applyIdleStage(prev)
  }

  /**
   * 把当前阶段落到「随机动作调度 + 表情」上。
   *
   * 对话期间**只登记状态、不动脸**：AI 正在演它自己的表情，睡眠/唤醒的表情会把它盖掉
   * （真正要紧的那半件事——睡着时不播随机动作——由 `canScheduleRandomIdle` 的闸门保证，
   * 而对话中那个闸门本来就是关的）。等对话结束走 `enterIdle` 时会重新落一次表情。
   */
  private applyIdleStage(prev: PetIdleStage): void {
    const stage = this.idleStage

    if (stage === 'awake') {
      if (this.canShowIdleFace()) {
        // 「被吵醒」只在**确实是我们把它哄睡的那张脸**上播。若这期间别处已经改过表情
        // （mood 事件 / AI 的表情标签），那就没有「从睡到醒」这回事，不该横插一手。
        if (prev === 'asleep' && this.ownsIdleFace()) this.playWakeFeedback()
        else this.revertIdleFace()
      }
      // 睡着期间定时器是停的，醒来要重新起一轮；打盹改回正常间隔
      if (this.idling && !this.speaking && !this.dialogueActive && !this.inPostDialogueCooldown) {
        this.scheduleNextIdleMotion()
      }
      return
    }

    // 打盹：换成更长的间隔重排；睡着：直接停掉（canScheduleRandomIdle 也会拦住）
    this.clearIdleMotionTimer()
    if (stage === 'drowsy' && this.idling) this.scheduleNextIdleMotion()
    if (this.canShowIdleFace()) this.applyIdleFace()
  }

  /** 此刻是否适合由闲置感知改表情（对话/说话/冷却中都不适合） */
  private canShowIdleFace(): boolean {
    return !this.dialogueActive && !this.speaking && !this.inPostDialogueCooldown
  }

  /** 按当前阶段贴睡眠表情；模型没有对应表情时脸上不演（只停动作） */
  private applyIdleFace(): void {
    const candidates = this.idleStage === 'asleep' ? ASLEEP_EMOTIONS : DROWSY_EMOTIONS
    const hit = this.findEmotion(candidates)
    if (!hit) {
      log.info(
        `[applyIdleFace] ${this.idleStage}：模型没有对应表情（找过 ${candidates.join('/')}），只停动作不动脸`,
      )
      return
    }
    this.idleFaceIndex = hit.index
    this.setExpression(hit.index, hit.name)
  }

  /**
   * 当前脸上是不是**我们自己贴的那张**睡眠表情。
   *
   * 与 `status.expressionIndex` 比而不是与渲染器比：编排器里所有改表情的路径都会
   * `patchStatus({expressionIndex})`，status 就是「编排器认知里的当前表情」。
   */
  private ownsIdleFace(): boolean {
    return this.idleFaceIndex !== null && this.status.expressionIndex === this.idleFaceIndex
  }

  /**
   * 醒来：把**我们自己贴的那张脸**换回默认表情。
   *
   * 只认自己贴的那张：`autonomous:mood:emotion` 或 AI 的 [emotion] 标签留下的表情
   * 不归闲置感知管，醒一次就把它们抹掉是越权。
   */
  private revertIdleFace(): void {
    const ours = this.idleFaceIndex
    this.idleFaceIndex = null
    if (ours === null) return
    if (this.status.expressionIndex !== ours) {
      log.info(`[revertIdleFace] 当前表情 index=${this.status.expressionIndex} 不是我们贴的，保留`)
      return
    }
    this.resetExpressionToDefault()
  }

  /**
   * 从**睡着**醒来时给一次「被吵醒」的反馈（§3.5），随后回到默认表情。
   *
   * 只切表情、不播动作：模型规格里没有「醒来」这个约定动作组，
   * 为一个功能凭空造一组正是 P1-c/P2-a 反复警告过的事（模型没声明的组播不出来）。
   */
  private playWakeFeedback(): void {
    this.clearWakeFeedback()
    const hit = this.findEmotion(WAKE_EMOTIONS)
    if (!hit) {
      this.revertIdleFace()
      return
    }
    log.info(`[playWakeFeedback] 醒来反馈 ${hit.name}（index=${hit.index}）`)
    this.idleFaceIndex = null
    this.setExpression(hit.index, hit.name)
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.resetExpressionToDefault()
    }, WAKE_FEEDBACK_MS)
  }

  /** 取消醒来反馈的回收定时器（对话开始时用：别让 1.2s 后的一刀盖住 AI 刚设的表情） */
  private clearWakeFeedback(): void {
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = null
    }
  }

  /** 回到模型声明的默认表情 */
  private resetExpressionToDefault(): void {
    const idx = this.modelConfig?.defaultExpression ?? 0
    const key = resolveEmotionKeyByIndex(this.modelConfig?.emotionMap ?? {}, idx)
    this.setExpression(idx, key)
  }

  /** 在 emotionMap 里按候选名顺序找第一个存在的表情（模型之间表情名差别很大，见计划 §七） */
  private findEmotion(names: string[]): { name: string; index: number } | null {
    const map = this.modelConfig?.emotionMap ?? {}
    for (const name of names) {
      const index = map[name]
      if (typeof index === 'number') return { name, index }
    }
    return null
  }

  /** 可观测：当前口型延迟 */
  getLipSyncLatencyMs(): number {
    return this.lipSync.getLastLatencyMs()
  }

  /** 解绑全部监听，释放资源 */
  dispose(): void {
    this.exitIdle()
    this.clearPostDialogueCooldown()
    this.stopAgentActivityLoop()
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
