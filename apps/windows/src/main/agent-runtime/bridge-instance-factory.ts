/**
 * AgentRuntimeBridge 实例工厂层
 *
 * 拆自 bridge.ts，封装 Agent 实例创建相关逻辑：
 * - createInstanceById（通过 agentId 查表 → createInstance）
 * - createInstance（最核心的实例化流程：创建 runContext / streamFn / toolRunner / 注册订阅 / 缓存基础提示词 / 启动 Proactivity）
 * - buildImageContents（多模态图片块构造，被 prompt 复用 → 通过 factory 公开）
 * - registerNodeStreamCallback / unregisterNodeStreamCallback（跨实例流式回调）
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  type AgentRegistry,
  type ToolRegistry,
  type MessageBus,
  type AgentDefinitionStore,
  type AgentOrchestrator,
  type AuditRepo,
  type ConversationRepo,
  type FileRepo,
  type MemoryManager,
  ModelRouter,
  createDirectStreamFn,
  ProactivityScheduler,
  BUILT_IN_AGENTS,
  createStreamFnFactory,
  assembleAgent,
  type AssembleAgentRuntime,
  type ConfigProvider,
  type PromptContextProvider,
  type EventSink,
  type ModelOverride,
  type ResolvedModel,
  type PermissionProvider,
  type AgentRuntimeEvent,
  type AgentRuntimeFeatureFlags,
  type AgentDefinition,
  type ToolExecutionContext,
  type SkillInfo,
  type CustomAgentInfo,
  type UserDeviceInfo,
  type McpServerHint,
  type ContextFile,
} from '@mtbot/agent-runtime'
import type { StreamFn } from '@mariozechner/pi-agent-core'

import { createRunContext } from './event-converter'
import { riskLevelForTool, createLargeToolResultHook } from './permission-tool-wrap'
import { createSkillHitRateHook } from './hooks/skill-hit-rate-hook'
import { createToolUsageHook } from './hooks/tool-usage-hook'
import type { McpStdioClient } from '@mtbot/agent-runtime'
import type { PermissionController } from './permission-controller'
import type { ChannelInteractionRequest } from '../channel/types'
import type { AgentRuntimeBridgeConfig } from './bridge'
import type { InstanceStateStore } from './bridge-instance-state'
import { createInstanceState, type InstanceState } from './bridge-instance-state'
import type { BridgePromptComposer } from './bridge-prompt-composer'
import type { BridgeSessionModelCatalog } from './bridge-session-model-catalog'
import type { BridgeSessionThinkingPrefs } from './bridge-session-thinking-prefs'
import type { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import { showNativeToolPermissionDialog } from './permission-native-dialog'
import {
  createAgentInstanceRuntimeEventHandler,
  type InstanceRuntimeMetrics,
} from './bridge-agent-instance-events'
import { agentRuntimeLog as log, filterToolsByDefinition } from './bridge-utils'
import { ensureProviderBaseUrl } from '../provider-config'
import { resizeImageIfNeeded } from './image-resizer'
import type { FileMemoryHandler } from './file-memory-handler'
import type { WikiIngestHook } from '@mtbot/agent-runtime'
import { maybeSnapshot } from '../workspace-vcs/vcs-snapshot'

/** LLM 摘要生成器构造函数签名（由 bridge.ts 注入，避免循环依赖） */
export type CreateSummaryGeneratorFn = (
  innerStream: StreamFn,
  model: import('@mariozechner/pi-ai').Model<any>,
) => any

/** 引用盒子（mutable reference）— 允许多处共享同一个可变插槽 */
export interface MutableRef<T> {
  value: T
}

export interface BridgeInstanceFactoryDeps {
  config: AgentRuntimeBridgeConfig
  agentRegistry: AgentRegistry
  toolRegistry: ToolRegistry
  modelRouter: ModelRouter
  instanceStates: InstanceStateStore
  instanceToConversation: Map<string, string>
  instanceToRootSessionKey: Map<string, string>
  nodeStreamCallbacks: Map<string, (event: AgentRuntimeEvent) => void>
  toolCallInstanceMap: Map<string, string>
  toolStartTimeMap: Map<string, number>
  /** 可变引用：当前正在执行工具的实例 ID */
  currentToolExecutorInstanceId: MutableRef<string | undefined>
  /** 可变引用：主 Agent 的 innerStream（compactContextAsync 使用） */
  mainInnerStreamRef: MutableRef<StreamFn | null>
  /** 可变引用：主 Agent 的 model（compactContextAsync 使用） */
  mainModelRef: MutableRef<import('@mariozechner/pi-ai').Model<any> | null>
  /** 可变引用：最近活跃 conversationId */
  lastActiveConvIdRef: MutableRef<string | null>
  messageBus: MessageBus
  featureFlags: AgentRuntimeFeatureFlags
  ipcChannel: BridgeRendererIpcChannel
  promptComposer: BridgePromptComposer
  sessionModelCatalog: BridgeSessionModelCatalog
  sessionThinkingPrefs: BridgeSessionThinkingPrefs
  permissionController: PermissionController
  /** 把提问/审批文字化推给渠道用户；返回 true 表示该会话由渠道承接 */
  notifyChannelInteraction: (interaction: ChannelInteractionRequest) => boolean
  /** 渲染进程「自动审批」开关镜像（渠道场景须在主进程直接放行） */
  isAutoApproveEnabled: () => boolean
  fileMemoryHandler: FileMemoryHandler
  getWikiIngestHook: () => WikiIngestHook | null
  mcpClients: Map<string, McpStdioClient>
  getDefinitionStore: () => AgentDefinitionStore | null
  getOrchestrator: () => AgentOrchestrator | null
  getAuditRepo: () => AuditRepo | null
  getConversationRepo: () => ConversationRepo | null
  /**
   * 该会话禁用的 MCP server 名（设置页是全局总开关，这里是会话覆盖）。
   * 注入侧两处必须同源：tools 参数与 systemPrompt 的 MCP hints。
   */
  getSessionDisabledMcpServers?: (rootSessionKey: string) => readonly string[]
  /** 该会话禁用的技能 id（设置页控制全局启用，这里是会话覆盖） */
  getSessionDisabledSkills?: (rootSessionKey: string) => readonly string[]
  getFileRepo: () => FileRepo | null
  getMemoryManager: () => MemoryManager | null
  getToolContext: () => ToolExecutionContext | null
  /** 推送活动快照（委派到 lifecycle.pushActivitySnapshot） */
  pushActivitySnapshot: (rootSessionKey: string) => void
  /** 发送消息给 Agent（被 ProactivityScheduler 触发时使用） */
  prompt: (instanceId: string, message: string) => Promise<void>
  /** LLM 摘要生成器工厂（来自 bridge-context-compactor 的 createLlmSummaryGenerator） */
  createSummaryGenerator: (
    innerStream: StreamFn,
    model: import('@mariozechner/pi-ai').Model<any>,
  ) => any
  /** 会话上下文用量（优先提供商 inputTokens，回退消息估算） */
  getSessionContextUsage: (sessionKey: string) => {
    usedTokens: number
    contextWindow: number
    triggerThreshold: number
    breakdown?: readonly import('../../shared/agent-runtime-events').ContextUsageBreakdownEntry[]
  }
  /** 记录提供商返回的 inputTokens */
  setSessionProviderInputTokens: (sessionKey: string, inputTokens: number) => void
  /** 用真实回执标定该模型的字符/token 比 */
  calibrateSessionCharsPerToken: (sessionKey: string, modelId: string, promptTokens: number) => void
  clearSessionProviderInputTokens: (sessionKey: string) => void
}

export class BridgeInstanceFactory {
  constructor(private readonly deps: BridgeInstanceFactoryDeps) {}

  /**
   * 通过 agentId 创建实例（优先 DefinitionStore：内置 / 缓存 / API）
   */
  async createInstanceById(agentId: string, sessionKey?: string, conversationId?: string): Promise<string> {
    const store = this.deps.getDefinitionStore()
    if (!store) {
      throw new Error('AgentRuntimeBridge not initialized')
    }
    const agentDef = await store.get(agentId)
    if (!agentDef) {
      throw new Error(`Agent definition not found: ${agentId}`)
    }
    return this.createInstance(agentDef, sessionKey, conversationId)
  }

  /** 创建 Agent 实例 */
  async createInstance(
    agentDef?: AgentDefinition,
    sessionKey?: string,
    conversationId?: string,
    options?: { parentInstanceId?: string },
  ): Promise<string> {
    const store = this.deps.getDefinitionStore()
    const def =
      agentDef ??
      (store ? await store.get('assistant') : undefined) ??
      BUILT_IN_AGENTS[0]!
    const instanceId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const effectiveSessionKey = sessionKey ?? `session-${instanceId}`
    const parentCtx = options?.parentInstanceId ? this.deps.instanceStates.get(options.parentInstanceId)?.ctx : undefined
    const rootSessionKey = parentCtx?.rootSessionKey ?? effectiveSessionKey

    // 创建运行上下文（在 streamFn 之前，因为 getMetadata 需要引用 ctx）
    const ctx = createRunContext(effectiveSessionKey, instanceId, rootSessionKey)
    ctx.agentName = def.name
    // 初始化 InstanceState（ctx 已就绪，metrics 在 agent 创建后赋值）
    const metrics: InstanceRuntimeMetrics = {
      definitionId: def.id,
      runningStartedAt: null,
      completedTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
    this.deps.instanceStates.set(instanceId, createInstanceState(ctx, metrics))

    const purpose = def.defaultPurpose ?? 'chat'

    /**
     * 每次调用时读取最新 chat 槽配置（避免 createInstance 闭包快照过期）。
     */
    const readLiveProviderCfg = () => this.deps.config.getProviderConfig?.()
    /**
     * 解析直连 baseUrl；无配置时返回 undefined。
     */
    const resolveDirectBaseUrl = (cfg = readLiveProviderCfg()) =>
      cfg ? ensureProviderBaseUrl(cfg.baseUrl, cfg.type) : undefined
    /**
     * 独立版始终走本地 direct：每轮用最新 apiKey/baseUrl 建流。
     */
    const buildLiveDirectStream = (): StreamFn => {
      return (model, context, options) => {
        const cfg = readLiveProviderCfg()
        if (!cfg?.enabled) {
          throw new Error('请先在设置中启用并配置文本对话模型（chat 能力槽）')
        }
        const isLocal = cfg.type === 'ollama' || cfg.type === 'lmstudio'
        if (!isLocal && !cfg.apiKey?.trim()) {
          throw new Error('请先在设置中填写文本对话模型的 API Key')
        }
        if (!cfg.modelId?.trim() && !model?.id) {
          throw new Error('请先在设置中填写或选择文本对话模型 ID')
        }
        const direct = createDirectStreamFn({
          credentials: {
            baseUrl: resolveDirectBaseUrl(cfg),
            apiKey: cfg.apiKey,
            apiFormat: cfg.apiFormat ?? 'responses',
          },
          log: (msg) => log.info(msg),
        })
        const startedAt = Date.now()
        const modelLabel = `llm:${cfg.type}:${model?.id ?? cfg.modelId ?? '(unknown)'}`
        try {
          // 注入 sessionId 到 options，用于 prompt caching
          const existingSessionId = (options as { sessionId?: unknown })?.sessionId
          const optionsWithSession = {
            ...options,
            sessionId:
              typeof existingSessionId === 'string' && existingSessionId
                ? existingSessionId
                : ctx.sessionKey,
          }
          const streamOrPromise = direct(model, context, optionsWithSession)
          // 记录每次模型请求到审计日志（复用现有「安全日志」面板）：
          // StreamFn 可能同步返回事件流也可能返回 Promise，成败都要等 result() resolve
          // 才知道（错误通过 stopReason==="error" 承载，而非 reject），故异步记录、不阻塞流本身。
          void Promise.resolve(streamOrPromise)
            .then((s) => s.result())
            .then((finalMessage: { stopReason?: string; errorMessage?: string }) => {
              const isError = finalMessage?.stopReason === 'error'
              this.deps.getAuditRepo()?.log({
                agentId: instanceId,
                toolName: modelLabel,
                resultSummary: isError
                  ? finalMessage.errorMessage ?? '请求失败'
                  : `baseUrl=${resolveDirectBaseUrl(cfg) ?? '(none)'}`,
                isError,
                durationMs: Date.now() - startedAt,
              })
            })
            .catch((err: unknown) => {
              this.deps.getAuditRepo()?.log({
                agentId: instanceId,
                toolName: modelLabel,
                resultSummary: err instanceof Error ? err.message : String(err),
                isError: true,
                durationMs: Date.now() - startedAt,
              })
            })
          return streamOrPromise
        } catch (err) {
          this.deps.getAuditRepo()?.log({
            agentId: instanceId,
            toolName: modelLabel,
            resultSummary: err instanceof Error ? err.message : String(err),
            isError: true,
            durationMs: Date.now() - startedAt,
          })
          throw err
        }
      }
    }
    const streamFnFactory = createStreamFnFactory({
      resolveCredentials: () => {
        const cfg = readLiveProviderCfg()
        return {
          baseUrl: resolveDirectBaseUrl(cfg),
          apiKey: cfg?.apiKey,
        }
      },
      log: (msg) => log.info(msg),
    })

    // wrapStreamFn：每轮 live direct + 按会话覆盖模型；压缩/摘要复用同一 live 流。
    let capturedInnerStream: StreamFn | null = null
    const wrapStreamFn = (_inner: StreamFn, resolved: ResolvedModel): StreamFn => {
      const liveDirect = buildLiveDirectStream()
      capturedInnerStream = liveDirect
      return (model, context, options) => {
        const pref = this.deps.sessionModelCatalog.getPreferredModelRawForStream(rootSessionKey, effectiveSessionKey)
        const thinking = this.deps.sessionThinkingPrefs.getThinkingPrefs(rootSessionKey)
        log.info(
          `[streamFn] rootKey=${rootSessionKey} effKey=${effectiveSessionKey} pref=${pref ?? '(none)'} defaultModel=${model.id} thinking=${thinking.thinkingEnabled} effort=${thinking.reasoningEffort}`,
        )
        // 思考开关必须传到 direct 请求上。pi-ai 的 streamSimple 把 options.reasoning 映射成
        // reasoningEffort，再据此决定是否发 reasoning_effort（OpenAI 系）或 thinking:disabled
        // （z.ai 系）。此前 direct 路径只读了偏好却没往下传，所以关掉思考后 DeepSeek 照旧推理。
        // 注意不要顺手把 model.reasoning 改成 false：z.ai 的「显式关闭」分支依赖它为真，
        // 置 false 会导致该分支被跳过，反而回到服务端默认开启思考。
        const streamOptions = thinking.thinkingEnabled
          ? {
              ...options,
              // 应用档位只有 high|max，而 pi-ai 的 ThinkingLevel 无 max，
              // 映射到其最高档 xhigh 以保住「最大思考强度」语义
              reasoning:
                options?.reasoning ??
                (thinking.reasoningEffort === 'max' ? 'xhigh' : thinking.reasoningEffort),
            }
          : { ...options, reasoning: undefined, reasoningEffort: undefined }

        if (pref) {
          const explicit = this.deps.modelRouter.resolveExplicitModelId(pref)
          ctx.resolvedModelId = explicit.id
          log.info(`[streamFn] 使用用户选择模型(direct): ${explicit.id} (api=${explicit.api})`)
          return liveDirect(explicit, context, streamOptions)
        }
        log.info(`[streamFn] 无用户选择，回退默认模型(direct): ${resolved.model.id}`)
        return liveDirect(model, context, streamOptions)
      }
    }

    // 会话级 MCP 过滤：与下方 getMcpServerHints 必须同源，否则 systemPrompt 宣告的
    // server 与实际 tools 参数不一致，模型会调用不存在的工具。
    const disabledMcpServers = this.deps.getSessionDisabledMcpServers?.(rootSessionKey) ?? []
    const isDisabledMcpTool = (name: string): boolean =>
      disabledMcpServers.some((server) => name.startsWith(`mcp__${server}__`))

    const allTools = disabledMcpServers.length
      ? this.deps.toolRegistry.getEnabledTools().filter((t) => !isDisabledMcpTool(t.name))
      : this.deps.toolRegistry.getEnabledTools()

    const tc = this.deps.getToolContext()
    if (!tc) {
      throw new Error('[createInstance] toolContext is not initialized')
    }

    const getCwd = () => this.deps.config.getCwd()
    const getConversationId = () => this.deps.instanceToConversation.get(instanceId)
    const logToolAudit = (row: { toolName: string; resultSummary: string; isError: boolean }) => {
      const auditRepo = this.deps.getAuditRepo()
      if (!auditRepo) return
      auditRepo.log({
        agentId: instanceId,
        toolName: row.toolName,
        resultSummary: row.resultSummary,
        isError: row.isError,
      })
    }

    // 用户确认交互（IPC 弹窗 → 失败回退 native dialog → 等待响应），封装成注入式 PermissionProvider
    const permission: PermissionProvider = {
      requestPermission: async (input) => {
        const timeoutMs = 5 * 60 * 1000
        // 主进程直接放行：不依赖 ChatPage 挂载，纯渠道场景也不会推送 IM 审批或挂起等待
        if (this.deps.isAutoApproveEnabled()) {
          this.deps.ipcChannel.forwardIpcEvent({
            type: 'agent:permission:request',
            requestId: input.requestId,
            runId: input.runId,
            toolName: input.toolName,
            toolArgs: input.toolArgs,
            riskLevel: riskLevelForTool(input.toolName),
            description: input.description,
            timeoutMs,
            instanceId: input.instanceId,
            rootSessionKey: input.rootSessionKey,
          })
          return 'allow-once'
        }
        const ipcSent = this.deps.ipcChannel.forwardIpcEvent({
          type: 'agent:permission:request',
          requestId: input.requestId,
          runId: input.runId,
          toolName: input.toolName,
          toolArgs: input.toolArgs,
          riskLevel: riskLevelForTool(input.toolName),
          description: input.description,
          timeoutMs,
          instanceId: input.instanceId,
          rootSessionKey: input.rootSessionKey,
        })
        // 渠道会话没有弹窗，把审批文字化推给渠道用户
        const sessionKey =
          input.rootSessionKey ?? this.deps.instanceToConversation.get(input.instanceId)
        const viaChannel = sessionKey
          ? this.deps.notifyChannelInteraction({
              kind: 'permission',
              requestId: input.requestId,
              sessionKey,
              toolName: input.toolName,
              description: input.description,
            })
          : false
        // 渠道已承接时不再弹 native dialog（用户在 IM 里回复即可）
        if (!ipcSent && !viaChannel) {
          return showNativeToolPermissionDialog({
            parent: this.deps.config.getWindow(),
            toolName: input.toolName,
            description: input.description,
          })
        }
        return this.deps.permissionController.waitForPermission(input.requestId, timeoutMs)
      },
    }

    // 宿主专属增强 hooks（顺序须与历史一致：analytics → large-result → skill-hit-rate）
    const skillHitRateTracker = createSkillHitRateHook(this.deps.config.updateSkillAutoScope)
    {
      const s = this.deps.instanceStates.get(instanceId)
      if (s) s.skillHitRateTracker = skillHitRateTracker
    }
    const optionalHooks = [
      createLargeToolResultHook({ getCwd, getConversationId }),
      skillHitRateTracker.hook,
      createToolUsageHook(),
    ]

    // ── 注入接口：ConfigProvider（模型解析 + feature flags） ──
    // 灵栖/Lumii 独立版：始终声明 direct；未启用时由 liveDirect 在真正请求时抛出可读错误。
    const config: ConfigProvider = {
      getProviderCredentials: () => {
        const cfg = readLiveProviderCfg()
        return cfg?.enabled
          ? { apiKey: cfg.apiKey, baseUrl: resolveDirectBaseUrl(cfg) }
          : {}
      },
      resolveModel: (p: string, _override?: ModelOverride): ResolvedModel => {
        const cfg = readLiveProviderCfg()
        if (cfg?.enabled && cfg.modelId?.trim()) {
          return {
            model: this.deps.modelRouter.resolveExplicitModelId(cfg.modelId),
            providerSource: 'local',
          }
        }
        return {
          model: this.deps.modelRouter.resolve(p),
          providerSource: 'local',
        }
      },
      getFeatureFlags: () => this.deps.featureFlags,
    }

    // ── 注入接口：PromptContextProvider（skills/devices/soul + 上下文文件 + MCP 提示） ──
    const promptContext: PromptContextProvider = {
      getSkills: async () => {
        if (!this.deps.config.getSkills) return [] as readonly SkillInfo[]
        try {
          const r = await this.deps.config.getSkills()
          // 会话级技能过滤：设置页控制全局安装/启用，这里剔除本会话单独关掉的
          const disabled = this.deps.getSessionDisabledSkills?.(rootSessionKey) ?? []
          if (disabled.length === 0) {
            log.info(`[createInstance] Loaded ${r.length} skills for system prompt`)
            return r
          }
          const kept = r.filter((s) => {
            const id = (s as { id?: string }).id
            return !(id && disabled.includes(id)) && !disabled.includes(s.name)
          })
          log.info(
            `[createInstance] Loaded ${kept.length}/${r.length} skills for system prompt（会话禁用 ${r.length - kept.length} 个）`,
          )
          return kept
        } catch (err) {
          log.error(`[createInstance] Failed to load skills:`, err)
          return [] as readonly SkillInfo[]
        }
      },
      getCustomAgents: async () => {
        if (!this.deps.config.getCustomAgents) return [] as readonly CustomAgentInfo[]
        try {
          const r = await this.deps.config.getCustomAgents()
          log.info(`[createInstance] Loaded ${r.length} custom agents for system prompt`)
          return r
        } catch (err) {
          log.error(`[createInstance] Failed to load custom agents:`, err)
          return [] as readonly CustomAgentInfo[]
        }
      },
      getUserDevices: async () => {
        if (!this.deps.config.getUserDevices) return [] as readonly UserDeviceInfo[]
        try {
          const r = await this.deps.config.getUserDevices()
          log.info(`[createInstance] 已加载 ${r.length} 个用户设备`)
          return r
        } catch (err) {
          log.error(`[createInstance] 加载用户设备列表失败:`, err)
          return [] as readonly UserDeviceInfo[]
        }
      },
      getSoulContent: async () => {
        if (!this.deps.config.getSoulContent) return undefined
        try {
          const r = await this.deps.config.getSoulContent()
          if (r) log.info(`[createInstance] 已加载用户 SOUL 内容 (${r.length} chars)`)
          return r
        } catch (err) {
          log.error(`[createInstance] 加载用户 SOUL 内容失败:`, err)
          return undefined
        }
      },
      getContextFiles: (): readonly ContextFile[] => this.deps.promptComposer.loadContextFiles(),
      getMcpServerHints: (): readonly McpServerHint[] => {
        const hints: McpServerHint[] = []
        for (const [name, client] of this.deps.mcpClients) {
          if (!client.initialized) continue
          // 与 allTools 同源：会话禁用的 server 不出现在提示词里
          if (disabledMcpServers.includes(name)) continue
          const tools = this.deps.toolRegistry
            .getEnabledTools()
            .filter((t) => t.name.startsWith(`mcp__${name}__`))
            .map((t) => ({ name: t.name, description: t.description }))
          hints.push({ name, tools, instructions: client.getInstructions() })
        }
        return hints
      },
    }

    // ── 注入接口：EventSink（委派到宿主富事件处理器：IPC 转发 + 落库 + token 统计 + 记忆/快照） ──
    const richHandler = createAgentInstanceRuntimeEventHandler({
      instanceId,
      ctx,
      ipcChannel: this.deps.ipcChannel,
      conversationRepo: this.deps.getConversationRepo(),
      fileRepo: this.deps.getFileRepo(),
      fileMemoryHandler: this.deps.fileMemoryHandler,
      getWikiIngestHook: this.deps.getWikiIngestHook,
      // 与 bridge-wiki-tools 的 resolveAgentId 同口径（Agent 定义 id），
      // 否则摄入落在会话 id 命名空间，UI / CLI 默认视图查不到
      resolveWikiAgentId: () => this.deps.agentRegistry.get(instanceId)?.definitionId ?? 'default',
      instanceStates: this.deps.instanceStates,
      instanceToConversation: this.deps.instanceToConversation,
      agentName: def.name,
      isSubAgent: Boolean(options?.parentInstanceId),
      toolCallInstanceMap: this.deps.toolCallInstanceMap,
      toolStartTimeMap: this.deps.toolStartTimeMap,
      nodeStreamCallbacks: this.deps.nodeStreamCallbacks,
      getCompactionForRootSession: (k) => this.deps.sessionModelCatalog.getCompactionForRootSession(k),
      getSessionContextUsage: (k) => this.deps.getSessionContextUsage(k),
      setSessionProviderInputTokens: (k, tokens) => this.deps.setSessionProviderInputTokens(k, tokens),
      calibrateSessionCharsPerToken: (k, modelId, tokens) =>
        this.deps.calibrateSessionCharsPerToken(k, modelId, tokens),
      clearSessionProviderInputTokens: (k) => this.deps.clearSessionProviderInputTokens(k),
      setCurrentToolExecutorInstanceId: (id) => {
        this.deps.currentToolExecutorInstanceId.value = id
      },
      getCwd: this.deps.config.getCwd,
      onConversationEnd: this.deps.config.onConversationEnd,
      onAssistantMessagePersisted: ({ conversationId, runId }) => {
        const cwd = this.deps.config.getCwd()
        if (cwd) {
          void maybeSnapshot({ workspaceDir: cwd, conversationId, runId })
        }
      },
      onTurnComplete: (id, msgs) => {
        // 技能进化
        if (this.deps.config.skillEvolutionEngine) {
          log.info(`[SkillEvolution] onTurnComplete 触发: instanceId=${id}, 消息数=${msgs.length}`)
          this.deps.config.skillEvolutionEngine.onTurnComplete(id, msgs)
        }
        // 规则记忆提取 → 写入工作记忆（project/reference/general → SQLite；user/feedback → user_memory Markdown）
        try {
          const inst = this.deps.agentRegistry.get(id)
          if (inst) {
            const userTexts = msgs.filter((m) => m.role === 'user').map((m) => m.content)
            if (userTexts.length > 0) {
              const mm = this.deps.getMemoryManager()
              if (mm) {
                const count = mm.saveRuleExtractedCandidates(userTexts, inst.definitionId, 'local-user')
                if (count > 0) {
                  log.info(`[工作记忆] 规则提取 ${count} 条, instanceId=${id} definitionId=${inst.definitionId}`)
                }
              }
            }
          }
        } catch (err) {
          log.warn(`[工作记忆] 规则提取失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
    })
    const eventSink: EventSink = { emit: (event) => richHandler(event) }

    const comp = this.deps.sessionModelCatalog.getCompactionForRootSession(rootSessionKey)

    // host-kit 总装：resolveModel → streamFn(工厂+宿主包装) → 工具装配 → 提示词装配 →
    // registry.create（含压缩参数 + 领域提示推断）→ 订阅 eventSink → 设初始提示词。
    const runtime: AssembleAgentRuntime = {
      registry: this.deps.agentRegistry,
      permissionMemory: this.deps.permissionController.memory,
      cwd: this.deps.config.getCwd(),
      osInfo: `${process.platform} ${process.arch}`,
      runtimeInfo: {
        agentId: def.id,
        host: `${os.hostname()} - MtBot Windows`,
        channel: 'windows-agent-runtime',
        thinkingLevel: 'low',
      },
      workspaceLayout: { uploadsDir: 'uploads', outputsDir: 'outputs', filesDir: 'files' },
      promptDetail: this.deps.promptComposer.resolvePromptDetail(def.modelTier),
      // 注意：此处仅控制「系统提示词」是否走子 Agent 分支。改前 bridge 的 buildClientSystemPromptStructured
      // 从不传 isSubAgent（恒为 undefined→falsy），故保持 false 以等价复现旧提示词。
      // 子 Agent 的事件处理分支由下方 createAgentInstanceRuntimeEventHandler 的 isSubAgent 独立控制。
      // （让子 Agent 提示词也走 isSubAgent 分支属行为变更，应单独评估，不在本次纯抽取范围内。）
      isSubAgent: false,
      getActiveTasks: () => this.deps.promptComposer.getActiveTasks(conversationId),
      contextWindow: comp.contextWindow,
      outputReserveTokens: comp.outputReserveTokens,
      summaryReserveTokens: comp.summaryReserveTokens,
      enableMicroCompact: this.deps.featureFlags.ENABLE_MICRO_COMPACT,
      enableTurnTokenBudget: this.deps.featureFlags.ENABLE_TURN_TOKEN_BUDGET,
      // 惰性摘要生成器：压缩时才求值，此时 capturedInnerStream 已由 wrapStreamFn 赋值
      generateSummary: async (msgs, prompt, signal) => {
        if (!capturedInnerStream) {
          throw new Error('[createInstance] innerStream 尚未就绪，无法生成摘要')
        }
        return this.deps.createSummaryGenerator(capturedInnerStream, res.resolved.model)(msgs, prompt, signal)
      },
      toolLifecycle: {
        beforeActualToolExecute: () => {
          this.deps.currentToolExecutorInstanceId.value = instanceId
        },
        afterActualToolExecute: () => {
          this.deps.currentToolExecutorInstanceId.value = undefined
        },
      },
      toolLogger: {
        log: (...args: unknown[]) =>
          log.info(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
        error: (...args: unknown[]) =>
          log.error(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
      },
      onTelemetry: (metric) => {
        log.info(
          `[ToolTelemetry] ${metric.toolName} durationMs=${metric.durationMs} success=${metric.success}` +
            (metric.errorType ? ` errorType=${metric.errorType}` : ''),
        )
      },
      logToolAudit,
      wrapStreamFn,
    }

    const res = await assembleAgent(
      {
        definition: def,
        sessionKey: effectiveSessionKey,
        conversationId,
        parentInstanceId: options?.parentInstanceId,
        instanceId,
        userId: 'local-user',
        config,
        eventSink,
        permission,
        promptContext,
        streamFnFactory,
        tools: allTools,
        toolContext: tc,
        optionalHooks,
        memoryManager: this.deps.getMemoryManager() ?? undefined,
      },
      runtime,
    )
    const instance = res.instance
    const model = res.resolved.model
    // host-kit 内部已按 def 过滤工具；此处复算仅用于日志计数（与 assembleAgent 同一函数语义）
    const effectiveToolCount = filterToolsByDefinition(allTools, def).length

    log.info(
      `[createInstance] model.id=${model.id}, model.api=${(model as any).api}, purpose=${purpose}, ` +
        `contextWindow=${comp.contextWindow}, tools=${effectiveToolCount}/${allTools.length}, sessionKey=${effectiveSessionKey}`,
    )

    this.deps.messageBus.register(instanceId)
    this.deps.instanceToRootSessionKey.set(instanceId, rootSessionKey)

    // 存储 instanceId → conversationId 映射（用于 AI 回复持久化）
    if (conversationId) {
      this.deps.instanceToConversation.set(instanceId, conversationId)
      this.deps.lastActiveConvIdRef.value = conversationId
    }

    // ── 宿主覆盖：技能进化注入 + 个人记忆注入（host-kit 设的初始提示词将被本段覆盖） ──
    // assembleAgent 内部已用 prompt.initial.fullPrompt 设过一次（不含宿主记忆/技能进化）；
    // 这里按宿主语义重建并二次 setSystemPrompt，最终态与改前完全一致。
    let promptResult = res.prompt.initial
    if (this.deps.config.skillEvolutionEngine) {
      const { injectEvolutionGuidanceIntoResult } = await import('../skill-evolution/prompt-injector')
      promptResult = injectEvolutionGuidanceIntoResult(promptResult)
    }

    // 存储结构化基础提示词（不含用户记忆）、prompt 重建闭包、skills 快照到 InstanceState
    {
      const s = this.deps.instanceStates.get(instanceId)
      if (s) {
        s.basePrompt = promptResult
        s.promptRebuilder = res.prompt.buildPrompt
        s.skillsSnapshot = res.prompt.effectiveSkills
        // host-kit dispose 同时取消订阅 + 销毁实例，挂到 unsubscribe 供 lifecycle.destroy 调用
        s.unsubscribe = res.dispose
      }
    }

    // 注入用户个人记忆（user_memory Markdown）并设置初始系统提示词
    const injSettings = (await this.deps.config.getMemoryInjectionSettings?.()) ?? {
      injectPersonalMemory: true,
      injectWorkMemory: true,
    }
    instance.setMemoryInjectionFlags({
      injectWorkMemory: injSettings.injectWorkMemory !== false,
    })
    const initialPrompt = await this.deps.promptComposer.buildPromptWithMemory(
      instanceId,
      promptResult,
      injSettings,
    )
    instance.setSystemPrompt(initialPrompt)

    if (def.proactivity?.triggers?.length) {
      const sched = new ProactivityScheduler(def.proactivity, (trigger) => {
        const preview = trigger.prompt.length > 60 ? `${trigger.prompt.slice(0, 60)}…` : trigger.prompt
        log.info(`[Proactivity] def=${def.id} type=${trigger.type} prompt="${preview}"`)
        void this.deps.prompt(instanceId, trigger.prompt).catch((err) => {
          log.error('[Proactivity] prompt failed:', err)
        })
      })
      sched.start()
      {
        const s = this.deps.instanceStates.get(instanceId)
        if (s) s.proactivityScheduler = sched
      }
      log.info(
        `[Proactivity] scheduler started instance=${instanceId} triggers=${def.proactivity.triggers.length}`,
      )
    }

    // 缓存主 Agent 的 innerStream 和 model，供 compactContextAsync 生成 LLM 摘要
    if (def.id === 'main') {
      this.deps.mainInnerStreamRef.value = capturedInnerStream
      this.deps.mainModelRef.value = model
    }
    // 所有实例均缓存 stream，供 compactContextAsync 按 instanceId 查找
    {
      const s = this.deps.instanceStates.get(instanceId)
      if (s && capturedInnerStream) {
        s.stream = {
          innerStream: capturedInnerStream,
          model,
        }
      }
    }

    log.info(`Created agent instance: ${instanceId} (${def.name})`)
    this.deps.pushActivitySnapshot(rootSessionKey)
    return instanceId
  }

  /**
   * 注册节点流式事件回调（Gateway 委派 Agent 执行时使用）
   * 当指定实例产生事件时，回调会被同步调用。
   */
  registerNodeStreamCallback(instanceId: string, cb: (event: AgentRuntimeEvent) => void): void {
    this.deps.nodeStreamCallbacks.set(instanceId, cb)
    log.info(`[nodeStream] 注册流式回调: instanceId=${instanceId}`)
  }

  /**
   * 注销节点流式事件回调
   */
  unregisterNodeStreamCallback(instanceId: string): void {
    this.deps.nodeStreamCallbacks.delete(instanceId)
    log.info(`[nodeStream] 注销流式回调: instanceId=${instanceId}`)
  }

  /**
   * 把图片路径列表读盘并转换为 pi-ai 的 ImageContent[] 块。
   *
   * - 相对路径会拼到当前 cwd（workspace 根目录）
   * - 不存在或读取失败的图片只记录 warn 后跳过，不抛错（避免单张图阻塞整个发送）
   * - mimeType 通过扩展名推断，未知扩展名兜底为 image/png
   *
   * 返回数组顺序与入参一致；全部失败时返回空数组（不会返回 undefined）。
   *
   * 内部使用 image-resizer 做格式嗅探 + 尺寸/大小压缩，确保传给 LLM 的每张图≤5MB。
   */
  async buildImageContents(imagePaths?: readonly string[]): Promise<import('@mariozechner/pi-ai').ImageContent[]> {
    if (!imagePaths || imagePaths.length === 0) return []
    const cwd = this.deps.config.getCwd()
    const blocks: import('@mariozechner/pi-ai').ImageContent[] = []
    let totalFinalBytes = 0
    for (const p of imagePaths) {
      try {
        const absPath = path.isAbsolute(p) ? p : path.join(cwd, p)
        if (!fs.existsSync(absPath)) {
          log.warn(`[buildImageContents] 图片不存在，跳过: ${absPath}`)
          continue
        }
        const raw = await fs.promises.readFile(absPath)
        // 原始文件 > 50MB 直接跳过，避免 sharp 内存爆炸
        if (raw.byteLength > 50 * 1024 * 1024) {
          log.warn(`[buildImageContents] 图片过大（${(raw.byteLength / 1024 / 1024).toFixed(1)}MB > 50MB），跳过: ${absPath}`)
          continue
        }
        const ext = path.extname(absPath)
        const { buffer, mimeType, wasResized, originalBytes, finalBytes } = await resizeImageIfNeeded(raw, ext)
        if (wasResized) {
          log.info(
            `[buildImageContents] 已压缩: ${path.basename(absPath)} ${(originalBytes / 1024 / 1024).toFixed(2)}MB → ${(finalBytes / 1024 / 1024).toFixed(2)}MB (${mimeType})`,
          )
        } else {
          log.info(`[buildImageContents] 已构造图片块: ${path.basename(absPath)} (${mimeType}, ${(finalBytes / 1024).toFixed(0)}KB)`)
        }
        blocks.push({ type: 'image', data: buffer.toString('base64'), mimeType })
        totalFinalBytes += finalBytes
      } catch (err) {
        log.warn(`[buildImageContents] 读取/处理图片失败（跳过）: path=${p} err=${err instanceof Error ? err.message : String(err)}`)
      }
    }
    log.info(
      `[buildImageContents] 完成: 输入 ${imagePaths.length} 张 → 成功 ${blocks.length} 张, 总 ${(totalFinalBytes / 1024 / 1024).toFixed(2)}MB (base64 后约 ${(totalFinalBytes * 4 / 3 / 1024 / 1024).toFixed(2)}MB)`,
    )
    return blocks
  }
}
