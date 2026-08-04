/**
 * PetModeShell - 宠物模式外壳组件
 *
 * 设计依据：00-修订版设计 §2.1
 *
 * 组合：PetCanvas（Live2D 渲染）+ PetOrchestrator（语音状态→动画+口型）
 *       + PetControlDock（统一控制坞，参考 OLV InputSubtitle）。
 * 语音链路在本窗口自跑（D4）：useVoiceCall 的麦克风采集 + TTS 播放都在宠物窗口。
 */

import React, { useCallback, useRef, useState, useEffect } from 'react'
import { usePetMode } from './hooks/usePetMode'
import { PetCanvas, type PetCanvasHandle, type PetCanvasDegradeReason, setTapModelConfig, setTapInteractionEnabled } from './components/PetCanvas'
import { PetControlDock } from './components/PetControlDock'
import { PetOrchestrator, type PetAvatarStatus } from './orchestrator/PetOrchestrator'
import { PetEmotionMapper } from './orchestrator/PetEmotionMapper'
import { useVoiceCall } from '../hooks/business/useVoiceCall/useVoiceCall'
import { useAgentRuntimeActions } from '../hooks/business/useAgentRuntime/useAgentRuntime'
import type { PetModelConfig } from './config/pet-model-types'
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
  const enableTapInteractionRef = useRef<boolean>(DEFAULT_VH_SETTINGS.enableTapInteraction)
  const [degrade, setDegrade] = useState<PetCanvasDegradeReason | null>(null)
  const [modelLoaded, setModelLoaded] = useState(false)
  const [muted, setMuted] = useState(false)
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(DEFAULT_VH_SETTINGS.enableVoiceReply)
  const [idleMotionEnabled, setIdleMotionEnabled] = useState(DEFAULT_VH_SETTINGS.enableIdleMotion)
  const [avatarStatus, setAvatarStatus] = useState<PetAvatarStatus | null>(null)
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

    if (orchestratorRef.current) {
      orchestratorRef.current.setModelConfig(config)
    } else {
      const created = new PetOrchestrator(renderer)
      created.setModelConfig(config)
      created.start()
      orchestratorRef.current = created
      log.info('PetOrchestrator 已启动')
    }

    const orch = orchestratorRef.current
    if (!orch) return

    // 每次模型加载都重绑状态监听与表情回调（热切换路径也需刷新 UI）
    orch.setStatusListener((status) => setAvatarStatus({ ...status }))
    orch.setEnableIdleMotion(enableIdleMotionRef.current)

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
      if (patch.enableTapInteraction !== undefined) {
        enableTapInteractionRef.current = patch.enableTapInteraction
        setTapInteractionEnabled(patch.enableTapInteraction)
      }
    })
    return () => unsub?.()
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

  /** 切换声音开关：持久化到 VH 设置，开启时预建 micless TTS 管线 */
  const handleToggleVoiceReply = useCallback(async () => {
    const next = !enableVoiceReplyRef.current
    enableVoiceReplyRef.current = next
    setVoiceReplyEnabled(next)
    try {
      await window.electronAPI?.pet?.setVirtualHumanSettings?.({ enableVoiceReply: next })
    } catch (err) {
      log.warn(`保存声音开关失败: ${(err as Error).message}`)
    }
    if (next) {
      await ensureMiclessVoicePipeline()
    } else if (voiceState.state !== 'idle') {
      // 关闭声音时若仅有 micless 管线在跑，挂断以停止后续 TTS
      await voiceActions.stopCall().catch(() => {})
    }
  }, [ensureMiclessVoicePipeline, voiceActions, voiceState.state])

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
      {!degrade && (
        <PetCanvas
          ref={canvasRef}
          modelId={currentModelId || undefined}
          onDegrade={handleDegrade}
          onModelLoaded={handleModelLoaded}
        />
      )}

      {degrade && <DegradeNotice reason={degrade} onExit={handleExit} />}

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
        onExit={handleExit}
        onSendText={handleSendText}
        autoMuteMicWhileSpeaking={autoMuteMicWhileSpeaking}
        vadThreshold={vadThreshold}
        energyGateMultiplier={energyGateMultiplier}
        onChangeVoiceSetting={handleChangeVoiceSetting}
      />

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
