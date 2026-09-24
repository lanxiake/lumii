/**
 * PetModeShell - 宠物模式外壳组件
 *
 * 设计依据：00-修订版设计 §2.1
 *
 * 组合：PetCanvas（Live2D 渲染）+ PetOrchestrator（语音状态→动画+口型）
 *       + PetControlDock（统一控制坞，参考 OLV InputSubtitle）。
 * 语音链路在本窗口自跑（D4）：useVoiceCall 的麦克风采集 + TTS 播放都在宠物窗口。
 *
 * **本窗口的主题跟随是"定向"的**：`main.tsx` 直接渲染本组件，**不挂 `AppProviders`**
 * （含 `ThemeProvider`），所以没有现成的 `data-theme`。2026-09-23 依用户实测反馈
 * （「气泡的颜色和文字颜色跟随主题变化」）加了一条**只读**跟随，见 `utils/pet-theme.ts`：
 * 读共享的 localStorage + 订阅 `storage` 事件，结果写到 `<html>` 上。
 *
 * ⚠️ **目前只有气泡在用**。坞、粒子、头顶符号仍用各自的自带常量 —— 宠物是浮在桌面上的
 * 独立层，**整层**跟着主窗变米黄色是当年明确否掉的（`07-主题色系/12-canvas与宠物色层收敛.md`
 * §3.2）。别把这条跟随当成"整个宠物层统一到令牌"的开工信号。
 */

import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { usePetMode } from './hooks/usePetMode'
import { PetCanvas, type PetCanvasHandle, type PetCanvasDegradeReason, setTapModelConfig, setTapInteractionEnabled } from './components/PetCanvas'
import { PetControlDock } from './components/PetControlDock'
import { PetSpeechBubble } from './components/PetSpeechBubble'
import { PetStatusGlyph } from './components/PetStatusGlyph'
import { PetContextMenu } from './components/PetContextMenu'
import { spawnClickFireworks, spawnIdleSparkles } from './components/pet-particles'
import { PetOrchestrator, type PetAvatarStatus } from './orchestrator/PetOrchestrator'
import { PetEmotionMapper } from './orchestrator/PetEmotionMapper'
import { mapAgentEvent, pendingNotices, type PetIdleStage, type PetNotice } from '@mtbot/pet-core'
import { useVoiceCall } from '../hooks/business/useVoiceCall/useVoiceCall'
import { useAgentRuntimeActions } from '../hooks/business/useAgentRuntime/useAgentRuntime'
import type { PetModelConfig } from './config/pet-model-types'
import type { PetRendererProvider } from './renderer/types'
import { petMetrics } from './telemetry/pet-metrics'
import { PetDebugOverlay } from './components/PetDebugOverlay'
import { resolvePetSessionKey } from './utils/resolve-pet-session'
import {
  resolveAgentId,
  stripVirtualHumanTags,
  VH_STORAGE_KEYS,
  DEFAULT_VH_SETTINGS,
  type VirtualHumanSettingsDTO,
} from '../../shared/virtual-human'
import type { PetChatMessage } from './components/PetControlDock'
import type { PetModelConfigDTO } from '../../shared/pet-mode'
import { resolveEmotionKeyByIndex } from './utils/pet-status-labels'
import { pickStatusGlyph } from './utils/pet-status-glyph'
import {
  EMPTY_SESSION_ACTIVITY,
  foreignAttention,
  isSessionActivityEvent,
  otherSessions,
  reduceSessionActivity,
  sweepStale,
  type SessionActivityState,
} from './utils/session-activity'
import { readPersistedSessionThinkingPrefs } from '../../shared/session-thinking-prefs'
import { notifyDesktop } from '../services/app-service'
import { petSessionMatchesEvent } from './utils/pet-session-match'
import { applyPetTheme, readPetTheme, subscribePetTheme } from './utils/pet-theme'
import {
  INITIAL_TURN_FACTS,
  advanceTurnFacts,
  isNoticeEvent,
  noticeActionLabel,
  toNoticeEvent,
  type NoticeTurnFacts,
  type RawAgentEvent,
} from './utils/pet-notice-adapter'

const log = {
  info: (...args: unknown[]) => console.log('[PetModeShell]', ...args),
  warn: (...args: unknown[]) => console.warn('[PetModeShell]', ...args),
  error: (...args: unknown[]) => console.error('[PetModeShell]', ...args),
}

/**
 * 解析语音通话使用的 Agent ID（resolveAgentId 三优先级，06 号 §3.3）。
 * 设置来自主进程 VH store；兼容旧 localStorage 键。
 */
async function resolveVoiceAgentId(modelAgentId?: string): Promise<string | undefined> {
  let settings: VirtualHumanSettingsDTO = { ...DEFAULT_VH_SETTINGS }
  try {
    const s = await window.electronAPI?.pet?.getVirtualHumanSettings?.()
    if (s) settings = s
  } catch {
    // 回退默认 + 兼容旧键
    const legacy = localStorage.getItem(VH_STORAGE_KEYS.legacyAgentId)
    if (legacy) settings = { ...settings, agentId: legacy, followModelAgent: false }
  }
  return resolveAgentId({ settings, modelAgentId })
}

export const PetModeShell: React.FC = () => {
  const { currentMode, currentModelId, exitPetMode } = usePetMode()
  const canvasRef = useRef<PetCanvasHandle>(null)
  const orchestratorRef = useRef<PetOrchestrator | null>(null)
  /** 编排器当前绑定的渲染器实例（跨后端换模型时会换实例，见 handleModelLoaded） */
  const orchestratorRendererRef = useRef<PetRendererProvider | null>(null)
  const emotionMapperRef = useRef<PetEmotionMapper | null>(null)
  const modelConfigRef = useRef<PetModelConfig | null>(null)
  const sessionKeyRef = useRef<string>('')
  /** 当前模式引用：退出后 (desktop) 阻止文字输入/事件再次拉起语音管线（需求2 连锁反应根因） */
  const currentModeRef = useRef(currentMode)
  useEffect(() => {
    currentModeRef.current = currentMode
  }, [currentMode])

  /**
   * 主题跟随（**只读**，见 `utils/pet-theme.ts`）。
   *
   * 挂在最靠前的位置：气泡的底与字用 `--mt-*` 令牌，而令牌要 `<html>` 上有
   * `data-theme` 才是主窗那一套值（否则取 `:root` 的深色兜底）—— 晚一拍就会先冒一个
   * 深色气泡再闪成浅色。订阅只能走 `storage` 事件：主窗切主题时只写它自己的
   * localStorage，跨窗没有别的通道（主进程不知道主题）。
   */
  useEffect(() => {
    applyPetTheme(readPetTheme())
    return subscribePetTheme(applyPetTheme)
  }, [])
  /** 声音开关：开=文字回复出声(真音频口型)，关=静默(伪口型)。从 VH 设置同步。 */
  const enableVoiceReplyRef = useRef<boolean>(DEFAULT_VH_SETTINGS.enableVoiceReply)
  const enableIdleMotionRef = useRef<boolean>(DEFAULT_VH_SETTINGS.enableIdleMotion)
  /** Agent 活动感知（R5/R6）：关掉后宠物不再随 Agent 的思考/工具/等待改姿态 */
  const enableAgentActivityRef = useRef<boolean>(DEFAULT_VH_SETTINGS.enableAgentActivity)
  /** Agent 通知（R6「叫得动」）：关掉后不冒通知气泡、控制坞也不列待办 */
  const enableAgentNoticeRef = useRef<boolean>(DEFAULT_VH_SETTINGS.enableAgentNotice)
  const enableTapInteractionRef = useRef<boolean>(DEFAULT_VH_SETTINGS.enableTapInteraction)
  /**
   * 最近一次收到的闲置阶段。
   *
   * 编排器要等模型加载完才建，而主进程**只在阶段变化时**推事件：不在这里存一份，
   * 「首推就是 asleep」（CLI/智能体在用户不在时拉起宠物模式）那次会丢，
   * 宠物会一直醒着直到下一次阶段变化——而下次变化要等到用户回来，即永远不睡。
   */
  const idleStageRef = useRef<PetIdleStage>('awake')
  /**
   * 主窗当前是否聚焦。**与 `idleStageRef` 同一个理由**：焦点订阅在挂载时就跑了，
   * 而编排器要等模型加载完才建——不在这里存一份，订阅到的那次（以及补问的那次）
   * 会喂给 `null`，编排器建好后一直以为主窗是聚焦的，"用户走开了"这条判据就永不成立。
   */
  const mainWindowFocusedRef = useRef<boolean | undefined>(undefined)
  const [degrade, setDegrade] = useState<PetCanvasDegradeReason | null>(null)
  const [modelLoaded, setModelLoaded] = useState(false)
  const [muted, setMuted] = useState(false)
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(DEFAULT_VH_SETTINGS.enableVoiceReply)
  const [idleMotionEnabled, setIdleMotionEnabled] = useState(DEFAULT_VH_SETTINGS.enableIdleMotion)
  /**
   * L4 气泡（R5/R6）：一句话 + 冒出来那一刻的锚点。
   *
   * **位置一次性取，不做每帧跟随**：跟一遍就得每帧 setState，那会让整个
   * PetModeShell 重渲染（连带 PetCanvas）。而气泡只活几秒、宠物走得也不快，
   * 跟着走带来的观感提升抵不上这个开销。宠物真走远了，下一次冒泡自然在对的位置。
   */
  const [bubble, setBubble] = useState<{
    text: string
    x: number
    y: number
    petHeight: number
    /**
     * 有值 = 这条气泡来自**通知**（任务完成/等你审批/提问），带一个可点的按钮。
     *
     * 它同时决定气泡**可不可点**：只读的状态句（还在忙…）不该拦鼠标，而通知气泡
     * 不点就等于没送到——「看得见、点不动」正是设计里要消灭的那个状态。
     */
    notice?: PetNotice
  } | null>(null)
  /** 气泡的撤下定时器（新气泡来了要清掉旧的，否则旧 TTL 会把新气泡误撤） */
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 右键菜单的位置。null = 不显示。
   *
   * 菜单是**瞬时**的：点外部、Esc、滚轮、选中任一项都会关掉它。
   */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  /**
   * 对话面板（控制坞）是否展开。**默认关**。
   *
   * 宠物模式下的屏幕该是干净的——一只宠物在桌面上，如此而已。所有选项收在右键菜单里，
   * 要聊天再从菜单打开。这一条是产品取向，不是省事：常驻面板会把"桌宠"变成"小窗口应用"。
   */
  const [dockOpen, setDockOpen] = useState(false)
  useEffect(
    () => () => {
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)
    },
    [],
  )
  const [avatarStatus, setAvatarStatus] = useState<PetAvatarStatus | null>(null)
  /**
   * 状态的最新值，供**定时器/回调**读取。
   *
   * 头顶符号与待机特效都要问「现在是什么状态」，但它们跑在定时器里，
   * 不能进依赖数组（进了就每次状态变化都重建定时器，随机间隔被重置，
   * 特效可能永远等不到）。所以镜像一份 ref。
   */
  const avatarStatusRef = useRef<PetAvatarStatus | null>(null)
  avatarStatusRef.current = avatarStatus
  /**
   * 多会话运行态（谁在跑、谁在等你出手）。
   *
   * **只有这一个宠物**，而同时可能有多个 Agent/会话在跑（聊天会话、cron 自省、
   * 子 Agent……）。定下来的规矩（用户 2026-09-22 挑的）：
   * 主体演当前会话；**"需要你出手"的事跨会话抢占头顶符号**；其余只在控制坞里可见。
   * 计数与判据都在 `session-activity` 里，这里只负责喂数据与展示。
   */
  const [sessionRuns, setSessionRuns] = useState<SessionActivityState>(EMPTY_SESSION_ACTIVITY)
  /**
   * 待办通知（R6「叫得动」）。与 `sessionRuns` 是两件事：那边是"**谁**在跑"（纯展示），
   * 这边是"**哪件事**不做就永远不动"（要处置）。同样**跨会话**——不按主体过滤。
   */
  const [notices, setNotices] = useState<readonly PetNotice[]>([])
  /** 本轮的两个"事实"（`hasTaskComplete` / `userInitiated`）：事件里没有，得宿主自己数 */
  const noticeTurnFactsRef = useRef<NoticeTurnFacts>(INITIAL_TURN_FACTS)
  /**
   * 已经**处置过**的 notice id（发过系统通知 / 放过完成粒子）。
   *
   * `noticeListener` 推的是全量列表、而且每次变化（含 TTL 清理）都会推，
   * 所以"这条要不要动手"靠差集判——没有这道闸，一次审批能弹三遍
   * （重放、tick、重绑各一次）。
   */
  const alertedNoticeIdsRef = useRef<Set<string>>(new Set())
  /** 控制坞的待办清单：未销账、`action` 在前、`ambient` 不列（排序规则在 pet-core 里） */
  const pendingNoticeList = useMemo(() => pendingNotices(notices), [notices])
  /**
   * 气泡与头顶符号每帧的锚点（**跟着宠物走**）。
   *
   * 空依赖 → 引用稳定 → 两个组件内部的 rAF effect 不会反复重建（那会让跟随一顿一顿的）。
   * 位置读的是渲染器的实时坐标，所以宠物走动/被拖走时都跟得上。
   *
   * `contentTop` 是**内容实测**的上伸量（`getContentExtents` 按动作组缓存，每帧只是查表）。
   * 有它才能把气泡贴到真正的头顶：站着 / 趴着 / 倒挂三种姿势的身高差得远，用
   * `petHeight` 近似会让气泡在矮姿势时浮在半空、高姿势时嵌进脑袋。Live2D 后端没实现
   * 这个接口，那时退回身高。
   */
  const getPetAnchor = useCallback(() => {
    const renderer = canvasRef.current?.getRenderer()
    const pos = renderer?.getPosition?.()
    if (!pos) return null
    const layout = renderer?.getLayout?.()
    const contentTop = renderer?.getContentExtents?.()?.top
    return {
      x: pos.x,
      y: pos.y,
      petHeight: layout?.modelHeight ?? 200,
      ...(contentTop !== undefined ? { contentTop } : {}),
    }
  }, [])

  /**
   * 把用户送到那张卡前面。
   *
   * 三步里前两步（主窗前台 + 切会话）在 S2 就有了，第三步——**把那张审批卡滚进视野并高亮**
   * ——是 S3 的深链：走 `pet:focus-notice`，把 `requestId` 一并交给主窗。
   * 卡已经不在（用户在主窗刚处置过）时主窗会安静降级为"只切会话"，不是错误。
   *
   * 点完必须撤气泡：不撤的话用户会以为没反应，而通知本体还在控制坞里挂着（销账只认事件）。
   */
  const handleFocusNotice = useCallback((notice: PetNotice) => {
    if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)
    bubbleTimerRef.current = null
    setBubble(null)
    const requestId =
      notice.deepLink?.to === 'permission' || notice.deepLink?.to === 'ask-user'
        ? notice.deepLink.requestId
        : undefined
    void window.electronAPI?.pet?.focusNotice?.({ sessionKey: notice.sessionKey, requestId })?.catch?.(() => {})
  }, [])
  /** 别处等你出手（waiting/error），用来抢头顶符号 */
  const attention = useMemo(
    () => foreignAttention(sessionRuns, sessionKeyRef.current),
    [sessionRuns],
  )
  /** 其余在跑的会话（控制坞展示；不参与任何动画） */
  const otherRuns = useMemo(() => otherSessions(sessionRuns, sessionKeyRef.current), [sessionRuns])
  /**
   * 隔一会儿扫一遍：`turn:end` 是事件，丢了（窗口重载、渲染进程忙）就永远留在表里，
   * 控制坞会一直说"另有 1 个会话在跑"，而它其实早就结束了。
   */
  useEffect(() => {
    const id = setInterval(
      () => setSessionRuns((prev) => sweepStale(prev, performance.now())),
      60_000,
    )
    return () => clearInterval(id)
  }, [])
  /**
   * 头顶符号：把"它现在在干什么"写成一个字。
   *
   * 这是用户 2026-09-22 那条要求（「待机不要左右和上下移动……需要添加特效」）的
   * 另一半——位移去掉之后，可读信号得从别处补回来。取值规则见 `pickStatusGlyph`。
   */
  const glyph = useMemo(
    () =>
      pickStatusGlyph({
        phase: avatarStatus?.phase ?? 'idle',
        idleStage: avatarStatus?.idleStage,
        agentActivity: avatarStatus?.agentActivity,
        // 只把"最急的那个"传下去：同一个符号位放不下第二个状态，
        // 而 waiting 比 error 更可操作（卡住多半是没人理它的后果）
        foreignAttention: attention[0]
          ? attention[0].state === 'error'
            ? 'error'
            : 'waiting'
          : undefined,
      }),
    [avatarStatus, attention],
  )
  /** 符号的锚点：**符号变了才重取位置**，不每帧跟随（与气泡同一取舍，见上方注释） */
  const [glyphAnchor, setGlyphAnchor] = useState<{
    x: number
    y: number
    petHeight: number
  } | null>(null)
  useEffect(() => {
    if (!glyph) {
      setGlyphAnchor(null)
      return
    }
    const renderer = canvasRef.current?.getRenderer()
    const pos = renderer?.getPosition?.()
    const layout = renderer?.getLayout?.()
    setGlyphAnchor({ x: pos?.x ?? 0, y: pos?.y ?? 0, petHeight: layout?.modelHeight ?? 200 })
  }, [glyph?.char, glyph?.tone])
  /** 可切换的 Live2D 模型列表（控制坞下拉展示） */
  const [models, setModels] = useState<PetModelConfigDTO[]>([])
  /** 聊天记录（用户+AI，内存态轻量展示；后台已由 user:send 落 DB）。 */
  const [messages, setMessages] = useState<PetChatMessage[]>([])
  /** 当前正在累积的 assistant 消息 id（流式 delta 累加目标） */
  const streamingIdRef = useRef<string | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [autoMuteMicWhileSpeaking, setAutoMuteMicWhileSpeaking] = useState(true)
  const [vadThreshold, setVadThreshold] = useState(0.5)
  const [energyGateMultiplier, setEnergyGateMultiplier] = useState(1.5)

  /** 加载语音引擎配置，同步闭麦/阈值到控制坞 */
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    api.voice.sendCommand({ type: 'voice:config:get' }).then((cfg: any) => {
      if (cfg?.autoMuteMicWhileSpeaking !== undefined) setAutoMuteMicWhileSpeaking(cfg.autoMuteMicWhileSpeaking)
      if (cfg?.vad?.threshold !== undefined) setVadThreshold(cfg.vad.threshold)
      if (cfg?.vad?.energyGateMultiplier !== undefined) setEnergyGateMultiplier(cfg.vad.energyGateMultiplier)
    }).catch(() => {
      console.warn('[PetModeShell] 获取语音配置失败')
    })
  }, [])

  /** 修改语音引擎配置（合并持久化，主进程广播热更新） */
  const handleChangeVoiceSetting = useCallback(
    (patch: { autoMuteMicWhileSpeaking?: boolean; vad?: { threshold?: number; energyGateMultiplier?: number } }) => {
      const api = (window as any).electronAPI
      if (!api?.voice?.sendCommand) return
      api.voice.sendCommand({ type: 'voice:config:set', config: patch })
      if (patch.autoMuteMicWhileSpeaking !== undefined) setAutoMuteMicWhileSpeaking(patch.autoMuteMicWhileSpeaking)
      if (patch.vad?.threshold !== undefined) setVadThreshold(patch.vad.threshold)
      if (patch.vad?.energyGateMultiplier !== undefined) setEnergyGateMultiplier(patch.vad.energyGateMultiplier)
    },
    [],
  )

  const [voiceState, voiceActions] = useVoiceCall()
  const agentActions = useAgentRuntimeActions()

  /**
   * 将对话页持久化的思考偏好同步到主进程（宠物窗独立会话或未经过 ChatPage 时默认会误开思考）。
   */
  const syncSessionThinkingPrefs = useCallback(
    async (sessionKey: string) => {
      const prefs = readPersistedSessionThinkingPrefs()
      await agentActions.setSessionThinkingPrefs(sessionKey, prefs)
      // 全局默认一并同步：渠道会话/心跳/cron 跟随对话页开关
      await agentActions.setGlobalThinkingPrefs(prefs)
      log.info(
        `思考偏好已同步 sessionKey=${sessionKey} enabled=${prefs.thinkingEnabled} effort=${prefs.reasoningEffort}`,
      )
    },
    [agentActions],
  )

  // 持有最新的同步函数引用，使 mount 预绑定副作用可用空依赖 [] 真正只跑一次，
  // 不再因任何上游 identity 变化而反复触发 activateVirtualHumanContext（多轮对话崩溃根因）。
  const syncThinkingPrefsRef = useRef(syncSessionThinkingPrefs)
  useEffect(() => {
    syncThinkingPrefsRef.current = syncSessionThinkingPrefs
  }, [syncSessionThinkingPrefs])

  const handleDegrade = useCallback((reason: PetCanvasDegradeReason) => {
    log.info(`降级: ${reason.kind} - ${reason.message}`)
    setDegrade(reason)
  }, [])

  /** 追加一条完整消息（用户输入 / 语音识别定稿） */
  const appendMessage = useCallback((role: PetChatMessage['role'], text: string) => {
    const id = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setMessages((prev) => [...prev, { id, role, text }])
    return id
  }, [])

  /** 开启一条空的流式 assistant 消息（先清理历史空气泡，避免重复显示「…」） */
  const beginAssistantStream = useCallback(() => {
    const id = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    streamingIdRef.current = id
    setMessages((prev) => {
      const trimmed = prev.filter((m) => m.role !== 'assistant' || m.text.trim().length > 0)
      return [...trimmed, { id, role: 'assistant', text: '' }]
    })
    return id
  }, [])

  /** 确保当前轮次有一条可写入的 assistant 流式气泡 */
  const ensureAssistantStream = useCallback(() => {
    if (streamingIdRef.current) return streamingIdRef.current
    return beginAssistantStream()
  }, [beginAssistantStream])

  /** 把 delta 累加到当前流式 assistant 消息 */
  const appendAssistantDelta = useCallback((delta: string) => {
    const id = streamingIdRef.current
    if (!id) return
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m)),
    )
  }, [])

  /** 流式结束时用完整文本兜底（delta 未送达时仍能展示字幕） */
  const finalizeAssistantStream = useCallback((fullText: string) => {
    const id = streamingIdRef.current
    if (!id || !fullText) return
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, text: fullText } : m)),
    )
  }, [])

  // 模型加载成功 → 创建/复用编排器 + 表情解析器（模型热切换时复用，不重建，避免 IPC 监听泄漏）
  const handleModelLoaded = useCallback((config: PetModelConfig) => {
    setTapModelConfig(config)
    setModelLoaded(true)
    modelConfigRef.current = config

    const renderer = canvasRef.current?.getRenderer()
    if (!renderer) return

    /**
     * **渲染器换了实例就必须重建编排器。**
     *
     * 编排器把渲染器存在构造函数里（`private readonly renderer`）。同后端换模型时
     * 实例不变（canvas 的 key 没变，初始化 effect 不重跑），复用即可；
     * 但**跨后端**（sprite ↔ live2d）会销毁旧实例、建新的，此时留着旧编排器
     * 等于让它此后所有 `setExpression` / `getMotionCount` 全打在已销毁的对象上——
     * 症状是「画面在动，但表情与随机动作全没了」，且**一声不响**（死渲染器上的调用
     * 大多静默 return）。
     *
     * 实测抓到：`demo_pixel_cat`（sprite）切到 `mao_pro`（live2d）后，
     * 日志里只剩编排器那句 `[setExpression] orchestrator → renderer index=9 name=tired`，
     * 渲染器那侧一行都没有，`playRandomIdleNow` 也再没出现过。
     */
    const sameRenderer = orchestratorRendererRef.current === renderer
    if (orchestratorRef.current && sameRenderer) {
      orchestratorRef.current.setModelConfig(config)
    } else {
      orchestratorRef.current?.dispose()
      orchestratorRef.current = null
      const created = new PetOrchestrator(renderer)
      created.setModelConfig(config)
      created.start()
      orchestratorRef.current = created
      orchestratorRendererRef.current = renderer
      log.info(sameRenderer ? 'PetOrchestrator 已启动' : 'PetOrchestrator 已重建（渲染器换了实例）')
    }

    const orch = orchestratorRef.current
    if (!orch) return

    // 每次模型加载都重绑状态监听与表情回调（热切换路径也需刷新 UI）
    orch.setStatusListener((status) => setAvatarStatus({ ...status }))
    orch.setEnableIdleMotion(enableIdleMotionRef.current)
    orch.setEnableAgentActivity(enableAgentActivityRef.current)
    orch.setEnableAgentNotice(enableAgentNoticeRef.current)
    // L4 气泡（R5/R6）：冒出来之后按自己的 TTL 撤，**不跟着 activity 生死**——
    // 实测 waiting 常常只存在 0ms，跟着状态走那句「需要你确认一下」会一闪而过。
    orch.setAnnounceListener((payload) => {
      if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current)
      bubbleTimerRef.current = null
      if (!payload) {
        setBubble(null)
        return
      }
      const renderer = canvasRef.current?.getRenderer()
      const pos = renderer?.getPosition?.()
      const layout = renderer?.getLayout?.()
      setBubble({
        text: payload.text,
        x: pos?.x ?? 0,
        y: pos?.y ?? 0,
        // modelHeight 拿不到时给个保守值，最坏是气泡位置略偏，不会崩
        petHeight: layout?.modelHeight ?? 200,
        notice: payload.notice,
      })
      bubbleTimerRef.current = setTimeout(() => setBubble(null), payload.durationMs)
    })
    /**
     * 待办清单（控制坞那一块）+ **系统通知**。
     *
     * 系统通知只给 `action` 档（设计 §5.1）：`report` 的语义是"顺便告诉你一声"，
     * 给它最强的通道等于把"任务完成"变成需要处理的待办——那正是 D4 骚扰的定义。
     *
     * 发通知的时机是**通知产生**，不是"气泡冒出来"：免打扰时段气泡不冒（§6.3），
     * 但那条审批照样得叫你——它 5 分钟不响应就失败了。
     */
    orch.setNoticeListener((notices) => {
      setNotices(notices)
      const handled = alertedNoticeIdsRef.current
      for (const n of notices) {
        if (n.resolvedAt !== undefined) continue
        if (n.level === 'ambient') continue
        if (handled.has(n.id)) continue
        handled.add(n.id)
        if (handled.size > 200) {
          const oldest = handled.values().next().value
          if (oldest !== undefined) handled.delete(oldest)
        }
        if (n.level === 'action') {
          log.info(`[notice] 系统通知 id=${n.id} text="${n.text}"`)
          // `convId` 必须带：不带的话用户点了通知只会把主窗拉到前台，**不会切到那个会话**
          // （这正是 D1 那条既有缺陷的形态——通知"点了不跳转"）。
          notifyDesktop('Lumii · 需要你确认', n.text, n.sessionKey)
        } else {
          // `report` 档"完成时放一次"粒子（设计 §5.1 的通道表）。
          // `action` 档**刻意不放**——设计原文："庆祝归庆祝，催办不用喜庆特效"。
          // 位置取**上半身**而不是贴头顶：与待机星星同一个先例（贴头顶像"头发着火"）。
          const renderer = canvasRef.current?.getRenderer()
          const pos = renderer?.getPosition?.()
          const layout = renderer?.getLayout?.()
          if (pos) {
            log.info(`[notice] 完成粒子 id=${n.id} text="${n.text}"`)
            spawnClickFireworks(pos.x, pos.y - (layout?.modelHeight ?? 200) * 0.82)
          }
        }
      }
    })
    // 补上订阅期间可能已经到达的闲置阶段（setIdleStage 幂等，同阶段重复调用是空操作）
    orch.setIdleStage(idleStageRef.current)
    // 同理补主窗焦点：订阅早于编排器创建，不补的话它会一直按"聚焦"算
    if (mainWindowFocusedRef.current !== undefined) {
      orch.setMainWindowFocused(mainWindowFocusedRef.current)
    }

    const emotionMap = config.emotionMap ?? {}
    // 表情与动作走同一朗读进度对齐（按 atChar 排队，读到位置再切/再做）
    const onExpression = (index: number, name: string, atChar: number) =>
      orch.playExpression(index, name, atChar)
    const onMotion = (tag: string, atChar: number) => orch.playActionMotion(tag, atChar)

    if (emotionMapperRef.current) {
      emotionMapperRef.current.setEmotionMap(emotionMap)
      emotionMapperRef.current.setOnExpression(onExpression)
      emotionMapperRef.current.setOnMotion(onMotion)
    } else {
      emotionMapperRef.current = new PetEmotionMapper(emotionMap, onExpression, onMotion)
      log.info(`PetEmotionMapper 已启动 emotionMap=${JSON.stringify(emotionMap)}`)
    }

    // 拉取模型可触发动作映射（tag → 动作组/index），注入编排器供 [motion:tag] 播放
    void window.electronAPI?.pet?.getModelMotionActions?.(config.id)
      .then((actions) => {
        const map: Record<string, { group: string; index?: number }> = {}
        for (const a of actions ?? []) map[a.tag] = { group: a.group, index: a.index }
        orch.setActionMotions(map)
        log.info(`[handleModelLoaded] 可触发动作 ${Object.keys(map).length} 个: ${Object.keys(map).join(',')}`)
      })
      .catch((e) => log.warn(`获取动作映射失败: ${(e as Error).message}`))

    const defaultIdx = config.defaultExpression ?? 0
    const defaultKey = resolveEmotionKeyByIndex(emotionMap, defaultIdx)
    if (defaultKey) {
      orch.setExpression(defaultIdx, defaultKey)
    }
  }, [])

  // 编排器随组件卸载销毁
  useEffect(() => {
    return () => {
      orchestratorRef.current?.dispose()
      orchestratorRef.current = null
      orchestratorRendererRef.current = null
    }
  }, [])

  // 进入宠物模式时预绑定会话，避免 agent 事件因 sessionKey 为空被全部跳过。
  // 空依赖 [] → 仅 mount 时执行一次；预绑定的 activateVirtualHumanContext 不应随渲染重复触发。
  useEffect(() => {
    void resolvePetSessionKey()
      .then(async (sk) => {
        sessionKeyRef.current = sk
        await syncThinkingPrefsRef.current(sk)
        await window.electronAPI?.pet?.activateVirtualHumanContext?.(sk)
        log.info(`[mount] 会话已绑定 sessionKey=${sk}`)
      })
      .catch((err) => {
        log.warn(`[mount] 会话预绑定失败: ${err instanceof Error ? err.message : String(err)}`)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 同步虚拟人设置（声音开关、随机待机）
  useEffect(() => {
    let alive = true
    void window.electronAPI?.pet?.getVirtualHumanSettings?.().then((s) => {
      if (!alive || !s) return
      enableVoiceReplyRef.current = s.enableVoiceReply
      setVoiceReplyEnabled(s.enableVoiceReply)
      enableIdleMotionRef.current = s.enableIdleMotion ?? DEFAULT_VH_SETTINGS.enableIdleMotion
      setIdleMotionEnabled(enableIdleMotionRef.current)
      orchestratorRef.current?.setEnableIdleMotion(enableIdleMotionRef.current)
      enableAgentActivityRef.current = s.enableAgentActivity ?? DEFAULT_VH_SETTINGS.enableAgentActivity
      orchestratorRef.current?.setEnableAgentActivity(enableAgentActivityRef.current)
      enableAgentNoticeRef.current = s.enableAgentNotice ?? DEFAULT_VH_SETTINGS.enableAgentNotice
      orchestratorRef.current?.setEnableAgentNotice(enableAgentNoticeRef.current)
      enableTapInteractionRef.current = s.enableTapInteraction ?? DEFAULT_VH_SETTINGS.enableTapInteraction
      setTapInteractionEnabled(enableTapInteractionRef.current)
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [currentModelId])

  // 监听主进程推送的设置变更（设置页修改后即时生效，无需重启宠物模式）
  useEffect(() => {
    const unsub = window.electronAPI?.pet?.onVhSettingsChanged?.((event) => {
      const { patch } = event
      log.info(`[onVhSettingsChanged] 收到设置变更: ${JSON.stringify(patch)}`)
      if (patch.enableVoiceReply !== undefined) {
        enableVoiceReplyRef.current = patch.enableVoiceReply
        setVoiceReplyEnabled(patch.enableVoiceReply)
      }
      if (patch.enableIdleMotion !== undefined) {
        enableIdleMotionRef.current = patch.enableIdleMotion
        setIdleMotionEnabled(patch.enableIdleMotion)
        orchestratorRef.current?.setEnableIdleMotion(patch.enableIdleMotion)
      }
      if (patch.enableAgentActivity !== undefined) {
        enableAgentActivityRef.current = patch.enableAgentActivity
        orchestratorRef.current?.setEnableAgentActivity(patch.enableAgentActivity)
      }
      if (patch.enableAgentNotice !== undefined) {
        enableAgentNoticeRef.current = patch.enableAgentNotice
        orchestratorRef.current?.setEnableAgentNotice(patch.enableAgentNotice)
      }
      if (patch.enableTapInteraction !== undefined) {
        enableTapInteractionRef.current = patch.enableTapInteraction
        setTapInteractionEnabled(patch.enableTapInteraction)
      }
    })
    return () => unsub?.()
  }, [])

  // 闲置感知（P2-c）：主进程推来「用户离开多久」的阶段 → 交给编排器
  //
  // 订阅点在这里而不是 PetCanvas：编排器归本组件持有（PetCanvas 只管渲染，
  // 它拿不到编排器）。P2-b 的注视订阅在 PetCanvas 是因为那件事要渲染器的屏幕包围盒。
  useEffect(() => {
    if (!window.electronAPI?.pet?.onIdle) {
      log.warn('[idle] preload 未暴露 onIdle —— 闲置感知链路在第二段就断了')
      return
    }
    const apply = (stage: PetIdleStage, from: string): void => {
      log.info(`[idle] ${from}：${stage}`)
      // 存一份：编排器要等模型加载完才建，而主进程**只在阶段变化时**推——
      // 首推恰好是 asleep（CLI 拉起宠物模式）时若丢掉，宠物就再也睡不着了。
      idleStageRef.current = stage
      orchestratorRef.current?.setIdleStage(stage)
    }
    // 挂载时补问一次：进宠物模式时主进程那条初始阶段是在本页面加载完**之前**发出的，
    // `webContents.send` 会直接丢弃。那一刻用户已经闲置很久的话（宠物模式由 CLI/智能体
    // 拉起，全程没有输入），只靠订阅就会永远停在醒着。
    void window.electronAPI.pet
      .getIdleStage?.()
      .then((stage) => {
        if (stage) apply(stage, '挂载时查询到闲置阶段')
      })
      .catch(() => {})
    log.info('[idle] 已订阅闲置阶段事件，等待主进程推送')
    return window.electronAPI.pet.onIdle((event) => apply(event.stage, '收到闲置阶段推送'))
  }, [])

  /**
   * 主窗焦点 → 通知（R6）的 `report` 判据。
   *
   * 用于两条规则：`turn:end` 的「用户发起后走开了」、`file-changes` 的「主窗失焦且
   * 用户没参与」。宠物窗自己问不到——它常驻置顶，`document.hasFocus()` 回答的是**它自己**。
   *
   * ⚠️ 与 `onIdle` **同一个丢首推的坑**（挂载时那次推送已经发过了），所以要补问一次；
   * 但顺序与 `onPerch` 那条相反也没关系——焦点是**幂等**的当前态，不像矩形那样"两次推送
   * 之间丢的那次会让位置永久失真"。唯一要处理的是**竞态**：补问的 Promise 可能比
   * 订阅收到的事件晚 resolve，那样旧值会盖掉新值 → 用一个标志让事件优先。
   */
  useEffect(() => {
    const api = window.electronAPI?.pet
    if (!api?.onMainWindowFocus) {
      log.warn('[focus] preload 未暴露 onMainWindowFocus —— report 档退回"只看时长"')
      return
    }
    let alive = true
    let gotEvent = false
    const apply = (focused: boolean): void => {
      mainWindowFocusedRef.current = focused
      orchestratorRef.current?.setMainWindowFocused(focused)
    }
    const unsub = api.onMainWindowFocus((event) => {
      gotEvent = true
      apply(Boolean(event?.focused))
    })
    void api
      .getMainWindowFocus?.()
      .then((focused) => {
        if (!alive || gotEvent) return
        apply(Boolean(focused))
      })
      .catch(() => {})
    return () => {
      alive = false
      unsub?.()
    }
  }, [])

  // 拉取可切换模型列表（控制坞下拉）
  useEffect(() => {
    let alive = true
    void window.electronAPI?.pet?.listModels?.().then((list) => {
      if (alive && list) setModels(list)
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  /**
   * 文字回复出声：启动 micless 播放管线（主进程订阅 Agent 流 → Edge/VITS TTS → voice:tts:chunk）。
   * 幂等：已有活跃通话时跳过。
   */
  const ensureMiclessVoicePipeline = useCallback(async () => {
    if (currentModeRef.current !== 'pet') return
    if (!enableVoiceReplyRef.current) return
    if (voiceState.state !== 'idle') return
    try {
      const sessionKey = sessionKeyRef.current || (await resolvePetSessionKey())
      sessionKeyRef.current = sessionKey
      await syncSessionThinkingPrefs(sessionKey)
      const agentId = await resolveVoiceAgentId(modelConfigRef.current?.agentId)
      log.info(`[ensureMiclessVoicePipeline] micless 起呼 sessionKey=${sessionKey}`)
      await voiceActions.startCall(sessionKey, agentId, { micless: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(`[ensureMiclessVoicePipeline] 失败: ${msg}`)
      setVoiceError(msg)
    }
  }, [voiceActions, voiceState.state, syncSessionThinkingPrefs])

  // 订阅 Agent 流式输出 → 表情驱动 + 聊天记录累积（宠物窗口镜像自主进程 pushEvent）
  useEffect(() => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.onEvent) return

    return api.onEvent((raw: unknown) => {
      try {
        const event = (raw ?? {}) as RawAgentEvent & {
          delta?: string
          emotion?: string
          /** `autonomous:mood:emotion` 的可选三维载荷（第二期起用于调呼吸/活动频率） */
          mood?: { energy: number; valence: number; arousal: number }
          content?: readonly { type: string; text?: string }[]
        }
        const evtSessionKey = event.rootSessionKey ?? event.sessionKey
        /**
         * 多会话运行态记账：**在按会话过滤之前**折一次，别人的事件也要收。
         *
         * 这里只回答"谁在跑、谁在等你出手"，**不参与姿态/表情**——
         * 后台 cron agent 常年有活，让它参与的话宠物会永远在抖。
         * 先过 `isSessionActivityEvent` 挡一道：delta 是逐 token 的，白跑几百次不划算。
         */
        if (isSessionActivityEvent(event.type ?? '')) {
          const now = performance.now()
          setSessionRuns((prev) =>
            reduceSessionActivity(
              prev,
              { type: event.type, sessionKey: event.sessionKey, rootSessionKey: event.rootSessionKey },
              now,
            ),
          )
        }
        // 镜像事件到达时采纳主窗口会话（宠物窗未起呼前 sessionKeyRef 可能为空）
        if (evtSessionKey && !sessionKeyRef.current) {
          sessionKeyRef.current = evtSessionKey
          log.info(`[onEvent] 采纳会话 sessionKey=${evtSessionKey}`)
        }
        // 通知折账（R6）：**同样在按会话过滤之前**——别人的会话卡住了，也占着同一个
        // Agent 进程与同一份配额，必须叫（设计 §七「推翻 D3」）。
        //
        // 顺序要紧：先把本轮事实推进一步（`turn:start` 复位、`task_complete` 置位），
        // 再转成通知事件。反过来的话，`turn:end` 会看到上一轮留下的 `sawTaskComplete`。
        noticeTurnFactsRef.current = advanceTurnFacts(noticeTurnFactsRef.current, event)
        if (isNoticeEvent(event.type ?? '')) {
          const noticeEvent = toNoticeEvent(event, noticeTurnFactsRef.current)
          if (noticeEvent) orchestratorRef.current?.pushNoticeEvent(noticeEvent)
        }
        const sk = sessionKeyRef.current
        if (sk && evtSessionKey && !petSessionMatchesEvent(sk, event)) {
          if (
            event.type === 'agent:message:delta' ||
            event.type === 'agent:message:end' ||
            event.type === 'agent:turn:start' ||
            event.type === 'agent:turn:end'
          ) {
            log.warn(
              `[onEvent] 跳过 type=${event.type} evtSk=${evtSessionKey} localSk=${sk}`,
            )
          }
          return
        }

        // Agent 活动感知（R5/R6）：把真实事件名翻译成活动状态机的语义事件。
        //
        // 只认会改变状态的那几种——`agent:message:delta` / `agent:thinking:delta` 这类
        // 高频流式事件 `mapAgentEvent` 返回 null，在这里直接对掉。它们本来就不改变
        // activity（正文产出期间该是什么状态还是什么），而 delta 是逐 token 的，
        // 接进来只是让状态机白跑几十万次。
        const agentActivityEvent = mapAgentEvent(event.type ?? '')
        if (agentActivityEvent) orchestratorRef.current?.pushAgentActivity(agentActivityEvent)

        if (event.type === 'autonomous:mood:emotion') {
          const emotion = event.emotion
          // mood 三维（可选载荷）先只记录：第二期才用它调呼吸/活动频率
          if (event.mood) {
            log.info(
              `[onEvent] mood 三维 energy=${event.mood.energy.toFixed(2)} valence=${event.mood.valence.toFixed(2)} arousal=${event.mood.arousal.toFixed(2)}`,
            )
          }
          if (emotion && orchestratorRef.current) {
            const emotionMap = modelConfigRef.current?.emotionMap ?? {}
            const idx = emotionMap[emotion]
            if (idx !== undefined) {
              orchestratorRef.current.setExpression(idx, emotion)
              log.info(`[onEvent] mood 表情 ${emotion} (idx=${idx})`)
            } else {
              log.warn(`[onEvent] mood 表情 "${emotion}" 不在当前模型 emotionMap: ${Object.keys(emotionMap).join(',')}`)
            }
          }
        }

        if (event.type === 'agent:turn:start') {
          log.info('[onEvent] agent:turn:start')
          if (sk) {
            void window.electronAPI?.pet?.activateVirtualHumanContext?.(sk)
          }
          orchestratorRef.current?.setDialogueActive(true)
          if (enableVoiceReplyRef.current) {
            void ensureMiclessVoicePipeline()
          }
          if (!orchestratorRef.current?.isTextReplyActive()) {
            orchestratorRef.current?.startTextReply(enableVoiceReplyRef.current)
          }
          ensureAssistantStream()
        }

        if (event.type === 'agent:message:delta' && event.delta) {
          ensureAssistantStream()
          // 兜底启动口型：宠物窗口可能在 turn:start 之后才订阅（错过该事件），
          // 故首个 delta 到达时若口型未激活则补启动（isTextReplyActive 去重，幂等）
          if (!orchestratorRef.current?.isTextReplyActive()) {
            orchestratorRef.current?.setDialogueActive(true)
            orchestratorRef.current?.startTextReply(enableVoiceReplyRef.current)
          }
          const mapper = emotionMapperRef.current
          if (!mapper) {
            log.warn('[onEvent] agent:message:delta 但 PetEmotionMapper 未就绪')
          }
          const clean = mapper ? mapper.feed(event.delta) : stripVirtualHumanTags(event.delta)
          // 仅在有表情标签或较长文本时打日志，避免高频 delta 刷爆控制台
          if (event.delta.includes('[') || clean.length > 8) {
            log.info(`[onEvent] delta="${event.delta.slice(0, 40)}" clean="${clean.slice(0, 40)}"`)
          }
          if (clean) appendAssistantDelta(clean)
          // 文字流速驱动伪口型节奏（真音频口型由 AnalyserNode 驱动，此调用会被 orchestrator 忽略）
          if (clean) orchestratorRef.current?.notifyTextDelta(clean)
        }

        if (event.type === 'agent:message:end') {
          const fullRaw = event.content?.find((b) => b.type === 'text')?.text ?? ''
          log.info(`[onEvent] agent:message:end len=${fullRaw.length}`)
          if (fullRaw) {
            emotionMapperRef.current?.applyFromFullText(fullRaw)
            finalizeAssistantStream(stripVirtualHumanTags(fullRaw))
          }
          emotionMapperRef.current?.reset()
          streamingIdRef.current = null
          orchestratorRef.current?.onDialogueEnded()
          // 口型在整轮结束（turn:end）时停止，避免 message:end 过早停伪口型
        }

        if (event.type === 'agent:turn:end' || event.type === 'agent:idle') {
          log.info(`[onEvent] ${event.type} → 结束对话编排与口型`)
          orchestratorRef.current?.setDialogueActive(false)
          orchestratorRef.current?.endTextReply()
        }
      } catch (err) {
        log.error(`[onEvent] 处理异常: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }, [appendAssistantDelta, ensureAssistantStream, finalizeAssistantStream, ensureMiclessVoicePipeline])

  // 语音识别定稿 → 记一条用户消息（assistant 流式气泡由 agent:turn:start / delta 创建）
  const lastFinalRef = useRef<string>('')
  useEffect(() => {
    const final = voiceState.finalTranscript?.trim()
    if (voiceState.state === 'recognizing' && final && final !== lastFinalRef.current) {
      lastFinalRef.current = final
      emotionMapperRef.current?.reset()
      appendMessage('user', final)
    }
  }, [voiceState.state, voiceState.finalTranscript, appendMessage])

  useEffect(() => {
    if (voiceState.state === 'idle') {
      lastFinalRef.current = ''
      streamingIdRef.current = null
      setVoiceError(null)
    }
  }, [voiceState.state])

  // 每 5s 采样 FPS + lipsync 延迟
  useEffect(() => {
    if (!modelLoaded) return
    const id = setInterval(() => {
      const renderer = canvasRef.current?.getRenderer()
      if (renderer) petMetrics.recordRenderFps(renderer.getCurrentFps())
      const orch = orchestratorRef.current
      if (orch) petMetrics.recordLipSyncLatency(orch.getLipSyncLatencyMs())
    }, 5000)
    return () => clearInterval(id)
  }, [modelLoaded])

  /**
   * 待机特效：偶尔在宠物身上冒几颗小星星/爱心（用户 2026-09-22 挑的「偶尔随机」）。
   *
   * 三条约束，都是有意的：
   *   · **只在待机时冒**——它正在想事/回你话的时候冒星星，是跟内容抢注意力；
   *     睡着时也不冒（那时该看见的是头顶的 Z）。
   *   · **随机 8~20 秒**——固定节奏会变成节拍器，看两轮就腻。
   *   · `setTimeout` 自排程而不是 `setInterval`：间隔每次都要重掷。
   *
   * 依赖只给 `modelLoaded`：状态从 ref 读。把状态放进依赖数组的话，每来一次
   * status 补丁都会重建定时器，随机间隔被反复重置——特效可能永远等不到那一次。
   */
  useEffect(() => {
    if (!modelLoaded) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const schedule = () => {
      timer = setTimeout(
        () => {
          if (stopped) return
          const status = avatarStatusRef.current
          const asleep = idleStageRef.current !== 'awake'
          if ((status?.phase ?? 'idle') === 'idle' && !asleep) {
            const renderer = canvasRef.current?.getRenderer()
            const pos = renderer?.getPosition?.()
            const layout = renderer?.getLayout?.()
            if (pos) {
              // 落在上半身而不是贴着头顶：贴头顶冒像"头发着火"，低一点更像从身上飘起来
              spawnIdleSparkles(pos.x, pos.y - (layout?.modelHeight ?? 200) * 0.82)
            }
          }
          schedule()
        },
        8000 + Math.random() * 12000,
      )
    }
    schedule()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [modelLoaded])

  useEffect(() => {
    orchestratorRef.current?.setPlaybackAnalyser(voiceState.playbackAnalyserNode)
  }, [voiceState.playbackAnalyserNode])

  useEffect(() => {
    // 始终同步（含 null）：真音频 RMS 直驱依赖 isAudioPlaying 探测；挂断后清空避免持有已销毁引擎闭包
    orchestratorRef.current?.setCharPulsePoll(voiceState.charPulsePoll, voiceState.isAudioPlaying)
  }, [voiceState.charPulsePoll, voiceState.isAudioPlaying])

  const handleStartVoice = useCallback(async () => {
    setVoiceError(null)
    try {
      const sessionKey = await resolvePetSessionKey()
      sessionKeyRef.current = sessionKey
      await syncSessionThinkingPrefs(sessionKey)
      const agentId = await resolveVoiceAgentId(modelConfigRef.current?.agentId)
      log.info(`开始语音通话 sessionKey=${sessionKey} agentId=${agentId ?? '(默认)'}`)
      await voiceActions.startCall(sessionKey, agentId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(`起呼失败: ${msg}`)
      setVoiceError(msg)
    }
  }, [voiceActions, syncSessionThinkingPrefs])

  const handleStopVoice = useCallback(async () => {
    await voiceActions.stopCall()
    sessionKeyRef.current = ''
  }, [voiceActions])

  // 文字输入发送：先激活虚拟人 Prompt 上下文（表情/persona 注入），再发消息；
  // 口型按声音开关分流：开=真音频(需播放管线)；关=伪口型(无音频)。
  const handleSendText = useCallback(async (text: string) => {
    if (currentModeRef.current !== 'pet') {
      log.warn('[handleSendText] 已退出宠物模式，忽略文字发送')
      return
    }
    try {
      const sessionKey = sessionKeyRef.current || (await resolvePetSessionKey())
      sessionKeyRef.current = sessionKey

      // 打断进行中的回复：用户在 AI 回复期间再次发送，先中止当前 run 并收敛口型/编排，
      // 再走新一轮发送，避免上一轮 TTS/字幕与新消息叠加。
      const replying = orchestratorRef.current?.isTextReplyActive() || streamingIdRef.current !== null
      if (replying) {
        log.info('[handleSendText] 检测到回复进行中，打断当前轮次')
        await agentActions.abort().catch((e) => log.warn(`打断失败: ${(e as Error).message}`))
        orchestratorRef.current?.endTextReply(true)
        emotionMapperRef.current?.reset()
        streamingIdRef.current = null
      }

      await syncSessionThinkingPrefs(sessionKey)
      // 关键修复：文字链路此前不经过 voice startCall，从未激活 VH 上下文 → 表情/persona 未注入
      await window.electronAPI?.pet?.activateVirtualHumanContext?.(sessionKey)
      const agentId = await resolveVoiceAgentId(modelConfigRef.current?.agentId)

      emotionMapperRef.current?.reset()
      appendMessage('user', text)
      beginAssistantStream()
      orchestratorRef.current?.setDialogueActive(true)

      const useVoice = enableVoiceReplyRef.current
      // 开声音且当前无活跃通话：用 micless 模式起播放管线，让 TTS 出声 + 真音频口型
      if (useVoice) {
        await ensureMiclessVoicePipeline()
      }
      // 口型不在此处启动：等 agent:turn:start 事件触发，避免 AI 尚未回复时伪口型先动
      log.info(`文字发送 sessionKey=${sessionKey} agentId=${agentId ?? '(默认)'} voice=${useVoice}`)
      await agentActions.sendMessage(text, { sessionKey, agentId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(`文字发送失败: ${msg}`)
      setVoiceError(msg)
    }
  }, [agentActions, ensureMiclessVoicePipeline, appendMessage, beginAssistantStream, syncSessionThinkingPrefs])

  const handleToggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev
      voiceActions.setVolume(next ? 0 : 0.8)
      return next
    })
  }, [voiceActions])

  /**
   * 切换声音开关：只改设置并持久化。
   *
   * **不在这里预建 micless 管线**。曾经这么做（理由是"先初始化好，第一次出声不用等"），
   * 代价是一个**设置开关**会把整个应用切进通话态：主进程 VoiceStateMachine 从
   * initializing 直接进 thinking，`voice:call:state` 广播到所有窗口，主窗口的语音面板
   * 跟着亮起来。用户的原话是「点击开启语音朗读，客户端却打开了麦克风，进入了语音对话
   * 模式」——设置就是设置，不该开麦，也不该进通话。
   * TTS 管线改由真要说话的两条路径按需拉起：发文字前（handleSendText），
   * 以及一轮对话开始时（`agent:turn:start`，覆盖主动联系这类用户没发消息的场景）。
   */
  const handleToggleVoiceReply = useCallback(async () => {
    const next = !enableVoiceReplyRef.current
    enableVoiceReplyRef.current = next
    setVoiceReplyEnabled(next)
    try {
      await window.electronAPI?.pet?.setVirtualHumanSettings?.({ enableVoiceReply: next })
    } catch (err) {
      log.warn(`保存声音开关失败: ${(err as Error).message}`)
    }
    if (!next && voiceState.state !== 'idle') {
      // 关闭声音时若仅有 micless 管线在跑，挂断以停止后续 TTS
      await voiceActions.stopCall().catch(() => {})
    }
  }, [voiceActions, voiceState.state])

  /** 切换当前虚拟人模型（热切换 + 持久化，主进程广播 pet:model:changed） */
  const handleChangeModel = useCallback(async (modelId: string) => {
    if (!modelId || modelId === currentModelId) return
    try {
      await window.electronAPI?.pet?.setCurrentModelId?.(modelId)
    } catch (err) {
      log.warn(`切换模型失败: ${(err as Error).message}`)
    }
  }, [currentModelId])

  const handleExit = useCallback(async () => {
    // 先切到 desktop 语义，阻止在挂断/退出过程中的残留事件再次拉起语音管线（需求2 连锁反应根因）
    currentModeRef.current = 'desktop'
    // 彻底停止语音通话（AudioContext/队列/analyser/ASR 全部释放）
    if (voiceState.state !== 'idle') {
      await voiceActions.stopCall().catch(() => {})
    }
    // 复位会话与编排运行态，确保再次进入时从干净状态起步
    sessionKeyRef.current = ''
    streamingIdRef.current = null
    orchestratorRef.current?.endTextReply(true)
    emotionMapperRef.current?.reset()
    await exitPetMode()
  }, [voiceState.state, voiceActions, exitPetMode])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        background: 'transparent',
        overflow: 'hidden',
      }}
    >
      {bubble && (
        <PetSpeechBubble
          text={bubble.text}
          x={bubble.x}
          y={bubble.y}
          petHeight={bubble.petHeight}
          getAnchor={getPetAnchor}
          // 只有通知气泡带按钮：状态句（还在忙…）是只读的，给它一个按钮反而让人以为要点什么
          action={
            bubble.notice
              ? {
                  label: noticeActionLabel(bubble.notice),
                  onClick: () => handleFocusNotice(bubble.notice!),
                }
              : undefined
          }
        />
      )}
      {/*
        头顶符号与气泡**互斥**：两者锚在同一处，叠在一起一定糊。
        气泡是"一句话"（有时限、要读），符号是"状态灯"（常驻、扫一眼），
        同时需要时让气泡说话——它信息更多，且转瞬即逝。
      */}
      {!bubble && glyph && glyphAnchor && (
        <PetStatusGlyph
          char={glyph.char}
          tone={glyph.tone}
          label={glyph.label}
          source={glyph.source}
          x={glyphAnchor.x}
          y={glyphAnchor.y}
          petHeight={glyphAnchor.petHeight}
          getAnchor={getPetAnchor}
        />
      )}
      {menuAt && (
        <PetContextMenu
          x={menuAt.x}
          y={menuAt.y}
          voiceState={voiceState.state}
          muted={muted}
          voiceReplyEnabled={voiceReplyEnabled}
          models={models}
          currentModelId={currentModelId}
          dockOpen={dockOpen}
          onStartVoice={handleStartVoice}
          onStopVoice={handleStopVoice}
          onToggleMute={handleToggleMute}
          onToggleVoiceReply={handleToggleVoiceReply}
          onChangeModel={handleChangeModel}
          onToggleDock={() => setDockOpen((v) => !v)}
          onExit={handleExit}
          onClose={() => setMenuAt(null)}
        />
      )}
      {!degrade && (
        <PetCanvas
          ref={canvasRef}
          modelId={currentModelId || undefined}
          onDegrade={handleDegrade}
          onModelLoaded={handleModelLoaded}
          // 场景 A：抓起/抛出/落地时让编排器播约定动作（模型声明了 Picked / Fall / Land 才播）。
          // 抛物线本身在 PetCanvas 里跑，这里只做动作衔接。
          onInteraction={(e) => {
            const orch = orchestratorRef.current
            if (!orch) return
            if (e.type === 'picked') orch.setPicked(true)
            else if (e.type === 'thrown') orch.setPicked(false)
            else orch.notifyLanded()
          }}
          // 自主活动（R9）：画布只报「该走/该坐/该站」，播哪个组由编排器按既有优先级决定
          onAmbientActivity={(activity) => orchestratorRef.current?.setAmbientActivity(activity)}
          onContextMenu={(x, y) => setMenuAt({ x, y })}
          // 对话进行中（听/想/说/收尾）不让宠物自己溜达——它正在跟用户交互，不该走开。
          // 复用 `enableIdleMotion` 开关：语义就是「待机时要不要自己动」，不必再加一个设置项。
          ambientEnabled={idleMotionEnabled && (!avatarStatus || avatarStatus.phase === 'idle')}
          // 气泡挂着时原地定格（用户 2026-09-23：「文字气泡需要停止宠物当前动作」）。
          // 与上一行是两回事：那个是"要不要自己动"，这个是"这一刻先别动"。
          // 头顶符号**不**走这条——状态灯扫一眼就够，为它把宠物钉住是打扰。
          bubbleHold={bubble !== null}
        />
      )}

      {degrade && <DegradeNotice reason={degrade} onExit={handleExit} />}

      {dockOpen && (
        <PetControlDock
        voiceState={voiceState.state}
        partialTranscript={voiceState.partialTranscript}
        messages={messages}
        error={voiceState.error ?? voiceError}
        muted={muted}
        voiceReplyEnabled={voiceReplyEnabled}
        idleMotionEnabled={idleMotionEnabled}
        avatarStatus={avatarStatus}
        otherRuns={otherRuns}
        pendingNotices={pendingNoticeList}
        onFocusNotice={handleFocusNotice}
        // 点一条会话 → 主进程把主窗带到前台并把 app-ui:goto（带 sessionKey）发过去；
        // 真正的会话切换在主窗的 agent-runtime 里做（会话状态不在主进程）
        onFocusSession={(sessionKey) => {
          void window.electronAPI?.pet?.focusSession?.(sessionKey)?.catch?.(() => {})
        }}
        modelLoaded={modelLoaded}
        voiceError={voiceError}
        models={models}
        currentModelId={currentModelId}
        onStartVoice={handleStartVoice}
        onStopVoice={handleStopVoice}
        onToggleMute={handleToggleMute}
        onToggleVoiceReply={handleToggleVoiceReply}
        onChangeModel={handleChangeModel}
        onClose={() => setDockOpen(false)}
        onSendText={handleSendText}
        autoMuteMicWhileSpeaking={autoMuteMicWhileSpeaking}
        vadThreshold={vadThreshold}
        energyGateMultiplier={energyGateMultiplier}
        onChangeVoiceSetting={handleChangeVoiceSetting}
        />
      )}

      <PetDebugOverlay />
    </div>
  )
}

/** 降级提示卡片 */
const DegradeNotice: React.FC<{ reason: PetCanvasDegradeReason; onExit: () => void }> = ({
  reason,
  onExit,
}) => {
  const title =
    reason.kind === 'webgl'
      ? 'WebGL 不可用'
      : reason.kind === 'core-missing'
        ? 'Live2D 运行时缺失'
        : '模型加载失败'

  return (
    <div
      onMouseEnter={() =>
        window.electronAPI?.pet?.reportHover({ componentId: 'degrade-notice', isHovering: true })
      }
      onMouseLeave={() =>
        window.electronAPI?.pet?.reportHover({ componentId: 'degrade-notice', isHovering: false })
      }
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'rgba(20,20,28,0.92)',
        color: '#fff',
        borderRadius: 12,
        padding: '20px 24px',
        maxWidth: 360,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{title}</div>
      <div style={{ color: 'rgba(255,255,255,0.75)', marginBottom: 16 }}>{reason.message}</div>
      <button
        type="button"
        onClick={onExit}
        style={{
          padding: '6px 16px',
          borderRadius: 8,
          border: 'none',
          background: '#6366f1',
          color: '#fff',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        返回桌面模式
      </button>
    </div>
  )
}

export default PetModeShell
