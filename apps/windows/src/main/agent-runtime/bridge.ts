/**
 * AgentRuntimeBridge — IPC 桥接主类
 *
 * 在 Electron 主进程中管理 Agent Runtime 实例。
 * 通过 IPC 将 Agent Runtime 事件传递到渲染进程。
 */

import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { resolveClientStateDir } from '../paths.js'
import {
  AgentRegistry,
  ToolRegistry,
  createMtBotTool,
  createGatewayStreamFn,
  createDirectStreamFn,
  DEFAULT_GATEWAY_STREAM_PATH,
  ModelRouter,
  resolveAgentFilePath,
  ALL_BUILT_IN_TOOL_CONFIGS,
  createFeatureFlags,
  MessageBus,
  AgentDefinitionStore,
  LocalDatabase,
  AgentMemoryRepo,
  MemoryManager,
  ConversationRepo,
  SegmentRepo,
  TaskRepo,
  AuditRepo,
  RuntimeStateRepo,
  FileRepo,
  maybeRunAutoVacuumSync,
  runBackupNow,
  listDatabaseBackups,
  deleteDatabaseBackup,
  restoreDatabaseFromBackup,
  type DatabaseBackupInfo,
  type LocalStorageStats,
  type AgentRuntimeEvent,
  type AgentDefinition,
  type ToolExecutionContext,
  type AgentRuntimeFeatureFlags,
  estimateTokenCount,
  estimateTextTokenCount,
  ceilTokenEstimate,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
} from '@mtbot/agent-runtime'
import type { ArchivePalaceMeta } from '@mtbot/agent-runtime'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { buildContextUsageBreakdown } from './context-usage-breakdown.js'
import type { ContextUsageBreakdownEntry } from '../../shared/agent-runtime-events'

import {
  executeLocalCommand,
  readLocalFile,
  writeLocalFile,
  globLocal,
  grepLocal,
  fetchLocal,
} from './tool-providers'
import { McpStdioClient } from '@mtbot/agent-runtime'
import { McpManager, type McpServerRuntimeStatus } from './mcp-manager'
import type { McpServerEntry } from '../config/mcp-config'
import { PermissionController } from './permission-controller'
import { AskUserQuestionController } from './ask-user-question-controller'
import { FileMemoryHandler } from './file-memory-handler'
import { SegmentMemoryService } from './segment-memory-service'
import { CronScheduler } from './cron-scheduler'
import {
  isLocalCompanionInstruction,
  handleLocalCompanionInstruction,
  ensureCompanionCronJobsSeeded,
  syncCompanionTickJobEnabled,
  migrateLocalCompanionPrefsToVhSettings,
} from './local-companion-handler'
import { ensureSeedCronJobsSeeded } from '../seed-cron-jobs'
import { isPetMode, onVirtualHumanSettingsChanged } from '../pet/pet-mode-ipc'
import { getVirtualHumanSettings } from '../pet/pet-mode-store'
import { BridgeSessionModelCatalog } from './bridge-session-model-catalog'
import { BridgeSessionThinkingPrefs } from './bridge-session-thinking-prefs'
import { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import { BridgePromptComposer } from './bridge-prompt-composer'
import { resizeImageIfNeeded } from './image-resizer'
import {
  createAgentInstanceRuntimeEventHandler,
  type InstanceRuntimeMetrics,
} from './bridge-agent-instance-events'
import {
  agentRuntimeLog as log,
  CHILD_AGENT_DISALLOWED_TOOLS,
  filterToolsByDefinition,
  findAgentInstanceByRecipient,
  jsonToolResult,
  parseAtScheduleExpr,
  parseStrictMs,
  parseTaskStatus,
} from './bridge-utils'
import { InstanceStateStore, createInstanceState, type InstanceState } from './bridge-instance-state'
import { BridgeImageServices } from './bridge-image-services'
import { BridgeContextCompactor, createLlmSummaryGenerator } from './bridge-context-compactor'
import { BridgeConversationManager } from './bridge-conversation-manager'
import { BridgeLifecycle } from './bridge-lifecycle'
import { BridgeInstanceFactory } from './bridge-instance-factory'
import { BridgeToolRegistrar } from './bridge-tool-registrar'
import { BridgePromptDispatcher } from './bridge-prompt-dispatcher'
import { RouterService } from './router/router-service'
import { GatewayRouterLlmCaller } from './router/llm-caller'
import { RouterHitRateTracker } from './router/router-hit-rate-tracker'
import type { AgentRuntimeBridgeConfig, AgentLifecycleSnapshot } from './bridge-types'
import { ensureProviderBaseUrl } from '../provider-config'

export type { AgentRuntimeBridgeConfig, AgentLifecycleSnapshot }

export class AgentRuntimeBridge {
  private readonly agentRegistry = new AgentRegistry()
  private readonly toolRegistry = new ToolRegistry()
  private readonly modelRouter = new ModelRouter()
  private readonly localDb = new LocalDatabase()
  /** Per-instance 聚合状态 */
  private readonly instanceStates = new InstanceStateStore()
  /** 当前打开的 SQLite 主文件路径（initialize 后可用） */
  private resolvedDbPath: string | null = null
  private config: AgentRuntimeBridgeConfig
  private featureFlags: AgentRuntimeFeatureFlags
  private initialized = false
  private readonly permissionController = new PermissionController()
  private readonly askUserQuestionController = new AskUserQuestionController()
  /** instanceId → conversationId（独立维护，非 per-instance 状态） */
  private readonly instanceToConversation = new Map<string, string>()
  /** 最近活跃的 conversationId（Cron agent 实例绑定会话用） */
  private readonly lastActiveConvIdRef: { value: string | null } = { value: null }
  private get lastActiveConvId(): string | null { return this.lastActiveConvIdRef.value }
  private set lastActiveConvId(v: string | null) { this.lastActiveConvIdRef.value = v }
  /** `${instanceId}:${toolCallId}` 复合键 Map（独立维护） */
  private readonly toolStartTimeMap = new Map<string, number>()

  // 存储层 Repos — 初始化后可用
  private _fileRepo: FileRepo | null = null
  private _memoryRepo: AgentMemoryRepo | null = null
  private _memoryManager: MemoryManager | null = null
  /** 段落总结记忆服务（灰度，默认关闭） */
  private _segmentMemoryService: SegmentMemoryService | null = null
  private fileMemoryHandler!: FileMemoryHandler
  private _conversationRepo: ConversationRepo | null = null
  private _taskRepo: TaskRepo | null = null
  private _auditRepo: AuditRepo | null = null
  private _runtimeStateRepo: RuntimeStateRepo | null = null
  private toolContext: ToolExecutionContext | null = null
  private cronScheduler!: CronScheduler
  private definitionStore: AgentDefinitionStore | null = null

  /** 当前正在执行工具的实例 ID（Ref 盒子，与 BridgeInstanceFactory 共享） */
  private readonly currentToolExecutorInstanceIdRef: { value: string | undefined } = { value: undefined }
  /** toolCallId → instanceId 映射 */
  private readonly toolCallInstanceMap = new Map<string, string>()

  private readonly messageBus = new MessageBus()
  private readonly sessionModelCatalog = new BridgeSessionModelCatalog()
  private readonly sessionThinkingPrefs = new BridgeSessionThinkingPrefs()
  private readonly ipcChannel = new BridgeRendererIpcChannel(() => this.config.getWindow())

  private readonly promptComposer = new BridgePromptComposer({
    getCwd: () => this.config.getCwd(),
    loadUserMemory: async () => {
      const fn = this.config.getUserMemory
      if (!fn) return undefined
      return fn()
    },
    getMemoryInjectionSettings: async () => {
      const fn = this.config.getMemoryInjectionSettings
      if (!fn) {
        return { injectPersonalMemory: true, injectWorkMemory: true }
      }
      return fn()
    },
    getTaskRepo: () => this._taskRepo,
    instanceToConversation: this.instanceToConversation,
    instanceStates: this.instanceStates,
  })

  private readonly mcpClients = new Map<string, McpStdioClient>()
  private mcpManager!: McpManager
  private readonly instanceToRootSessionKey = new Map<string, string>()
  private readonly nodeStreamCallbacks = new Map<string, (event: AgentRuntimeEvent) => void>()
  /** sessionKey → 最近一次 LLM 调用返回的 inputTokens（提供商真实 prompt tokens） */
  private readonly sessionProviderInputTokens = new Map<string, number>()

  /** 主 Agent 实例的 innerStream / model（仅 def.id === 'main' 时设置） */
  private readonly mainInnerStreamRef: { value: ReturnType<typeof createGatewayStreamFn> | null } = { value: null }
  private readonly mainModelRef: { value: import('@mariozechner/pi-ai').Model<any> | null } = { value: null }
  /**
   * callLLM 兜底用的独立 direct stream（懒创建）。
   * 不依赖任何 Agent 实例，供 cron / companion workflow 在无人会话时调用 LLM。
   */
  private callLlmFallbackStream: ReturnType<typeof createDirectStreamFn> | null = null

  private readonly imageServices: BridgeImageServices
  private readonly compactor: BridgeContextCompactor
  private readonly conversationManager: BridgeConversationManager
  private readonly lifecycle: BridgeLifecycle
  private instanceFactory!: BridgeInstanceFactory
  private toolRegistrar!: BridgeToolRegistrar
  private promptDispatcher!: BridgePromptDispatcher
  private routerHitRateTracker: RouterHitRateTracker = new RouterHitRateTracker()
  /** onVirtualHumanSettingsChanged 取消订阅（shutdown/re-init 时防重复注册） */
  private unsubscribeVhSettings?: () => void

  setWeixinMessageContext(ctx: { channelUserId: string; contextToken: string; botToken?: string; ilinkBaseUrl?: string } | null): void {
    this.promptDispatcher.setWeixinMessageContext(ctx)
  }

  getWeixinMessageSentViaTool(): boolean {
    return this.promptDispatcher.getWeixinMessageSentViaTool()
  }

  constructor(config: AgentRuntimeBridgeConfig) {
    this.config = config
    this.featureFlags = createFeatureFlags()
    this.imageServices = new BridgeImageServices({
      getGatewayUrl: () => this.config.gatewayUrl,
      getAuthToken: () => this.config.getAuthToken(),
      getDeviceId: this.config.getDeviceId,
      getModelRouter: () => this.modelRouter,
      getCwd: () => this.config.getCwd(),
    })
    this.compactor = new BridgeContextCompactor({
      getConversationRepo: () => this._conversationRepo,
      getInstanceStream: (id) => this.instanceStates.get(id)?.stream,
      getMainInnerStream: () => this.mainInnerStreamRef.value,
      getMainModel: () => this.mainModelRef.value,
      getAnyInstanceStream: () => {
        for (const st of this.instanceStates.values()) {
          if (st.stream?.innerStream && st.stream?.model) return st.stream
        }
        return undefined
      },
      getFallbackStream: () => this.getCallLlmFallbackStream(),
      getDb: () => this.localDb.db,
      ipcChannel: this.ipcChannel,
      restoreHistoryForInstance: (instanceId, conversationId, limit) =>
        this.restoreHistoryForInstance(instanceId, conversationId, limit),
      createSummaryGenerator: (innerStream, model) => createLlmSummaryGenerator(innerStream, model),
      onSessionContextInvalidated: (sessionKey) => this.clearSessionProviderInputTokens(sessionKey),
      onSessionContextTokensUpdated: (sessionKey, usedTokens) =>
        this.setSessionProviderInputTokens(sessionKey, usedTokens),
      getSessionContextUsage: (sessionKey) => this.getSessionContextUsage(sessionKey),
    })
    this.conversationManager = new BridgeConversationManager({
      localDb: this.localDb,
      getResolvedDbPath: () => this.resolvedDbPath,
      getConversationRepo: () => this._conversationRepo,
      getTaskRepo: () => this._taskRepo,
      getAgentRegistry: () => this.agentRegistry,
      getSessionModelCatalog: () => this.sessionModelCatalog,
    })
    this.lifecycle = new BridgeLifecycle({
      agentRegistry: this.agentRegistry,
      instanceStates: this.instanceStates,
      instanceToConversation: this.instanceToConversation,
      instanceToRootSessionKey: this.instanceToRootSessionKey,
      getConversationRepo: () => this._conversationRepo,
      messageBus: this.messageBus,
      permissionController: this.permissionController,
      askUserQuestionController: this.askUserQuestionController,
      ipcChannel: this.ipcChannel,
      getCronScheduler: () => this.cronScheduler,
      getDefinitionStore: () => this.definitionStore,
      toolStartTimeMap: this.toolStartTimeMap,
      toolCallInstanceMap: this.toolCallInstanceMap,
      nodeStreamCallbacks: this.nodeStreamCallbacks,
      setLastActiveConvId: (key) => { this.lastActiveConvId = key },
      finalizeShutdown: () => {
        this.unsubscribeVhSettings?.()
        this.unsubscribeVhSettings = undefined
        this.localDb.close()
        this._conversationRepo = null
        this._taskRepo = null
        this._auditRepo = null
        this._runtimeStateRepo = null
        this.toolContext = null
        this.initialized = false
      },
      showCronNotification: this.config.showCronNotification,
      createInstance: (def, sessionKey, conversationId, opts) =>
        this.createInstance(def, sessionKey, conversationId, opts),
      prompt: (instanceId, message) => this.prompt(instanceId, message),
      getFeatureFlags: () => this.featureFlags,
    })
  }

  private requireInitialized<T>(field: T | null, name: string): T {
    if (!field) throw new Error(`AgentRuntimeBridge not initialized (${name}). Call initialize() first.`)
    return field
  }

  get fileRepo(): FileRepo { return this.requireInitialized(this._fileRepo, 'fileRepo') }
  get memoryRepo(): AgentMemoryRepo { return this.requireInitialized(this._memoryRepo, 'memoryRepo') }
  get memoryManager(): MemoryManager { return this.requireInitialized(this._memoryManager, 'memoryManager') }
  /** 段落总结记忆服务（灰度，可能为 null/关闭） */
  get segmentMemory(): SegmentMemoryService | null { return this._segmentMemoryService }
  get conversationRepo(): ConversationRepo { return this.requireInitialized(this._conversationRepo, 'conversationRepo') }
  get taskRepo(): TaskRepo { return this.requireInitialized(this._taskRepo, 'taskRepo') }
  get auditRepo(): AuditRepo { return this.requireInitialized(this._auditRepo, 'auditRepo') }
  get runtimeStateRepo(): RuntimeStateRepo { return this.requireInitialized(this._runtimeStateRepo, 'runtimeStateRepo') }

  setSkillEvolutionEngine(engine: import('../skill-evolution/index').SkillEvolutionEngine): void {
    this.config.skillEvolutionEngine = engine
  }

  getSkillEvolutionEngine(): import('../skill-evolution/index').SkillEvolutionEngine | undefined {
    return this.config.skillEvolutionEngine
  }

  callLLM(prompt: string, instanceId?: string, purpose?: string): Promise<string> {
    return this.compactor.callLLM(prompt, instanceId, purpose)
  }

  /**
   * 无 Agent 实例时为 callLLM 构造独立 direct stream + chat 模型。
   * 读取最新 chat 槽配置；未启用或缺少 modelId 时返回 undefined（由 callLLM 抛明确错误）。
   */
  private getCallLlmFallbackStream():
    | { innerStream: ReturnType<typeof createDirectStreamFn>; model: import('@mariozechner/pi-ai').Model<any> }
    | undefined {
    const cfg = this.config.getProviderConfig?.()
    if (!cfg?.enabled) {
      log.warn('[callLLM fallback] chat 能力槽未启用，无法创建兜底 stream')
      return undefined
    }
    const modelId = cfg.modelId?.trim()
    if (!modelId) {
      log.warn('[callLLM fallback] chat 模型 ID 为空，无法创建兜底 stream')
      return undefined
    }
    const isLocal = cfg.type === 'ollama' || cfg.type === 'lmstudio'
    if (!isLocal && !cfg.apiKey?.trim()) {
      log.warn('[callLLM fallback] 缺少 API Key，无法创建兜底 stream')
      return undefined
    }

    if (!this.callLlmFallbackStream) {
      log.info('[callLLM fallback] 创建后台 LLM 专用 direct stream')
      // 每轮读取最新凭据，避免设置变更后仍用旧 Key
      this.callLlmFallbackStream = ((model, context, options) => {
        const live = this.config.getProviderConfig?.()
        if (!live?.enabled) {
          throw new Error('请先在设置中启用并配置文本对话模型（chat 能力槽）')
        }
        const direct = createDirectStreamFn({
          credentials: {
            baseUrl: ensureProviderBaseUrl(live.baseUrl, live.type),
            apiKey: live.apiKey,
          },
          log: (msg) => log.info(`[callLlmFallback] ${msg}`),
        })
        return direct(model, context, options)
      }) as ReturnType<typeof createDirectStreamFn>
    }

    const model = this.modelRouter.resolveExplicitModelId(modelId)
    return { innerStream: this.callLlmFallbackStream, model }
  }

  /** 初始化（打开数据库 + 注册内建工具） */
  async initialize(): Promise<void> {
    if (this.initialized) return

    const dbPath = this.config.dbPath ?? this.getDefaultDbPath()
    log.info(`[initialize] 准备打开数据库: ${dbPath}`)
    this.ensureDirectory(path.dirname(dbPath))
    this.resolvedDbPath = dbPath

    await this.localDb.open({ dbPath, backupOnOpen: true })
    const db = this.localDb.db
    void maybeRunAutoVacuumSync(db, dbPath)

    // 创建 Repos
    this._memoryRepo = new AgentMemoryRepo(db)
    this._conversationRepo = new ConversationRepo(db)
    const segmentRepo = new SegmentRepo(db)
    this._memoryManager = new MemoryManager(this._memoryRepo, {
      onPersonalMemoryExtracted: (candidates) => {
        void this.fileMemoryHandler.appendToUserMemory(candidates).catch((err: unknown) => {
          log.error('[onPersonalMemoryExtracted] 整理个人记忆失败:', err)
        })
      },
      callLLM: (prompt, ctx) => this.callLLM(prompt, undefined, ctx?.purpose ?? 'memory_extract'),
      getPersonalMemory: async () => {
        const mem = await this.config.getUserMemory?.()
        return mem?.content
      },
      updatePersonalMemory: async (content) => {
        await this.config.updateUserMemory?.(content)
      },
      // 来源下转（诉求 A）：注入段/对话仓库，getMemoryProvenance 可回读原文区间
      segmentRepo,
      conversationRepo: this._conversationRepo,
    })
    this._taskRepo = new TaskRepo(db)
    this._auditRepo = new AuditRepo(db)
    this._runtimeStateRepo = new RuntimeStateRepo(db)
    this._fileRepo = new FileRepo(db)

    // 段落总结记忆服务（灰度：MTBOT_SEGMENT_MEMORY=1 开启；关闭时所有调用 no-op）
    this._segmentMemoryService = new SegmentMemoryService({
      segmentRepo,
      conversationRepo: this._conversationRepo,
      memoryManager: this._memoryManager,
      callLLM: (prompt, ctx) => this.callLLM(prompt, undefined, ctx?.purpose ?? 'memory_extract'),
      // 宫殿互引（诉求 A · P2）：段原文归档进 MemPalace，drawer_id 由内容寻址确定性生成。
      // runtime 只认接口，此处由宿主注入 mempalace MCP 实现。
      archivePalace: (text, meta) => this.archiveSegmentToPalace(text, meta),
    })
    // app 退出前关闭所有残留 open 段（→ closed），下次启动 start() 重启恢复总结
    if (this._segmentMemoryService.isEnabled) {
      app.once('before-quit', () => {
        try {
          this._segmentMemoryService?.flushAllOpen('app_quit')
        } catch {
          // 退出阶段忽略
        }
      })
    }

    this.fileMemoryHandler = new FileMemoryHandler({
      getFileRepo: () => this._fileRepo,
      getCwd: () => this.config.getCwd(),
      instanceToConversation: this.instanceToConversation,
      instanceStates: this.instanceStates,
      forwardIpcEvent: this.ipcChannel.forwardIpcEvent.bind(this.ipcChannel),
      getUserMemory: this.config.getUserMemory,
      updateUserMemory: this.config.updateUserMemory,
      callLLM: (prompt, ctx) => this.callLLM(prompt, undefined, ctx?.purpose ?? 'memory_extract'),
    })

    // 中断感知：清理流式残留前记录哪些对话被中断
    try {
      const streamingRows = db.prepare(
        "SELECT conversation_id, COUNT(*) as cnt FROM messages WHERE is_streaming = 1 GROUP BY conversation_id",
      ).all() as { conversation_id: string; cnt: number }[]
      if (streamingRows.length > 0) {
        for (const row of streamingRows) {
          this._runtimeStateRepo!.setJson(`interrupted:${row.conversation_id}`, {
            conversationId: row.conversation_id,
            streamingMessages: row.cnt,
            detectedAt: new Date().toISOString(),
          })
        }
        log.info(`[initialize] 检测到 ${streamingRows.length} 个中断对话，已写入中断标记`)
      }
    } catch (err) {
      log.error('[initialize] 中断检测失败:', err)
    }

    // 保留上次异常退出遗留的流式消息内容，仅标记为已完成（供历史恢复）
    try {
      const finalized = this.conversationRepo?.finalizeAllStreamingMessages() ?? 0
      if (finalized > 0) {
        log.info(`[initialize] 已将 ${finalized} 条残留流式消息标记为已完成（保留内容）`)
      }
    } catch (err) {
      log.error('[initialize] finalize 流式残留消息失败:', err)
    }

    log.info(`Database opened: ${dbPath}`)

    const toolContext: ToolExecutionContext = {
      executeCommand: executeLocalCommand,
      readFile: (filePath, opts) =>
        readLocalFile(resolveAgentFilePath(filePath, this.config.getCwd()), opts),
      writeFile: (filePath, content) =>
        writeLocalFile(resolveAgentFilePath(filePath, this.config.getCwd()), content),
      glob: (pattern, opts) => {
        const cwd = this.config.getCwd();
        const resolvedCwd = opts?.cwd
          ? resolveAgentFilePath(opts.cwd, cwd)
          : cwd;
        return globLocal(pattern, { ...opts, cwd: resolvedCwd });
      },
      grep: (pattern, opts) => {
        const cwd = this.config.getCwd();
        const resolvedPath = opts?.path
          ? resolveAgentFilePath(opts.path, cwd)
          : cwd;
        return grepLocal(pattern, { ...opts, path: resolvedPath });
      },
      fetch: fetchLocal,
      getCwd: () => this.config.getCwd(),
      askUserQuestion: async (input) => {
        const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000
        this.ipcChannel.forwardIpcEvent({
          type: 'agent:ask-user:request',
          requestId: input.requestId,
          instanceId: input.instanceId,
          questions: input.questions,
          timeoutMs,
        })
        return this.askUserQuestionController.waitForAnswer(input.requestId, timeoutMs)
      },
    }
    this.toolContext = toolContext

    for (const toolConfig of ALL_BUILT_IN_TOOL_CONFIGS) {
      this.toolRegistry.register(createMtBotTool(toolConfig, toolContext))
    }

    this.toolRegistrar = new BridgeToolRegistrar({
      toolRegistry: this.toolRegistry,
      toolContext,
      config: this.config,
      getCronScheduler: () => this.cronScheduler,
      localDb: this.localDb,
      getTaskRepo: () => this._taskRepo,
      getMemoryManager: () => this._memoryManager,
      getConversationRepo: () => this._conversationRepo,
      getFeatureFlags: () => this.featureFlags,
      ipcChannel: this.ipcChannel,
      instanceStates: this.instanceStates,
      instanceToConversation: this.instanceToConversation,
      getCurrentToolExecutorInstanceId: () => this.currentToolExecutorInstanceIdRef.value,
      getDefinitionIdByInstanceId: (instanceId) => this.agentRegistry.get(instanceId)?.definitionId,
      toolCallInstanceMap: this.toolCallInstanceMap,
      getDefinitionStore: () => this.definitionStore,
      ensureOrchestrator: () => this.lifecycle.ensureOrchestrator(),
      weixinCtx: {
        getCurrent: () => this.promptDispatcher.getCurrentWeixinCtxRaw(),
        markSentViaTool: () => { this.promptDispatcher.markWeixinMessageSentViaTool() },
      },
      getChannelRouter: () => this.config.getChannelRouter?.() ?? null,
      generateImage: (params) => this.generateImage(params),
    })
    this.toolRegistrar.registerAll()

    this.cronScheduler = new CronScheduler(this.localDb, {
      showCronNotification: this.config.showCronNotification,
      getLastActiveConvId: () => this.lastActiveConvId,
      createInstanceById: (agentId, sessionKey, conversationId) =>
        this.createInstanceById(agentId, sessionKey, conversationId),
      prompt: (instanceId, message) => this.prompt(instanceId, message),
      destroy: (instanceId) => this.destroy(instanceId),
      ensureConversationExists: (conversationId, title) => this.ensureConversationExists(conversationId, title),
      notifyIncomingMessage: (sessionKey, text) => this.notifyIncomingMessage(sessionKey, text),
      getFileRepo: () => this._fileRepo,
      getCwd: () => this.config.getCwd(),
      ...(this.config.sendFeishuMessage ? { sendFeishuMessage: this.config.sendFeishuMessage } : {}),
      ...(this.config.getChannelRouter
        ? { getChannelRouter: this.config.getChannelRouter }
        : {}),
      addMemory: (content: string) => {
        // category 用 project：概览页「近期关注」的默认分段就是它
        this._memoryManager?.addMemory({
          agentId: 'assistant',
          userId: 'local-user',
          category: 'project',
          content,
        })
      },
      handleCompanionInstruction: async (instruction: string, options) => {
        if (!isLocalCompanionInstruction(instruction)) return null
        return handleLocalCompanionInstruction(
          instruction,
          {
            getDb: () => this.localDb.db,
            showNotification: this.config.showCronNotification
              ? (title, body) => this.config.showCronNotification!(title, body)
              : undefined,
            isPetMode: () => isPetMode(),
            getProactiveCare: () => {
              const s = getVirtualHumanSettings()
              return {
                enabled: s.proactiveCareEnabled,
                mode: s.proactiveCareMode,
                nickname: s.proactiveCareNickname,
              }
            },
            getUserMemory: this.config.getUserMemory,
            updateUserMemory: this.config.updateUserMemory,
            callLLM: (prompt) => this.callLLM(prompt, undefined, 'memory_consolidation'),
          },
          options,
        )
      },
    })
    // 旧版 local_companion_prefs 一次性迁移到 vhSettings（幂等，需先于 seed 执行）
    migrateLocalCompanionPrefsToVhSettings(this.localDb.db)
    ensureCompanionCronJobsSeeded(this.localDb.db)
    // 资讯任务已并入 ensureSeedCronJobsSeeded，不再单独播种
    ensureSeedCronJobsSeeded(this.localDb.db)
    // 设置页修改主动联系开关时，同步 tick job 的 enabled 状态并重载本地 cron 调度
    this.unsubscribeVhSettings?.()
    this.unsubscribeVhSettings = onVirtualHumanSettingsChanged((_settings, patch) => {
      if (patch.proactiveCareEnabled === undefined) return
      syncCompanionTickJobEnabled(this.localDb.db, patch.proactiveCareEnabled)
      this.cronScheduler?.reloadLocalCronScheduler()
    })
    this.cronScheduler.start()

    this.definitionStore = new AgentDefinitionStore({
      db: this.localDb.db,
      fetchById: this.config.fetchAgentDefinitionById,
      fetchAll: this.config.fetchAgentDefinitionsFromApi,
    })

    // 同步用户 Agent（首次启动及后台刷新）
    void this.definitionStore.syncUserAgents()
      .then((r) => log.info(`[initialize] 同步用户 Agent 完成: ${r.synced} 成功, ${r.failed} 失败`))
      .catch((err) => log.error('[initialize] 同步用户 Agent 失败:', err))

    this.mcpManager = new McpManager(this.toolRegistry, this.mcpClients)
    // 注入工具变更监听器: MCP 重连后刷新运行中实例的工具
    this.mcpManager.setToolsChangedListener(() => {
      log.info('[McpManager] 工具列表变更,刷新所有实例工具')
      this.refreshAllInstanceTools()
    })
    void this.mcpManager.load()

    this.instanceFactory = new BridgeInstanceFactory({
      config: this.config,
      agentRegistry: this.agentRegistry,
      toolRegistry: this.toolRegistry,
      modelRouter: this.modelRouter,
      instanceStates: this.instanceStates,
      instanceToConversation: this.instanceToConversation,
      instanceToRootSessionKey: this.instanceToRootSessionKey,
      nodeStreamCallbacks: this.nodeStreamCallbacks,
      toolCallInstanceMap: this.toolCallInstanceMap,
      toolStartTimeMap: this.toolStartTimeMap,
      currentToolExecutorInstanceId: this.currentToolExecutorInstanceIdRef,
      mainInnerStreamRef: this.mainInnerStreamRef,
      mainModelRef: this.mainModelRef,
      lastActiveConvIdRef: this.lastActiveConvIdRef,
      messageBus: this.messageBus,
      featureFlags: this.featureFlags,
      ipcChannel: this.ipcChannel,
      promptComposer: this.promptComposer,
      sessionModelCatalog: this.sessionModelCatalog,
      sessionThinkingPrefs: this.sessionThinkingPrefs,
      permissionController: this.permissionController,
      fileMemoryHandler: this.fileMemoryHandler,
      mcpClients: this.mcpClients,
      getDefinitionStore: () => this.definitionStore,
      getOrchestrator: () => this.lifecycle.ensureOrchestrator(),
      getAuditRepo: () => this._auditRepo,
      getConversationRepo: () => this._conversationRepo,
      getFileRepo: () => this._fileRepo,
      getMemoryManager: () => this._memoryManager,
      getToolContext: () => this.toolContext,
      pushActivitySnapshot: (k) => this.lifecycle.pushActivitySnapshot(k),
      prompt: (id, msg) => this.prompt(id, msg),
      createSummaryGenerator: (innerStream, model) => createLlmSummaryGenerator(innerStream, model),
      getSessionContextUsage: (sk) => this.getSessionContextUsage(sk),
      setSessionProviderInputTokens: (sk, tokens) => this.setSessionProviderInputTokens(sk, tokens),
      clearSessionProviderInputTokens: (sk) => this.clearSessionProviderInputTokens(sk),
    })

    this.promptDispatcher = new BridgePromptDispatcher({
      agentRegistry: this.agentRegistry,
      instanceStates: this.instanceStates,
      instanceToConversation: this.instanceToConversation,
      instanceToRootSessionKey: this.instanceToRootSessionKey,
      sessionModelCatalog: this.sessionModelCatalog,
      promptComposer: this.promptComposer,
      featureFlags: this.featureFlags,
      ipcChannel: this.ipcChannel,
      imageServices: this.imageServices,
      compactor: this.compactor,
      instanceFactory: this.instanceFactory,
      modelRouter: this.modelRouter,
      config: this.config,
      getSkillEvolutionEngine: () => this.config.skillEvolutionEngine,
      getConversationRepo: () => this._conversationRepo,
      routerService: this.createRouterService(),
      routerHitRateTracker: this.routerHitRateTracker,
      getSkillsSnapshot: this.config.getSkills,
      getCustomAgentsSnapshot: this.config.getCustomAgents,
      imageIntentLlmCaller: this.createImageIntentLlmCaller(),
    })

    // 启动时检查个人记忆是否需要主动整理（去重/冲突消解）
    void this._memoryManager
      .maybeConsolidateExistingPersonalMemory()
      .then((done) => {
        if (done) log.info('[initialize] 启动时已整理个人记忆')
      })
      .catch((err) => log.error('[initialize] 启动整理个人记忆失败:', err))

    this.initialized = true
    log.info(`Initialized with ${this.toolRegistry.size} built-in tools (stub overrides applied)`)
    this.ipcChannel.forwardToRenderer({ type: 'runtime:ready', timestamp: Date.now() })
  }

  // ── 存储统计 ──
  getLocalStorageStats(): LocalStorageStats { return this.conversationManager.getLocalStorageStats() }
  exportLocalDataJSONL(): string { return this.conversationManager.exportLocalDataJSONL() }
  clearMalformedMessages(): number { return this.conversationManager.clearMalformedMessages() }

  /**
   * 列出本地 SQLite 自动备份文件（按时间降序）。
   */
  listDatabaseBackups(): DatabaseBackupInfo[] {
    const dbPath = this.config.dbPath ?? this.getDefaultDbPath()
    const backupDir = path.join(path.dirname(dbPath), 'backups')
    return listDatabaseBackups(backupDir)
  }

  /**
   * 立即创建一份本地 SQLite 备份（含 WAL checkpoint，写入 backups/ 目录）。
   */
  createDatabaseBackupNow(): DatabaseBackupInfo {
    const dbPath = this.localDb.dbPath ?? this.resolvedDbPath ?? this.getDefaultDbPath()
    const backupDir = path.join(path.dirname(dbPath), 'backups')
    const backupPath = runBackupNow(
      dbPath,
      backupDir,
      10,
      this.localDb.isOpen ? this.localDb.db : undefined,
    )
    if (!backupPath) {
      throw new Error('备份失败，请检查磁盘空间、目录权限或数据库是否已打开')
    }
    const st = fs.statSync(backupPath)
    const info: DatabaseBackupInfo = {
      fileName: path.basename(backupPath),
      filePath: backupPath,
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
    }
    log.info(`[createDatabaseBackupNow] 手动备份完成: ${info.fileName} (${info.sizeBytes} bytes)`)
    return info
  }

  /**
   * 删除 backups/ 目录中的指定备份文件。
   */
  deleteDatabaseBackupFile(backupFileName: string): void {
    const dbPath = this.config.dbPath ?? this.getDefaultDbPath()
    const backupDir = path.join(path.dirname(dbPath), 'backups')
    if (!backupFileName.endsWith('.db.bak')) {
      throw new Error('无效的备份文件名')
    }
    const ok = deleteDatabaseBackup(backupDir, backupFileName)
    if (!ok) {
      throw new Error(`无法删除备份: ${backupFileName}`)
    }
    log.info(`[deleteDatabaseBackupFile] 已删除备份: ${backupFileName}`)
  }

  /**
   * 从指定备份恢复聊天记录并重新初始化 Runtime（会销毁当前 Agent 实例）。
   */
  async restoreDatabaseFromBackupFile(backupFileName: string): Promise<{
    conversationCount: number
    messageCount: number
  }> {
    const dbPath = this.config.dbPath ?? this.getDefaultDbPath()
    const backupDir = path.join(path.dirname(dbPath), 'backups')
    const backupPath = path.join(backupDir, backupFileName)

    if (!backupFileName.endsWith('.db.bak')) {
      throw new Error('无效的备份文件名')
    }
    if (!fs.existsSync(backupPath)) {
      throw new Error(`备份文件不存在: ${backupFileName}`)
    }

    log.warn(`[restoreDatabaseFromBackupFile] 开始从备份恢复: ${backupFileName}`)
    this.lifecycle.destroyAll()
    // 停掉旧调度器即可；下面 initialize() 会重新 new 一个覆盖上去
    this.cronScheduler?.stop()

    const ok = restoreDatabaseFromBackup(dbPath, backupPath)
    if (!ok) {
      throw new Error('写入备份失败，请检查磁盘空间、权限或是否有其他进程锁定数据库文件')
    }

    this.resolvedDbPath = dbPath
    await this.initialize()

    const stats = this.getLocalStorageStats()
    log.info(
      `[restoreDatabaseFromBackupFile] 恢复完成: conversations=${stats.conversationCount} messages=${stats.messageCount}`,
    )
    return {
      conversationCount: stats.conversationCount,
      messageCount: stats.messageCount,
    }
  }

  /**
   * 从最新备份恢复聊天记录（等价于选择 backups/ 中最新 .db.bak）。
   */
  async restoreDatabaseFromLatestBackup(): Promise<{
    conversationCount: number
    messageCount: number
    backupFileName: string
  }> {
    const backups = this.listDatabaseBackups()
    if (backups.length === 0) {
      throw new Error('没有可用的备份文件')
    }
    const latest = backups[0]!
    const result = await this.restoreDatabaseFromBackupFile(latest.fileName)
    return { ...result, backupFileName: latest.fileName }
  }

  // ── Feature Flags & Model ──
  setFeatureFlags(flags: Partial<AgentRuntimeFeatureFlags>): void {
    this.featureFlags = createFeatureFlags(flags)
    log.info('Feature flags updated:', this.featureFlags)
  }
  getFeatureFlags(): AgentRuntimeFeatureFlags { return this.featureFlags }
  getModelMapping(): Readonly<Record<string, string>> { return {} /* purpose 模式：客户端不再持有 tier→model 映射，由服务端 CapabilityResolver 解析 */ }

  setModelCatalogFromApi(entries: readonly { id: string; contextWindow?: number; maxTokens?: number }[]): void {
    this.sessionModelCatalog.setModelCatalogFromApi(entries)
  }

  primeSessionModelCompaction(sessionKey: string, modelRef: string | undefined): void {
    this.sessionModelCatalog.primeSessionModelCompaction(sessionKey, modelRef)
  }

  getCompactionForRootSession(rootSessionKey: string): { contextWindow: number; outputReserveTokens: number; summaryReserveTokens: number } {
    return this.sessionModelCatalog.getCompactionForRootSession(rootSessionKey)
  }

  /**
   * 记录会话最近一次 LLM 调用的提供商 inputTokens（用于上下文用量条）。
   */
  setSessionProviderInputTokens(sessionKey: string, inputTokens: number): void {
    const k = sessionKey.trim()
    if (!k || !Number.isFinite(inputTokens) || inputTokens <= 0) return
    this.sessionProviderInputTokens.set(k, Math.round(inputTokens))
  }

  /**
   * 清除会话的提供商 token 缓存（压缩/清空后，回退到估算直至下次 LLM 响应）。
   */
  clearSessionProviderInputTokens(sessionKey: string): void {
    this.sessionProviderInputTokens.delete(sessionKey.trim())
  }

  /**
   * 解析会话上下文已用 token：优先内存缓存（含压缩后的整窗种子），再 DB，再本地估算。
   */
  private resolveSessionUsedTokens(sessionKey: string): number {
    const k = sessionKey.trim()
    const cached = this.sessionProviderInputTokens.get(k)
    if (cached != null && cached > 0) {
      return cached
    }

    const fromDb = this._conversationRepo?.getLastAssistantProviderInputTokens(k)
    if (fromDb != null && fromDb > 0) {
      this.sessionProviderInputTokens.set(k, fromDb)
      return fromDb
    }

    const liveInstance = this.resolveMainInstanceForSession(k)
    const messages = liveInstance
      ? (liveInstance.getAgentMessages() as AgentMessage[])
      : // ✅ 修复：无活跃实例时，只加载最近 120 条消息（而非 4000），避免 UI 显示虚高
        (this.conversationRepo.loadMessagesAsPiFormat(k, { limit: 120 }) as AgentMessage[])

    let usedTokens = estimateTokenCount(messages)

    const systemPrompt = liveInstance?.getSystemPrompt()?.trim()
    if (systemPrompt) {
      usedTokens += ceilTokenEstimate(estimateTextTokenCount(systemPrompt))
    }

    return usedTokens
  }

  getSessionContextUsage(sessionKey: string): {
    usedTokens: number
    contextWindow: number
    triggerThreshold: number
    breakdown?: readonly ContextUsageBreakdownEntry[]
  } {
    const k = sessionKey.trim()
    const usedTokens = this.resolveSessionUsedTokens(k)
    const comp = this.sessionModelCatalog.getCompactionForRootSession(k)
    return {
      usedTokens,
      contextWindow: comp.contextWindow,
      triggerThreshold: DEFAULT_COMPACTION_TRIGGER_RATIO,
      breakdown: this.resolveSessionUsageBreakdown(k, usedTokens),
    }
  }

  /**
   * 分类明细：只有活跃实例能拿到系统提示词与工具定义，无实例时返回 undefined
   * （UI 退化为只显示总量）。
   */
  private resolveSessionUsageBreakdown(
    sessionKey: string,
    usedTokens: number,
  ): readonly ContextUsageBreakdownEntry[] | undefined {
    const instance = this.resolveMainInstanceForSession(sessionKey)
    if (!instance) return undefined
    return buildContextUsageBreakdown({
      systemPrompt: instance.getSystemPrompt(),
      toolDefinitions: instance.getTools(),
      messages: instance.getAgentMessages() as AgentMessage[],
      usedTokens,
    })
  }

  /**
   * 解析会话对应的主 Agent 实例（非子 Agent）
   */
  private resolveMainInstanceForSession(sessionKey: string) {
    const k = sessionKey.trim()
    if (!k) return undefined
    let fallback: ReturnType<typeof this.agentRegistry.get> | undefined
    for (const inst of this.agentRegistry.getAll()) {
      if (this.instanceToRootSessionKey.get(inst.id) !== k) continue
      if (!this.agentRegistry.getParentId(inst.id)) return inst
      fallback ??= inst
    }
    return fallback
  }

  setSessionPreferredModel(sessionKey: string, raw: string | undefined): void {
    this.sessionModelCatalog.setSessionPreferredModel(sessionKey, raw)
  }

  clearSessionPreferredModel(sessionKey: string): void {
    this.sessionModelCatalog.clearSessionPreferredModel(sessionKey)
    this.sessionThinkingPrefs.clearThinkingPrefs(sessionKey)
  }

  /**
   * 读取会话思考模式偏好
   */
  getSessionThinkingPrefs(sessionKey: string) {
    return this.sessionThinkingPrefs.getThinkingPrefs(sessionKey)
  }

  /**
   * 更新会话思考模式偏好
   */
  setSessionThinkingPrefs(
    sessionKey: string,
    patch: Partial<import('./bridge-session-thinking-prefs.js').SessionThinkingPrefs>,
  ) {
    return this.sessionThinkingPrefs.setThinkingPrefs(sessionKey, patch)
  }

  get isEnabled(): boolean { return this.featureFlags.CLIENT_AGENT_RUNTIME }
  getCwd(): string { return this.config.getCwd() }

  /**
   * 段原文归档进 MemPalace（诉求 A · 宫殿互引）。
   * 由 SegmentMemoryPipeline 的 archivePalace 回调调用：drawer_id 已由 runtime
   * 内容寻址生成并回填，此处把原文 upsert 进宫殿（幂等）。宿主未注入则跳过。
   */
  private async archiveSegmentToPalace(
    text: string,
    meta: ArchivePalaceMeta,
  ): Promise<{ drawerId?: string }> {
    const archive = this.config.archiveMempalaceDrawer
    if (!archive) return {}
    try {
      const result = await archive({
        content: text,
        wing: meta.wing,
        room: meta.room,
        drawerId: meta.drawerId,
        metadata: {
          source: 'segment',
          segmentId: meta.segmentId,
          conversationId: meta.conversationId,
        },
      })
      return { drawerId: result?.drawerId }
    } catch (err) {
      log.warn(`[archiveSegmentToPalace] 段 ${meta.segmentId} 归档失败:`, err)
      return {}
    }
  }

  // ── 图片服务 ──
  recognizeImage(options: { imagePath: string; modelId?: string; prompt?: string; includeOcr?: boolean }): Promise<{ description: string; ocrText: string; modelId: string; provider: string }> {
    return this.imageServices.recognizeImage(options)
  }

  generateImage(params: { prompt: string; modelId?: string; width?: number; height?: number; filename?: string; referenceImagePaths?: string[]; signal?: AbortSignal }): Promise<{ filePath: string; width: number; height: number; model: string; revisedPrompt: string }> {
    return this.imageServices.generateImage(params)
  }

  // ── 实例管理 ──
  async createInstanceById(agentId: string, sessionKey?: string, conversationId?: string): Promise<string> {
    return this.instanceFactory.createInstanceById(agentId, sessionKey, conversationId)
  }

  getDefinitionSyncStatus(): ReturnType<AgentDefinitionStore['getSyncStatus']> {
    return this.definitionStore?.getSyncStatus() ?? { lastSyncAt: null, isSyncing: false, lastError: null, lastResult: null }
  }

  async syncUserAgentDefinitions(): Promise<{ synced: number; failed: number }> { return this.lifecycle.syncUserAgentDefinitions() }
  listCachedAgentDefinitions(): ReturnType<AgentDefinitionStore['listCachedRows']> { return this.lifecycle.listCachedAgentDefinitions() }
  removeCachedAgentDefinition(agentId: string): boolean { return this.lifecycle.removeCachedAgentDefinition(agentId) }
  clearCachedAgentsOlderThan(cutoffIso: string): number { return this.definitionStore?.removeOlderThan(cutoffIso) ?? 0 }
  clearAllCachedAgentDefinitions(): void { this.definitionStore?.clearAllCached() }
  async refreshCachedAgentDefinition(agentId: string): Promise<void> { await this.lifecycle.refreshCachedAgentDefinition(agentId) }

  async createInstance(agentDef?: AgentDefinition, sessionKey?: string, conversationId?: string, options?: { parentInstanceId?: string }): Promise<string> {
    return this.instanceFactory.createInstance(agentDef, sessionKey, conversationId, options)
  }

  registerNodeStreamCallback(instanceId: string, cb: (event: AgentRuntimeEvent) => void): void {
    this.instanceFactory.registerNodeStreamCallback(instanceId, cb)
  }

  unregisterNodeStreamCallback(instanceId: string): void {
    this.instanceFactory.unregisterNodeStreamCallback(instanceId)
  }

  async prompt(instanceId: string, message: string, imageAttachmentPaths?: readonly string[]): Promise<void> {
    try {
      return await this.promptDispatcher.prompt(instanceId, message, imageAttachmentPaths)
    } finally {
      // 本轮期间若发生配置/工具变更，销毁被推迟到此刻，下次使用时按新配置重建
      this.lifecycle.consumePendingInvalidation(instanceId)
    }
  }

  steer(instanceId: string, message: string): void { this.promptDispatcher.steer(instanceId, message) }
  abort(instanceId: string): void { this.promptDispatcher.abort(instanceId) }
  abortWithChildren(instanceId: string): void { this.promptDispatcher.abortWithChildren(instanceId) }

  /**
   * 中止会话：清掉挂起的权限/提问，再级联 abort，避免 tool 等待挂死导致会话锁不释放
   */
  abortSession(rootSessionKey: string): number {
    this.permissionController.rejectAllPending()
    this.askUserQuestionController.clearAll()
    return this.promptDispatcher.abortSession(rootSessionKey)
  }

  /**
   * 中止指定实例（含子 Agent），同时释放挂起的人机交互等待
   */
  abortWithChildrenAndPending(instanceId: string): void {
    this.permissionController.rejectAllPending()
    this.askUserQuestionController.clearAll()
    this.promptDispatcher.abortWithChildren(instanceId)
  }
  destroy(instanceId: string): void { this.lifecycle.destroy(instanceId) }
  destroyAll(): void { this.lifecycle.destroyAll() }

  getInstances(): Array<{ id: string; definitionId: string; state: string }> {
    return this.agentRegistry.getAll().map((i) => ({ id: i.id, definitionId: i.definitionId, state: i.state }))
  }

  /**
   * 让实例失效：空闲的立即销毁，运行中的推迟到本轮结束（详见 BridgeLifecycle.invalidate）。
   * getInstanceForSession 检测到实例已消失会自动按新配置重建。
   */
  invalidateInstance(instanceId: string): 'destroyed' | 'deferred' {
    return this.lifecycle.invalidate(instanceId)
  }

  /** 消费待失效标记（已标记则销毁），供调用方在复用实例前调用 */
  consumePendingInvalidation(instanceId: string): boolean {
    return this.lifecycle.consumePendingInvalidation(instanceId)
  }

  /**
   * MCP 工具变更后使现有实例失效，下次发消息按最新 toolRegistry 快照重建。
   * 与 Provider 配置变更（invalidateAgentInstancesForProviderChange）同一套路：
   * 逐个失效（而非 destroyAll，后者会关库/停 cron）。
   */
  private refreshAllInstanceTools(): void {
    let deferred = 0
    const instances = this.agentRegistry.getAll()
    for (const inst of instances) {
      if (this.invalidateInstance(inst.id) === 'deferred') deferred++
    }
    log.info(
      `[refreshAllInstanceTools] 已失效 ${instances.length} 个实例（其中 ${deferred} 个运行中，推迟到本轮结束），等待下次消息按新工具列表重建`,
    )
  }

  /** 确保对话记录存在（idempotent） */
  ensureConversationExists(conversationId: string, title?: string): boolean {
    return this.conversationManager.ensureConversationExists(conversationId, title)
  }

  /** 从 DB 加载历史消息注入到 Agent 实例 */
  restoreHistoryForInstance(instanceId: string, conversationId: string, limit = 500, excludeMessageId?: string): void {
    this.conversationManager.restoreHistoryForInstance(instanceId, conversationId, limit, excludeMessageId)
  }

  /** 实例内存中是否尚无对话消息（新建或重建实例后） */
  hasEmptyInstanceMemory(instanceId: string): boolean {
    const instance = this.agentRegistry.get(instanceId)
    return !instance || instance.getAgentMessages().length === 0
  }

  /**
   * 判断实例内存是否比 DB 历史更完整。
   * 用于 beforePrompt 防护：避免用残缺的 DB 快照覆盖仍保留完整上下文的实例内存。
   */
  isInstanceMemoryRicherThanDb(instanceId: string, sessionKey: string, excludeMessageId?: string): boolean {
    const instance = this.agentRegistry.get(instanceId)
    if (!instance) return false
    const memoryLen = instance.getAgentMessages().length
    if (memoryLen === 0) return false
    const repo = this.conversationRepo
    if (!repo) return false
    const dbLen = repo.loadMessagesAsPiFormat(sessionKey, { limit: 500, excludeMessageId }).length
    return memoryLen > dbLen + 1
  }

  /** 标记实例为外部通道，跳过 Session Tasks 注入 */
  markInstanceAsExternalChannel(instanceId: string): void {
    const s = this.instanceStates.get(instanceId)
    if (s) s.skipTaskInjection = true
    log.info(`[markInstanceAsExternalChannel] 已标记: instanceId=${instanceId}`)
  }

  /** 等待 Agent 实例进入 idle 状态 */
  async waitForInstanceIdle(instanceId: string): Promise<void> {
    const instance = this.agentRegistry.get(instanceId)
    if (!instance) return
    await instance.waitForIdle()
  }

  clearInstanceMemory(instanceId: string): void {
    const instance = this.agentRegistry.get(instanceId)
    if (!instance) { log.warn(`[clearInstanceMemory] 实例不存在: ${instanceId}`); return }
    instance.replaceMessages([])
    log.info(`[clearInstanceMemory] 已清空实例内存历史: instanceId=${instanceId}`)
  }

  clearConversationMessages(conversationId: string): void {
    // 清空前 flush open 段（灰度 no-op 时跳过）
    this._segmentMemoryService?.flush(conversationId, 'conversation_cleared')
    this.conversationManager.clearConversationMessages(conversationId)
  }
  listRecentConversations(limit = 10): readonly { id: string; title: string; updatedAt: string }[] { return this.conversationManager.listRecentConversations(limit) }
  notifyIncomingMessage(sessionKey: string, text: string, messageId?: string): void { this.lifecycle.notifyIncomingMessage(sessionKey, text, messageId) }
  notifyNavigateToSession(sessionKey: string, title?: string): void { this.lifecycle.notifyNavigateToSession(sessionKey, title) }
  triggerCronNotification(title: string, body: string): void { this.lifecycle.triggerCronNotification(title, body) }
  setLastActiveConversation(sessionKey: string): void { this.lifecycle.setLastActiveConversation(sessionKey) }

  /** 检查会话是否有流式消息 */
  hasStreamingMessages(conversationId: string): boolean {
    const row = this.localDb.db.prepare<{ count: number }>(
      `SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND is_streaming = 1`
    ).get(conversationId)
    return (row?.count ?? 0) > 0
  }

  isConversationInterrupted(conversationId: string): boolean { return this.runtimeStateRepo.has(`interrupted:${conversationId}`) }
  getInterruptInfo(conversationId: string): { conversationId: string; streamingMessages: number; detectedAt: string } | null {
    return this.runtimeStateRepo.getJson(`interrupted:${conversationId}`) ?? null
  }
  clearInterruptMarker(conversationId: string): void { this.runtimeStateRepo.delete(`interrupted:${conversationId}`) }

  /** 按 Agent 定义 ID 聚合运行时快照 */
  getLifecycleSnapshot(definitionId: string): AgentLifecycleSnapshot { return this.lifecycle.getLifecycleSnapshot(definitionId) }

  listTools(): Array<{ name: string; label: string; description: string; category: string; isReadOnly: boolean; needsPermission: boolean; enabled: boolean }> {
    return this.toolRegistry.getToolStatus()
  }

  getMcpStatus(): McpServerRuntimeStatus[] { return this.mcpManager.getStatus() }

  getMcpConfigError(): string | null { return this.mcpManager.getConfigError() }

  readMcpConfigFile(): { path: string; content: string } { return this.mcpManager.readConfigFile() }

  writeMcpConfigFile(content: string): Promise<void> { return this.mcpManager.writeConfigFile(content) }

  upsertMcpServer(entry: McpServerEntry, originalName?: string): Promise<void> { return this.mcpManager.upsert(entry, originalName) }

  importMcpServers(entries: readonly McpServerEntry[]): Promise<void> { return this.mcpManager.importEntries(entries) }

  removeMcpServer(name: string): Promise<void> { return this.mcpManager.remove(name) }

  setMcpServerEnabled(name: string, enabled: boolean): Promise<void> { return this.mcpManager.setEnabled(name, enabled) }

  reconnectMcpServer(name: string): Promise<void> { return this.mcpManager.reconnect(name) }

  compactContext(sessionKey: string, keepRecentTurns = 6): { success: boolean; previousMessageCount: number; newMessageCount: number; messagesRemoved: number } {
    return this.compactor.compactContext(sessionKey, keepRecentTurns)
  }

  compactContextAsync(instanceId: string, sessionKey: string, keepRecentTurns = 6, signal?: AbortSignal): Promise<{ success: boolean; previousMessageCount: number; newMessageCount: number; messagesRemoved: number; hadSummary: boolean }> {
    return this.compactor.compactContextAsync(instanceId, sessionKey, keepRecentTurns, signal)
  }

  getDbMessageCount(sessionKey: string): number { return this.conversationManager.getDbMessageCount(sessionKey) }

  toggleTool(toolName: string, enabled: boolean): boolean {
    return enabled ? this.toolRegistry.enableTool(toolName) : this.toolRegistry.disableTool(toolName)
  }

  waitForPermission(requestId: string, timeoutMs: number): Promise<'allow-once' | 'allow-always' | 'deny'> {
    return this.permissionController.waitForPermission(requestId, timeoutMs)
  }

  resolvePermission(requestId: string, decision: 'allow-once' | 'allow-always' | 'deny'): void {
    this.permissionController.resolvePermission(requestId, decision)
  }

  resolveAskUserQuestion(requestId: string, payload: { answers: Record<string, string>; annotations?: Record<string, { preview?: string; notes?: string }>; declined?: boolean }): void {
    this.askUserQuestionController.resolveAnswer(requestId, {
      answers: payload.answers,
      annotations: payload.annotations,
      declined: payload.declined,
    })
  }

  updateConfig(config: Partial<AgentRuntimeBridgeConfig>): void { this.config = { ...this.config, ...config } }
  flushIpcQueue(): void { this.ipcChannel.flushIpcQueue() }

  /** Router 命中率统计（供 admin/调试查询） */
  getRouterStats(): ReturnType<RouterHitRateTracker['getSummary']> {
    return this.routerHitRateTracker.getSummary()
  }

  /**
   * 创建 Pre-LLM Router 服务。
   * - config.routerEnabled === false → 返回 undefined（dispatcher 走旧路径）
   * - 默认启用，使用 basic tier 模型，独立 streamFn（不依赖任何已存在的 Agent 实例）
   */
  private createRouterService(): RouterService | undefined {
    if (this.config.routerEnabled === false) {
      log.info('[router] disabled by config')
      return undefined
    }
    const routerStream = createGatewayStreamFn({
      gatewayUrl: this.config.gatewayUrl,
      streamPath: DEFAULT_GATEWAY_STREAM_PATH,
      getAuthToken: this.config.getAuthToken,
      getDeviceId: this.config.getDeviceId,
      log: (msg) => log.info(`[router-stream] ${msg}`),
      getMetadata: () => ({ channel: 'windows-router' }),
    })
    const caller = new GatewayRouterLlmCaller({
      streamFn: routerStream,
      modelRouter: this.modelRouter,
    })
    log.info(
      `[router] enabled, model=${this.modelRouter.resolve('chat').id} timeoutMs=${this.config.routerTimeoutMs ?? 30000}`,
    )
    return new RouterService({
      llmCaller: caller,
      timeoutMs: this.config.routerTimeoutMs,
    })
  }

  /**
   * 创建生图意图分类用的轻量 LLM 调用器。
   * 独立于 Router 开关：即便 router 被关闭，生图自动分级仍可用。
   * 复用 chat tier 模型（经 LiteLLM），用于判断简单图 / 复杂专业图。
   */
  private createImageIntentLlmCaller(): GatewayRouterLlmCaller {
    const stream = createGatewayStreamFn({
      gatewayUrl: this.config.gatewayUrl,
      streamPath: DEFAULT_GATEWAY_STREAM_PATH,
      getAuthToken: this.config.getAuthToken,
      getDeviceId: this.config.getDeviceId,
      log: (msg) => log.info(`[image-intent-stream] ${msg}`),
      getMetadata: () => ({ channel: 'windows-image-intent' }),
    })
    return new GatewayRouterLlmCaller({
      streamFn: stream,
      modelRouter: this.modelRouter,
    })
  }
  // ── Cron 公共接口 ──
  reloadLocalCronScheduler(): void { this.cronScheduler.reloadLocalCronScheduler() }

  createLocalCronJobRecord(params: Parameters<CronScheduler['createLocalCronJobRecord']>[0]): void {
    this.cronScheduler.createLocalCronJobRecord(params)
  }

  listLocalCronJobRecords(includeDisabled: boolean): ReturnType<CronScheduler['listLocalCronJobRecords']> {
    return this.cronScheduler.listLocalCronJobRecords(includeDisabled)
  }

  getLocalCronJobRecordById(id: string): ReturnType<CronScheduler['getLocalCronJobRecordById']> {
    return this.cronScheduler.getLocalCronJobRecordById(id)
  }

  deleteLocalCronJobRecord(id: string): number { return this.cronScheduler.deleteLocalCronJobRecord(id) }

  updateLocalCronJobRecord(params: Parameters<CronScheduler['updateLocalCronJobRecord']>[0]): number {
    return this.cronScheduler.updateLocalCronJobRecord(params)
  }

  listLocalCronRuns(jobId: string, limit: number): ReturnType<CronScheduler['listLocalCronRuns']> {
    return this.cronScheduler.listLocalCronRuns(jobId, limit)
  }

  async runCronJobManually(job: { id: string; task_text: string; agent_id: string | null }): Promise<void> {
    return this.cronScheduler.runCronJobManually(job)
  }

  private getDefaultDbPath(): string {
    return path.join(resolveClientStateDir(), 'data', 'agent-runtime.db')
  }

  private ensureDirectory(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }
}
