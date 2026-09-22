/**
 * PetModeShell - 宠物模式外壳组件
 *
 * 设计依据：00-修订版设计 §2.1
 *
 * 组合：PetCanvas（Live2D 渲染）+ PetOrchestrator（语音状态→动画+口型）
 *       + PetControlDock（统一控制坞，参考 OLV InputSubtitle）。
 * 语音链路在本窗口自跑（D4）：useVoiceCall 的麦克风采集 + TTS 播放都在宠物窗口。
 *
 * **本窗口不接主题**：`main.tsx` 直接渲染本组件，**不挂 `AppProviders`**
 * （含 `ThemeProvider`），因此这里没有 `data-theme`，`--mt-*` 令牌只会取
 * `:root` 的兜底值。这是刻意的——宠物是浮在桌面上的独立层，用户用深色主题
 * 工作时，桌面宠物不该突然变成米黄色。所以本目录下的色值都是自带常量，
 * **下一轮重构请勿"顺手统一"到主题令牌**。
 */

import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { usePetMode } from './hooks/usePetMode'
import { PetCanvas, type PetCanvasHandle, type PetCanvasDegradeReason, setTapModelConfig, setTapInteractionEnabled } from './components/PetCanvas'
import { PetControlDock } from './components/PetControlDock'
import { PetSpeechBubble } from './components/PetSpeechBubble'
import { PetStatusGlyph } from './components/PetStatusGlyph'
import { PetContextMenu } from './components/PetContextMenu'
import { spawnIdleSparkles } from './components/pet-particles'
import { PetOrchestrator, type PetAvatarStatus } from './orchestrator/PetOrchestrator'
import { PetEmotionMapper } from './orchestrator/PetEmotionMapper'
import { mapAgentEvent, type PetIdleStage } from '@mtbot/pet-core'
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
import { readPersistedSessionThinkingPrefs } from '../../shared/session-thinking-prefs'
import { petSessionMatchesEvent } from './utils/pet-session-match'

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
  /** 声音开关：开=文字回复出声(真音频口型)，关=静默(伪口型)。从 VH 设置同步。 */
  const enableVoiceReplyRef = useRef<boolean>(DEFAULT_VH_SETTINGS.enableVoiceReply)
  const enableIdleMotionRef = useRef<boolean>(DEFAULT_VH_SETTINGS.enableIdleMotion)
  /** Agent 活动感知（R5/R6）：关掉后宠物不再随 Agent 的思考/工具/等待改姿态 */
  const enableAgentActivityRef = useRef<boolean>(DEFAULT_VH_SETTINGS.enableAgentActivity)
  const enableTapInteractionRef = useRef<boolean>(DEFAULT_VH_SETTINGS.enableTapInteraction)
  /**
   * 最近一次收到的闲置阶段。
   *
   * 编排器要等模型加载完才建，而主进程**只在阶段变化时**推事件：不在这里存一份，
   * 「首推就是 asleep」（CLI/智能体在用户不在时拉起宠物模式）那次会丢，
   * 宠物会一直醒着直到下一次阶段变化——而下次变化要等到用户回来，即永远不睡。
   */
  const idleStageRef = useRef<PetIdleStage>('awake')
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
      }),
    [avatarStatus],
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
      })
      bubbleTimerRef.current = setTimeout(() => setBubble(null), payload.durationMs)
    })
    // 补上订阅期间可能已经到达的闲置阶段（setIdleStage 幂等，同阶段重复调用是空操作）
    orch.setIdleStage(idleStageRef.current)

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
        const event = (raw ?? {}) as {
          type?: string
          sessionKey?: string
          rootSessionKey?: string
          delta?: string
          emotion?: string
          content?: readonly { type: string; text?: string }[]
        }
        const evtSessionKey = event.rootSessionKey ?? event.sessionKey
        // 镜像事件到达时采纳主窗口会话（宠物窗未起呼前 sessionKeyRef 可能为空）
        if (evtSessionKey && !sessionKeyRef.current) {
          sessionKeyRef.current = evtSessionKey
          log.info(`[onEvent] 采纳会话 sessionKey=${evtSessionKey}`)
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
          x={glyphAnchor.x}
          y={glyphAnchor.y}
          petHeight={glyphAnchor.petHeight}
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
