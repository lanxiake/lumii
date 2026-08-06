/**
 * AgentRuntimeBridge — IPC 桥接主类
 *
 * 在 Electron 主进程中管理 Agent Runtime 实例。
 * 通过 IPC 将 Agent Runtime 事件传递到渲染进程。
 */

import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import {
  AgentRegistry,
  ToolRegistry,
  createMtBotTool,
  createGatewayStreamFn,
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

import {
  executeLocalCommand,
  readLocalFile,
  writeLocalFile,
  globLocal,
  grepLocal,
  fetchLocal,
} from './tool-providers'
import { McpStdioClient } from '@mtbot/agent-runtime'
import { McpManager } from './mcp-manager'
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
import { isPetMode, onVirtualHumanSettingsChanged } from '../pet/pet-mode-ipc'
import { getVirtualHumanSettings } from '../pet/pet-mode-store'
import { BridgeSessionModelCatalog } from './bridge-session-model-catalog'
import { BridgeSessionThinkingPrefs } from './bridge-session-thinking-prefs'
import { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import { BridgePromptComposer } from './bridge-prompt-composer'
import { resizeImageIfNeeded } from './image-resizer'
import {
  createAgentInstanceRuntimeEventHandler,
  type AssistantTurnToolRecord,
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
  private readonly toolTextPositionMap = new Map<string, number>()
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

  getCurrentWeixinCtx(): { channelUserId: string; contextToken: string; botToken?: string; ilinkBaseUrl?: string } | null {
    return this.promptDispatcher.getCurrentWeixinCtx()
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
      getDb: () => this.localDb.db,
      ipcChannel: this.ipcChannel,
      restoreHistoryForInstance: (instanceId, conversationId, limit) =>
        this.restoreHistoryForInstance(instanceId, conversationId, limit),
      createSummaryGenerator: (innerStream, model) => createLlmSummaryGenerator(innerStream, model),
      onSessionContextInvalidated: (sessionKey) => this.clearSessionProviderInputTokens(sessionKey),
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
      toolTextPositionMap: this.toolTextPositionMap,
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
      getFileRepo: () => this._fileRepo,
      getCwd: () => this.config.getCwd(),
      handleCompanionInstruction: async (instruction: string) => {
        if (!isLocalCompanionInstruction(instruction)) return null
        return handleLocalCompanionInstruction(instruction, {
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
        })
      },
    })
    // 旧版 local_companion_prefs 一次性迁移到 vhSettings（幂等，需先于 seed 执行）
    migrateLocalCompanionPrefsToVhSettings(this.localDb.db)
    ensureCompanionCronJobsSeeded(this.localDb.db)
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
      toolTextPositionMap: this.toolTextPositionMap,
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
      7,
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
    this.cronScheduler?.stop()
    this.cronScheduler = undefined

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
   * 解析会话上下文已用 token：优先提供商 inputTokens，其次本地消息估算。
   */
  private resolveSessionUsedTokens(sessionKey: string): number {
    const k = sessionKey.trim()
    const fromDb = this._conversationRepo?.getLastAssistantProviderInputTokens(k)
    if (fromDb != null && fromDb > 0) {
      this.sessionProviderInputTokens.set(k, fromDb)
      return fromDb
    }

    const cached = this.sessionProviderInputTokens.get(k)
    if (cached != null && cached > 0) {
      // 无 DB 记录时，仅在有活跃实例时信任内存缓存（当前轮次尚未落库）
      if (this.resolveMainInstanceForSession(k)) {
        return cached
      }
      this.sessionProviderInputTokens.delete(k)
    }

    const liveInstance = this.resolveMainInstanceForSession(k)
    const messages = liveInstance
      ? (liveInstance.getAgentMessages() as AgentMessage[])
      : (this.conversationRepo.loadMessagesAsPiFormat(k, { limit: 4000 }) as AgentMessage[])

    let usedTokens = estimateTokenCount(messages)

    const systemPrompt = liveInstance?.getSystemPrompt()?.trim()
    if (systemPrompt) {
      usedTokens += ceilTokenEstimate(estimateTextTokenCount(systemPrompt))
    }

    return usedTokens
  }

  getSessionContextUsage(sessionKey: string): { usedTokens: number; contextWindow: number; triggerThreshold: number } {
    const k = sessionKey.trim()
    const usedTokens = this.resolveSessionUsedTokens(k)
    const comp = this.sessionModelCatalog.getCompactionForRootSession(k)
    return { usedTokens, contextWindow: comp.contextWindow, triggerThreshold: DEFAULT_COMPACTION_TRIGGER_RATIO }
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

  generateImage(params: { prompt: string; modelId?: string; width?: number; height?: number; filename?: string; signal?: AbortSignal }): Promise<{ filePath: string; width: number; height: number; model: string; revisedPrompt: string }> {
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
    return this.promptDispatcher.prompt(instanceId, message, imageAttachmentPaths)
  }

  steer(instanceId: string, message: string): void { this.promptDispatcher.steer(instanceId, message) }
  abort(instanceId: string): void { this.promptDispatcher.abort(instanceId) }
  abortWithChildren(instanceId: string): void { this.promptDispatcher.abortWithChildren(instanceId) }
  abortSession(rootSessionKey: string): number { return this.promptDispatcher.abortSession(rootSessionKey) }
  destroy(instanceId: string): void { this.lifecycle.destroy(instanceId) }
  destroyAll(): void { this.lifecycle.destroyAll() }

  getInstances(): Array<{ id: string; definitionId: string; state: string }> {
    return this.agentRegistry.getAll().map((i) => ({ id: i.id, definitionId: i.definitionId, state: i.state }))
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

  getMcpStatus(): Array<{ name: string; connected: boolean }> { return this.mcpManager.getStatus() }

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

  createLocalCronJobRecord(params: { id: string; name: string; taskText: string; agentId?: string; scheduleType: 'at' | 'every' | 'cron'; scheduleExpr: string; nextRunAt: number; intervalMs?: number; enabled?: boolean; createdAt: number }): void {
    this.cronScheduler.createLocalCronJobRecord(params)
  }

  listLocalCronJobRecords(includeDisabled: boolean): ReturnType<CronScheduler['listLocalCronJobRecords']> {
    return this.cronScheduler.listLocalCronJobRecords(includeDisabled)
  }

  getLocalCronJobRecordById(id: string): ReturnType<CronScheduler['getLocalCronJobRecordById']> {
    return this.cronScheduler.getLocalCronJobRecordById(id)
  }

  deleteLocalCronJobRecord(id: string): number { return this.cronScheduler.deleteLocalCronJobRecord(id) }

  updateLocalCronJobRecord(params: { id: string; name: string; taskText: string; enabled: boolean }): number {
    return this.cronScheduler.updateLocalCronJobRecord(params)
  }

  listLocalCronRuns(jobId: string, limit: number): ReturnType<CronScheduler['listLocalCronRuns']> {
    return this.cronScheduler.listLocalCronRuns(jobId, limit)
  }

  async runCronJobManually(job: { id: string; task_text: string; agent_id: string | null }): Promise<void> {
    return this.cronScheduler.runCronJobManually(job)
  }

  private getDefaultDbPath(): string {
    return path.join(app.getPath('home'), '.lumii', 'data', 'agent-runtime.db')
  }

  private ensureDirectory(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }
}
