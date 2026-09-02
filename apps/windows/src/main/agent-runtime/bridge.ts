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
  createDirectStreamFn,
  ModelRouter,
  resolveAgentFilePath,
  ALL_BUILT_IN_TOOL_CONFIGS,
  createFeatureFlags,
  MessageBus,
  AgentDefinitionStore,
  LocalDatabase,
  AgentMemoryRepo,
  MemoryIndexRepo,
  MemoryManager,
  ConversationRepo,
  SegmentRepo,
  TaskRepo,
  AuditRepo,
  RuntimeStateRepo,
  FileRepo,
  patchSessionConfig,
  readSessionConfig,
  toggleSessionDisabled,  maybeRunAutoVacuumSync,
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
  shouldIdleCompact,
  decideIdleCooldownMs,
  IDLE_COOLDOWN_FAILURE_MS,
} from '@mtbot/agent-runtime'
import type { ArchivePalaceMeta } from '@mtbot/agent-runtime'
import type { AgentMessage, StreamFn } from '@mariozechner/pi-agent-core'
import { buildContextUsageBreakdown, calibrateCharsPerToken, countPromptChars, aggregateMcpTokensByServer } from './context-usage-breakdown.js'
import type { ContextUsageBreakdownEntry } from '../../shared/agent-runtime-events'
import { computeContextBudget, shouldCompactByBudget } from '../../shared/context-budget'

import {
  executeLocalCommand,
  readLocalFile,
  writeLocalFile,
  globLocal,
  grepLocal,
  fetchLocal,
} from './tool-providers'
import {
  McpStdioClient,
  WikiRepo,
  WikiIngestHook,
  WikiOrganizeQueue,
  WikiOrganizer,
  WIKI_INBOX_ITEM_TYPES,
  WikiReclassifier,
  WikiContentExtractor,
  WikiCleanupScanner,
  WikiExporter,
  type WikiExporterDeps,
  WikiEroRepo,
  WikiEroExtractor,
  type WikiEroExtractSourceResult,
} from '@mtbot/agent-runtime'
import { McpManager, type McpServerRuntimeStatus } from './mcp-manager'
import type { McpServerEntry } from '../config/mcp-config'
import { PermissionController } from './permission-controller'
import { readWorkspaceTextForWiki } from './wiki-text-reader'
import { syncWikiSourceToVault } from './wiki-vault-host'
import { isWikiVectorEnabled } from './wiki-embedding-config'
import { AskUserQuestionController } from './ask-user-question-controller'
import { FileMemoryHandler } from './file-memory-handler'
import { SegmentMemoryService } from './segment-memory-service'
import { CronScheduler } from './cron-scheduler'
import { persistCronOutputToWiki } from './cron-wiki-persist'
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
import { initToolUsageStore } from '../tool-usage-store'
import { BridgePromptComposer } from './bridge-prompt-composer'
import {
  agentRuntimeLog as log,
} from './bridge-utils'
import { InstanceStateStore } from './bridge-instance-state'
import type { ChannelInteractionRequest } from '../channel/types'
import { BridgeImageServices } from './bridge-image-services'
import { BridgeContextCompactor, createLlmSummaryGenerator } from './bridge-context-compactor'
import { BridgeConversationManager } from './bridge-conversation-manager'
import { BridgeLifecycle } from './bridge-lifecycle'
import { BridgeInstanceFactory } from './bridge-instance-factory'
import { BridgeToolRegistrar } from './bridge-tool-registrar'
import { BridgePromptDispatcher } from './bridge-prompt-dispatcher'
import { RouterService } from './router/router-service'
import { RouterLlmCallerImpl } from './router/llm-caller'
import { RouterHitRateTracker } from './router/router-hit-rate-tracker'
import type { AgentRuntimeBridgeConfig, AgentLifecycleSnapshot } from './bridge-types'
import { ensureProviderBaseUrl } from '../provider-config'

/** 单机客户端固定 userId，与 wiki-commands 一致 */
const LOCAL_USER_ID = 'local-user'

/**
 * 将 Wiki ERO 抽取结果格式化为 cron 运行摘要。
 */
function formatWikiEroExtractSummary(result: WikiEroExtractSourceResult): string {
  const errPart = result.errors.length > 0 ? ` errors:${result.errors.length}` : ''
  return `scanned:${result.sourcesScanned} skipped:${result.sourcesSkipped} failed:${result.sourcesFailed} entities:${result.entitiesUpserted} relations:${result.relationsUpserted} obs:${result.observationsAdded}${errPart}`
}

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
  private _wikiRepo: WikiRepo | null = null
  private _wikiIngestHook: WikiIngestHook | null = null
  private _wikiOrganizeQueue: WikiOrganizeQueue | null = null
  private _wikiOrganizer: WikiOrganizer | null = null
  private _wikiReclassifier: WikiReclassifier | null = null
  private _wikiCleanupScanner: WikiCleanupScanner | null = null
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
  /** modelId → 标定的字符/token 比，由真实回执反推，供上下文明细直算固定部分 */
  private readonly modelCharsPerToken = new Map<string, number>()
  /** sessionKey → 最近一次回执对应的 modelId，用于取回该会话适用的标定比 */
  private readonly sessionLastModelId = new Map<string, string>()

  /** 主 Agent 实例的 innerStream / model（仅 def.id === 'main' 时设置） */
  private readonly mainInnerStreamRef: { value: ReturnType<typeof createDirectStreamFn> | null } = { value: null }
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
  /** Idle Compaction 轮询定时器（60s 间隔） */
  private idleCompactionTimer?: NodeJS.Timeout
  private wikiOrganizeTimer?: NodeJS.Timeout
  /** 正在 idle 压缩中的 sessionKey（同会话可能有多个实例，需按会话去重） */
  private readonly idleCompactingSessions = new Set<string>()

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
        if (this.idleCompactionTimer) {
          clearInterval(this.idleCompactionTimer)
          this.idleCompactionTimer = undefined
        }
        if (this.wikiOrganizeTimer) {
          clearInterval(this.wikiOrganizeTimer)
          this.wikiOrganizeTimer = undefined
        }
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
  get wikiRepo(): WikiRepo { return this.requireInitialized(this._wikiRepo, 'wikiRepo') }
  get wikiOrganizer(): WikiOrganizer { return this.requireInitialized(this._wikiOrganizer, 'wikiOrganizer') }
  get wikiIngestHook(): WikiIngestHook { return this.requireInitialized(this._wikiIngestHook, 'wikiIngestHook') }
  /** 重新编目器；LLM purpose 与归档分类同一档，保证小模型预算一致 */
  get wikiReclassifier(): WikiReclassifier { return this.requireInitialized(this._wikiReclassifier, 'wikiReclassifier') }
  get wikiOrganizeQueue(): WikiOrganizeQueue { return this.requireInitialized(this._wikiOrganizeQueue, 'wikiOrganizeQueue') }
  get wikiCleanupScanner(): WikiCleanupScanner { return this.requireInitialized(this._wikiCleanupScanner, 'wikiCleanupScanner') }

  /** 清理扫描判断「来源失效」规则用：同步检查文件是否存在 */
  fileExistsForWiki(filePath: string): boolean {
    try {
      return fs.existsSync(filePath)
    } catch {
      return false
    }
  }

  /** 导出命令按需创建 exporter：注入真实文件系统操作，agent-runtime 侧保持零 node:fs 依赖 */
  createWikiExporter(): WikiExporter {
    const deps: WikiExporterDeps = {
      mkdir: async (dirPath) => {
        await fs.promises.mkdir(dirPath, { recursive: true })
      },
      writeFile: async (filePath, content) => {
        await fs.promises.writeFile(filePath, content, 'utf-8')
      },
      joinPath: (...segments) => path.join(...segments),
    }
    return new WikiExporter(deps)
  }

  private _wikiEmbedderCache: import('./wiki-transformers-embedder').WikiHostEmbedderResult | null = null

  /**
   * 解析 Wiki 向量后端（懒加载缓存）：优先 multilingual-e5-small，失败回退 bigram。
   */
  async resolveWikiEmbedder(forceReload = false): Promise<import('./wiki-transformers-embedder').WikiHostEmbedderResult> {
    if (this._wikiEmbedderCache && !forceReload) return this._wikiEmbedderCache
    const { resolveWikiHostEmbedder } = await import('./wiki-transformers-embedder')
    this._wikiEmbedderCache = await resolveWikiHostEmbedder({
      enabled: isWikiVectorEnabled(),
    })
    return this._wikiEmbedderCache
  }

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

    await this.initializeDatabaseAndRepos()
    this.initializeToolContextAndRegistry()
    this.initializeCronScheduler()
    this.initializeDefinitionStoreAndMcp()
    this.initializeInstanceFactory()
    this.initializePromptDispatcher()
    this.finalizeInitialize()
  }

  /** initialize() 子块 1/7：开库、创建 Repos、恢复禁用工具集合、段落记忆服务、中断检测、finalize 残留流式消息 */
  private async initializeDatabaseAndRepos(): Promise<void> {
    const dbPath = this.config.dbPath ?? this.getDefaultDbPath()
    log.info(`[initialize] 准备打开数据库: ${dbPath}`)
    this.ensureDirectory(path.dirname(dbPath))
    this.resolvedDbPath = dbPath

    await this.localDb.open({ dbPath, backupOnOpen: true })
    const db = this.localDb.db
    void maybeRunAutoVacuumSync(db, dbPath)

    // 工具使用统计：注入 SQLite 适配器，并迁移旧 JSON（如存在）
    try {
      initToolUsageStore(db)
    } catch (err) {
      log.warn('[initialize] initToolUsageStore 失败（工具统计将降级为内存态）:', err)
    }

    // 创建 Repos
    this._memoryRepo = new AgentMemoryRepo(db)
    // FTS5 历史数据补齐：migration v15 只建空表（bigram 分词要 JS 做，SQL migration 做不到），
    // 老用户升级后 agent_memories 有数据但 agent_memories_fts 为空，search 会零命中。
    // 启动时检测不健康就 rebuild（单次开销，下次启动就跳过）。
    try {
      const indexRepo = new MemoryIndexRepo(db)
      const health = indexRepo.checkFtsHealth()
      if (!health.isHealthy) {
        log.info(`[initialize] FTS 索引不健康: ${health.reason}，自动重建...`)
        indexRepo.rebuildFts()
        log.info('[initialize] FTS 索引重建完成')
      }
    } catch (err) {
      log.warn('[initialize] FTS 索引健康检查/重建失败，记忆搜索将降级到 LIKE:', err)
    }

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

    // 恢复用户手动禁用的工具集合（重启后不丢失），并注册变更回调持久化
    const disabledToolsRaw = this._runtimeStateRepo.getJson<string[]>(AgentRuntimeBridge.DISABLED_TOOLS_KEY)
    if (disabledToolsRaw?.length) {
      this.toolRegistry.restoreUserDisabled(disabledToolsRaw)
      log.info(`[initialize] 恢复用户禁用工具集合: ${disabledToolsRaw.join(', ')}`)
    }
    this.toolRegistry.setOnUserDisabledChanged((disabled) => {
      this._runtimeStateRepo?.setJson(AgentRuntimeBridge.DISABLED_TOOLS_KEY, disabled)
    })

    // 段落总结记忆服务（灰度：MTBOT_SEGMENT_MEMORY=1 开启；关闭时所有调用 no-op）
    this._segmentMemoryService = new SegmentMemoryService({
      segmentRepo,
      conversationRepo: this._conversationRepo,
      memoryManager: this._memoryManager,
      // 注意：SegmentMemoryServiceDeps.callLLM 只接受 (prompt) 单参数，
      // 与宿主 this.callLLM(prompt, systemPromptOverride?, purpose?) 第三个参数对齐：
      // 段落总结目的固定为 'memory_extract'，此处用只接收 prompt 的闭包匹配接口签名。
      callLLM: (prompt: string) => this.callLLM(prompt, undefined, 'memory_extract'),
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
      // 注意：FileMemoryHandler.callLLM 只接受 (prompt) 单参数，
      // 固定 purpose='memory_extract'，与 file-memory 场景对齐。
      callLLM: (prompt: string) => this.callLLM(prompt, undefined, 'memory_extract'),
    })

    // Wiki 知识库：收件箱/资料/页面读写 + 摄入钩子 + 整理队列（P0）
    this._wikiRepo = new WikiRepo(db)
    // 同 agent_memories_fts 的历史数据补齐：wiki 的两个 FTS 虚表也由 migration 建空
    // （bigram 分词要 JS 做），老库升级后资料/页面搜索会静默零命中。启动时检测一次。
    try {
      const health = this._wikiRepo.checkIndexHealth()
      if (!health.isHealthy) {
        log.info(`[initialize] Wiki FTS 索引不健康: ${health.reason}，自动重建...`)
        const rebuilt = this._wikiRepo.rebuildIndex()
        log.info(`[initialize] Wiki FTS 索引重建完成（${rebuilt} 行）`)
      }
    } catch (err) {
      log.warn('[initialize] Wiki FTS 索引健康检查/重建失败，资料搜索可能零命中:', err)
    }
    this._wikiIngestHook = new WikiIngestHook(this._wikiRepo)
    this._wikiOrganizer = new WikiOrganizer(
      this._wikiRepo,
      (prompt: string) => this.callLLM(prompt, undefined, 'memory_extract'),
      new WikiContentExtractor({
        recognizeImage: async (imagePath: string) => {
          const result = await this.imageServices.recognizeImage({ imagePath })
          return result.description
        },
        // 产物/上传摄入只有路径没有正文，不读文件会归档出空页（限工作空间内的纯文本）
        readTextFile: (filePath: string, maxBytes: number) =>
          readWorkspaceTextForWiki(filePath, maxBytes),
      }),
      {
        onSourceCreated: (source) => {
          try {
            // organizer 已在建 source 后同步补完零成本摘要，这里读到的是最新行
            const latest = this._wikiRepo!.findSourceById(source.id) ?? source
            syncWikiSourceToVault(this._wikiRepo!, latest)
          } catch (err) {
            log.warn('[wiki-vault] organizer sync failed:', err)
          }
        },
      },
    )
    this._wikiOrganizeQueue = new WikiOrganizeQueue()
    this._wikiReclassifier = new WikiReclassifier(
      this._wikiRepo,
      (prompt: string) => this.callLLM(prompt, undefined, 'memory_extract'),
    )
    this._wikiCleanupScanner = new WikiCleanupScanner(this._wikiRepo)

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
  }

  /** initialize() 子块 2/7：构造 toolContext、注册内建工具、构造并调用 BridgeToolRegistrar。必须晚于 initializeDatabaseAndRepos（依赖 Repos 已创建） */
  private initializeToolContextAndRegistry(): void {
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
        // 渠道会话没有弹窗，同步把问题文字化推给渠道用户
        const sessionKey = input.instanceId
          ? this.instanceToConversation.get(input.instanceId)
          : undefined
        if (sessionKey) {
          this.notifyChannelInteraction({
            kind: 'ask',
            requestId: input.requestId,
            sessionKey,
            questions: input.questions,
          })
        }
        return this.askUserQuestionController.waitForAnswer(input.requestId, timeoutMs)
      },
      executeSkill: this.config.executeSkill,
      recordSkillExecution: (skillIdOrName) => this.config.recordSkillExecution?.(skillIdOrName),
      // 注意：ToolExecutionContext.getSkills 是同步签名（供 tool 内部即时列表查询）。
      // 宿主 getSkills 是异步的（从磁盘/IPC 读取），此处以空兜底：同步路径直接返回 []，
      // skill_* 工具列表信息由 skillStore 独立注入，不依赖 toolContext.getSkills 字段。
      getSkills: () => [],
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
      getWikiRepo: () => this._wikiRepo,
      getWikiIngestHook: () => this._wikiIngestHook,
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
  }

  /** initialize() 子块 3/7：构造 CronScheduler、迁移/播种 companion cron、订阅 vhSettings 变更、start() */
  private initializeCronScheduler(): void {
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
      persistCronOutputToWiki: async (jobId, jobName, output, finishedAt) => {
        try {
          await persistCronOutputToWiki(this.wikiRepo, { jobId, jobName, output, finishedAt })
        } catch (err) {
          log.warn('[cron-wiki-persist] 持久化失败:', err)
        }
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
            runWikiEroExtract: async () => {
              try {
                const ero = new WikiEroRepo(this.wikiRepo.database)
                const extractor = new WikiEroExtractor(
                  this.wikiRepo,
                  ero,
                  (prompt) => this.callLLM(prompt, undefined, 'wiki_ero_extract'),
                )
                const result = await extractor.extractFromSources('assistant', LOCAL_USER_ID, {})
                return formatWikiEroExtractSummary(result)
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                return `error: ${message}`
              }
            },
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
  }

  /** initialize() 子块 4/7：AgentDefinitionStore、同步用户 Agent、McpManager */
  private initializeDefinitionStoreAndMcp(): void {
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
  }

  /** initialize() 子块 5/7：构造 BridgeInstanceFactory。必须早于 initializePromptDispatcher（后者直接引用 this.instanceFactory） */
  private initializeInstanceFactory(): void {
    this.instanceFactory = new BridgeInstanceFactory({
      notifyChannelInteraction: (interaction) => this.notifyChannelInteraction(interaction),
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
      getWikiIngestHook: () => this._wikiIngestHook,
      mcpClients: this.mcpClients,
      getDefinitionStore: () => this.definitionStore,
      getOrchestrator: () => this.lifecycle.ensureOrchestrator(),
      getAuditRepo: () => this._auditRepo,
      getConversationRepo: () => this._conversationRepo,
      getFileRepo: () => this._fileRepo,
      getSessionDisabledMcpServers: (sk) => this.getSessionDisabledMcpServers(sk),
      getSessionDisabledSkills: (sk) => this.getSessionDisabledSkills(sk),
      getMemoryManager: () => this._memoryManager,
      getToolContext: () => this.toolContext,
      pushActivitySnapshot: (k) => this.lifecycle.pushActivitySnapshot(k),
      prompt: (id, msg) => this.prompt(id, msg),
      createSummaryGenerator: (innerStream, model) => createLlmSummaryGenerator(innerStream, model),
      getSessionContextUsage: (sk) => this.getSessionContextUsage(sk),
      setSessionProviderInputTokens: (sk, tokens) => this.setSessionProviderInputTokens(sk, tokens),
      calibrateSessionCharsPerToken: (sk, modelId, tokens) =>
        this.calibrateSessionCharsPerToken(sk, modelId, tokens),
      clearSessionProviderInputTokens: (sk) => this.clearSessionProviderInputTokens(sk),
    })
  }

  /** initialize() 子块 6/7：构造 BridgePromptDispatcher。必须晚于 initializeInstanceFactory（直接引用 this.instanceFactory，非惰性） */
  private initializePromptDispatcher(): void {
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
      getSessionContextUsage: (k) => this.getSessionContextUsage(k),
      routerService: this.createRouterService(),
      routerHitRateTracker: this.routerHitRateTracker,
      getSkillsSnapshot: this.config.getSkills,
      getCustomAgentsSnapshot: this.config.getCustomAgents,
      imageIntentLlmCaller: this.createImageIntentLlmCaller(),
    })
  }

  /** initialize() 子块 7/7：记忆整理 kickoff、置 initialized=true、ready 事件、启动 idle 轮询 */
  private finalizeInitialize(): void {
    // 启动时检查个人记忆是否需要主动整理（去重/冲突消解）
    void this._memoryManager!
      .maybeConsolidateExistingPersonalMemory()
      .then((done) => {
        if (done) log.info('[initialize] 启动时已整理个人记忆')
      })
      .catch((err) => log.error('[initialize] 启动整理个人记忆失败:', err))

    this.initialized = true
    log.info(`Initialized with ${this.toolRegistry.size} built-in tools (stub overrides applied)`)
    this.ipcChannel.forwardToRenderer({ type: 'runtime:ready', timestamp: Date.now() })

    // 启动 Idle Compaction 轮询（60s 间隔扫描所有实例）
    this.startIdleCompactionPolling()
    // 启动 Wiki 整理轮询（P0：每 30s 对 upload/output/search 三类待整理条目跑一次批量归档）
    this.startWikiOrganizePolling()
    // 后台预下载 Wiki 嵌入模型（hf-mirror → ~/.lumii/models/wiki-embeddings）
    void import('./wiki-embedding-model-downloader').then(({ prefetchWikiEmbeddingModelOnInit }) =>
      prefetchWikiEmbeddingModelOnInit(),
    )
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
    // 会话已有持久化模型偏好时以它为准：切换会话时 UI 传来的是全局下拉框选中值，
    // 直接采用会让"会话级模型"被最后一次全局选择覆盖。
    let effective = modelRef
    if (this.localDb.isOpen) {
      try {
        const saved = readSessionConfig(this.localDb.db, sessionKey).preferredModel?.trim()
        if (saved) effective = saved
      } catch (err) {
        log.error(`[primeSessionModelCompaction] 读取会话模型偏好失败 sessionKey=${sessionKey}:`, err)
      }
    }
    this.sessionModelCatalog.primeSessionModelCompaction(sessionKey, effective)
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
   * 用一轮真实回执标定该模型的字符/token 比。
   *
   * 固定部分（系统提示词、工具定义）据此直算，不再随对话增长虚涨。
   * 首轮标定最准（对话占比小），后续轮次滑动更新。
   */
  calibrateSessionCharsPerToken(sessionKey: string, modelId: string, promptTokens: number): void {
    const model = modelId.trim()
    if (!model || promptTokens <= 0) return
    const instance = this.resolveMainInstanceForSession(sessionKey)
    if (!instance) return

    this.sessionLastModelId.set(sessionKey.trim(), model)

    const totalChars = countPromptChars({
      systemPrompt: instance.getSystemPrompt(),
      toolDefinitions: instance.getTools(),
      messages: instance.getAgentMessages() as AgentMessage[],
    })
    const next = calibrateCharsPerToken(totalChars, promptTokens, this.modelCharsPerToken.get(model))
    if (next == null) return

    this.modelCharsPerToken.set(model, next)
    this._runtimeStateRepo?.set(`${AgentRuntimeBridge.CHARS_PER_TOKEN_KEY_PREFIX}${model}`, String(next))
  }

  /** 读取该模型已标定的字符/token 比（内存优先，回落 runtime_state） */
  private resolveCharsPerToken(modelId: string | undefined): number | undefined {
    const model = modelId?.trim()
    if (!model) return undefined
    const cached = this.modelCharsPerToken.get(model)
    if (cached != null) return cached

    const raw = this._runtimeStateRepo?.get(`${AgentRuntimeBridge.CHARS_PER_TOKEN_KEY_PREFIX}${model}`)
    if (!raw) return undefined
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    this.modelCharsPerToken.set(model, parsed)
    return parsed
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
      charsPerToken: this.resolveCharsPerToken(this.sessionLastModelId.get(sessionKey.trim())),
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
    // 落库：内存 Map 重启即失，会话恢复时需读回原模型，否则回落 128K 默认窗口
    if (!this.localDb.isOpen) return
    try {
      patchSessionConfig(this.localDb.db, sessionKey, { preferredModel: raw?.trim() || undefined })
    } catch (err) {
      log.error(`[setSessionPreferredModel] 持久化会话模型偏好失败 sessionKey=${sessionKey}:`, err)
    }
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

  /** 读某个会话级禁用集 */
  private readSessionDisabled(
    sessionKey: string,
    field: 'disabledMcpServers' | 'disabledSkills',
  ): readonly string[] {
    if (!this.localDb.isOpen) return []
    try {
      return readSessionConfig(this.localDb.db, sessionKey)[field] ?? []
    } catch (err) {
      log.error(`[readSessionDisabled] 读取失败 field=${field} sessionKey=${sessionKey}:`, err)
      return []
    }
  }

  /**
   * 写某个会话级禁用集。
   *
   * 工具集与技能清单都在实例创建时定死，改完必须让该会话实例失效，
   * 下轮消息才会按新列表重建。
   */
  private setSessionDisabled(
    sessionKey: string,
    field: 'disabledMcpServers' | 'disabledSkills',
    name: string,
    enabled: boolean,
  ): readonly string[] {
    if (!this.localDb.isOpen) return []
    const next = toggleSessionDisabled(this.localDb.db, sessionKey, field, name, !enabled)
    for (const inst of this.agentRegistry.getAll()) {
      if (this.instanceToRootSessionKey.get(inst.id) === sessionKey) this.invalidateInstance(inst.id)
    }
    log.info(
      `[setSessionDisabled] sessionKey=${sessionKey} ${field}: ${name} enabled=${enabled} 禁用集=[${next.join(', ')}]`,
    )
    return next
  }

  /** 该会话禁用的 MCP server 名 */
  getSessionDisabledMcpServers(sessionKey: string): readonly string[] {
    return this.readSessionDisabled(sessionKey, 'disabledMcpServers')
  }

  /** 会话级启停某个 MCP server */
  setSessionMcpServerEnabled(sessionKey: string, serverName: string, enabled: boolean): readonly string[] {
    return this.setSessionDisabled(sessionKey, 'disabledMcpServers', serverName, enabled)
  }

  /** 该会话禁用的技能 id */
  getSessionDisabledSkills(sessionKey: string): readonly string[] {
    return this.readSessionDisabled(sessionKey, 'disabledSkills')
  }

  /** 会话级启停某个技能 */
  setSessionSkillEnabled(sessionKey: string, skillId: string, enabled: boolean): readonly string[] {
    return this.setSessionDisabled(sessionKey, 'disabledSkills', skillId, enabled)
  }

  /**
   * 各 MCP server 的工具数与估算 token（供设置页展示「这个 server 值多少上下文」）。
   */
  getMcpServerTokenCosts(): readonly { name: string; toolCount: number; tokens: number }[] {
    return aggregateMcpTokensByServer(this.toolRegistry.getEnabledTools())
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

  /**
   * 向渲染进程广播事件（窗口不可用时入队）。
   * 供 IPC handler 推 conversation:created 等列表类事件——CLI / 控制口建的会话
   * 不经过前端 createSession，不广播侧栏就不会出现新会话。
   */
  forwardIpcEvent(event: Parameters<BridgeRendererIpcChannel['forwardIpcEvent']>[0]): boolean {
    return this.ipcChannel.forwardIpcEvent(event)
  }

  compactContext(sessionKey: string, keepRecentTurns = 6): { success: boolean; previousMessageCount: number; newMessageCount: number; messagesRemoved: number } {
    return this.compactor.compactContext(sessionKey, keepRecentTurns)
  }

  /** sessionKey → 正在进行的手动压缩的 AbortController，供 abortCompactContext 中止 */
  private readonly compactAbortControllers = new Map<string, AbortController>()

  async compactContextAsync(instanceId: string, sessionKey: string, keepRecentTurns = 6, signal?: AbortSignal): Promise<{ success: boolean; previousMessageCount: number; newMessageCount: number; messagesRemoved: number; hadSummary: boolean }> {
    const controller = new AbortController()
    this.compactAbortControllers.set(sessionKey, controller)
    if (signal) {
      signal.addEventListener('abort', () => controller.abort())
    }
    try {
      return await this.compactor.compactContextAsync(instanceId, sessionKey, keepRecentTurns, controller.signal)
    } finally {
      if (this.compactAbortControllers.get(sessionKey) === controller) {
        this.compactAbortControllers.delete(sessionKey)
      }
    }
  }

  /** 用户手动停止指定会话正在进行的压缩；无进行中压缩返回 false */
  abortCompactContext(sessionKey: string): boolean {
    const controller = this.compactAbortControllers.get(sessionKey)
    if (!controller) return false
    controller.abort()
    this.compactAbortControllers.delete(sessionKey)
    return true
  }

  getDbMessageCount(sessionKey: string): number { return this.conversationManager.getDbMessageCount(sessionKey) }

  toggleTool(toolName: string, enabled: boolean): boolean {
    return enabled ? this.toolRegistry.enableTool(toolName) : this.toolRegistry.disableTool(toolName)
  }

  waitForPermission(requestId: string, timeoutMs: number): Promise<'allow-once' | 'allow-always' | 'deny'> {
    return this.permissionController.waitForPermission(requestId, timeoutMs)
  }

  /**
   * 渠道交互通知器：渠道层注册后，提问/审批除推 IPC 弹窗外还会文字化推给渠道用户。
   * 返回 true 表示该会话确实由某个渠道承接（用于判断是否需要延长等待超时）。
   */
  private channelInteractionNotifier:
    | ((interaction: ChannelInteractionRequest) => boolean)
    | null = null

  setChannelInteractionNotifier(
    notifier: ((interaction: ChannelInteractionRequest) => boolean) | null,
  ): void {
    this.channelInteractionNotifier = notifier
  }

  /**
   * 渲染进程「自动审批」开关的镜像。
   * 开启时审批请求会被渲染进程立刻放行，渠道无需再推文字审批消息（纯噪音）。
   */
  private autoApprove = false

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled
  }

  get isAutoApproveEnabled(): boolean {
    return this.autoApprove
  }

  /** 供 instance-factory / toolContext 调用：把请求转交渠道层文字化 */
  notifyChannelInteraction(interaction: ChannelInteractionRequest): boolean {
    // 自动审批开着时审批会被立刻放行，推给渠道用户只是噪音；提问仍需真人回答
    if (interaction.kind === 'permission' && this.autoApprove) {
      log.info('[notifyChannelInteraction] 自动审批已开启，跳过渠道审批推送')
      return false
    }
    try {
      return this.channelInteractionNotifier?.(interaction) ?? false
    } catch (err) {
      log.warn(
        `[notifyChannelInteraction] 渠道通知失败（不影响桌面弹窗）: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
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
   * 为 Router / 生图意图分类构造复用 chat 槎位配置的轻量 direct stream。
   * chat 槎位未启用或未配置完整时返回 undefined（调用方各自决定降级方式）。
   */
  private buildAuxiliaryChatStream(logTag: string): StreamFn | undefined {
    const cfg = this.config.getProviderConfig?.()
    if (!cfg?.enabled) {
      log.warn(`[${logTag}] chat 能力槎位未启用，跳过`)
      return undefined
    }
    const isLocal = cfg.type === 'ollama' || cfg.type === 'lmstudio'
    if (!isLocal && !cfg.apiKey?.trim()) {
      log.warn(`[${logTag}] chat 能力槎位缺少 API Key，跳过`)
      return undefined
    }
    if (!cfg.modelId?.trim()) {
      log.warn(`[${logTag}] chat 能力槎位缺少模型 ID，跳过`)
      return undefined
    }
    return createDirectStreamFn({
      credentials: {
        baseUrl: ensureProviderBaseUrl(cfg.baseUrl, cfg.type),
        apiKey: cfg.apiKey,
        apiFormat: cfg.apiFormat ?? 'responses',
      },
      log: (msg) => log.info(`[${logTag}] ${msg}`),
    })
  }

  /**
   * 创建 Pre-LLM Router 服务。
   * - config.routerEnabled === false → 返回 undefined（dispatcher 走旧路径）
   * - chat 槎位未启用/未配置 → 返回 undefined（router 只是优化项，主对话配置缺失时直接跳过，不阻断主流程）
   */
  private createRouterService(): RouterService | undefined {
    if (this.config.routerEnabled === false) {
      log.info('[router] disabled by config')
      return undefined
    }
    const routerStream = this.buildAuxiliaryChatStream('router-stream')
    if (!routerStream) {
      log.info('[router] chat 槎位未配置，router 已禁用')
      return undefined
    }
    const caller = new RouterLlmCallerImpl({
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
   * 复用 chat 槎位配置；未配置时返回 undefined —— 调用方（bridge-prompt-dispatcher）
   * 已按可选依赖处理，缺失时直接跳过分级，使用用户选择的默认生图模型。
   */
  private createImageIntentLlmCaller(): RouterLlmCallerImpl | undefined {
    const stream = this.buildAuxiliaryChatStream('image-intent-stream')
    if (!stream) {
      log.info('[image-intent] chat 槎位未配置，生图意图分级已禁用')
      return undefined
    }
    return new RouterLlmCallerImpl({
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

  /**
   * 启动 Wiki 整理轮询（P0：30s 间隔，对所有有 pending 条目的归属逐一跑批量归档）。
   * 串行队列（WikiOrganizeQueue）保证同一时刻只有一个整理任务在跑，避免写冲突。
   */
  private startWikiOrganizePolling(): void {
    const runOnce = () => {
      const repo = this._wikiRepo
      const organizer = this._wikiOrganizer
      const queue = this._wikiOrganizeQueue
      if (!repo || !organizer || !queue) return
      const pairKey = (agentId: string, userId: string) => `${agentId}\0${userId}`
      const pairs = new Map<string, { agentId: string; userId: string }>()
      for (const p of repo.listPendingAgentUserPairs()) pairs.set(pairKey(p.agentId, p.userId), p)
      for (const p of repo.listUnfiledAgentUserPairs()) pairs.set(pairKey(p.agentId, p.userId), p)
      for (const { agentId, userId } of pairs.values()) {
        const autoClassify = repo.getAutoClassifyEnabled(agentId, userId)
        for (const itemType of WIKI_INBOX_ITEM_TYPES) {
          queue.enqueue(async () => {
            if (autoClassify) {
              await organizer.organizeBatch(agentId, userId, itemType)
            } else {
              await organizer.intakeBatch(agentId, userId, itemType)
            }
          })
        }
        if (autoClassify) {
          queue.enqueue(async () => {
            await organizer.organizeUnfiledSourceIds(agentId, userId)
          })
        }
      }
    }
    runOnce()
    this.wikiOrganizeTimer = setInterval(runOnce, 30_000)
    log.info('[startWikiOrganizePolling] Wiki 整理轮询已启动（30s 间隔）')
  }

  private getDefaultDbPath(): string {
    return path.join(resolveClientStateDir(), 'data', 'agent-runtime.db')
  }

  private ensureDirectory(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  /**
   * 启动 Idle Compaction 轮询（60s 间隔扫描所有实例）
   */
  private startIdleCompactionPolling(): void {
    this.idleCompactionTimer = setInterval(() => {
      this.scanIdleInstances()
    }, 60_000)
    log.info('[startIdleCompactionPolling] Idle Compaction 轮询已启动（60s 间隔）')
  }

  /** runtime_state 里 idle 压缩冷却时间戳的键前缀 */
  private static readonly IDLE_COOLDOWN_KEY_PREFIX = 'compact:idle_cooldown_until:'

  /**
   * idle 压缩的空闲阈值（秒）。
   * compact/types.ts 的 `idleCompactAfterSeconds` 是给 packages 层纯谓词用的入参，
   * 客户端侧尚无对应设置项，故此处为唯一口径；改成可配需要先补设置链路。
   */
  private static readonly IDLE_COMPACT_AFTER_SECONDS = 300

  /** runtime_state 里用户手动禁用工具集合的键 */
  private static readonly DISABLED_TOOLS_KEY = 'tools:user_disabled'

  /** runtime_state 里各模型标定的字符/token 比的键前缀 */
  private static readonly CHARS_PER_TOKEN_KEY_PREFIX = 'tokens:chars_per_token:'

  /** 读该会话的冷却截止时间戳（ms）；无记录返回 0 */
  private getIdleCooldownUntil(sessionKey: string): number {
    const raw = this._runtimeStateRepo?.get(
      AgentRuntimeBridge.IDLE_COOLDOWN_KEY_PREFIX + sessionKey,
    )
    const ts = raw ? Number(raw) : 0
    return Number.isFinite(ts) ? ts : 0
  }

  /**
   * 写该会话的冷却截止时间戳。落 DB 而非内存，重启后冷却仍生效
   * （否则重启会对所有历史会话立刻重试压缩）。
   */
  private setIdleCooldown(sessionKey: string, cooldownMs: number, reason: string): void {
    if (cooldownMs <= 0) return
    const until = Date.now() + cooldownMs
    this._runtimeStateRepo?.set(
      AgentRuntimeBridge.IDLE_COOLDOWN_KEY_PREFIX + sessionKey,
      String(until),
    )
    log.info(
      `[setIdleCooldown] 会话 ${sessionKey} 冷却 ${Math.round(cooldownMs / 60_000)}min（${reason}）`,
    )
  }

  /**
   * 扫描所有实例，对满足 idle 条件的会话发起压缩
   */
  private scanIdleInstances(): void {
    const now = Date.now()
    for (const [instanceId, state] of this.instanceStates.entries()) {
      const sessionKey = this.instanceToConversation.get(instanceId)
      if (!sessionKey) continue

      const usage = this.getSessionContextUsage(sessionKey)
      if (!usage) continue

      const idleSeconds = Math.floor((now - state.lastActivityAt) / 1000)

      // 压缩只动对话历史，触发判断也必须只看对话池：
      // 按整窗算时，固定开销（系统提示+工具+MCP）大的会话压完仍高于 floor，反复重试无收敛目标。
      const comp = this.sessionModelCatalog.getCompactionForRootSession(sessionKey)
      const budget = computeContextBudget(
        usage.usedTokens,
        usage.contextWindow,
        usage.breakdown,
        comp.outputReserveTokens,
      )

      const cooldownUntil = this.getIdleCooldownUntil(sessionKey)
      const cooldownActive = now < cooldownUntil
      const idleAfterSeconds = AgentRuntimeBridge.IDLE_COMPACT_AFTER_SECONDS
      const should =
        shouldCompactByBudget(budget, usage.triggerThreshold) &&
        shouldIdleCompact({
          enabled: idleAfterSeconds > 0,
          idleAfterSeconds,
          idleGapSeconds: idleSeconds,
          tokens: budget.compressible,
          floorTokens: Math.floor(budget.budget * usage.triggerThreshold),
          cooldownActive,
        })

      // 每轮都打决策，否则「自动压缩没生效」无从判断卡在哪个条件
      log.info(
        `[scanIdleInstances] ${instanceId} 决策=${should ? '压缩' : '跳过'} ` +
          `idle=${idleSeconds}s/${idleAfterSeconds}s used=${usage.usedTokens} 固定开销=${budget.fixedOverhead} ` +
          `可压缩=${budget.compressible}/${budget.budget}(×${usage.triggerThreshold}) ` +
          `${budget.exhausted ? '固定开销已挤满窗口(压缩无效,需禁用 MCP) ' : ''}` +
          `冷却=${cooldownActive ? new Date(cooldownUntil).toLocaleTimeString() : '无'}`,
      )

      if (should) {
        void this.tryIdleCompact(instanceId, sessionKey)
      }
    }
  }

  /**
   * 对单个实例发起 idle 压缩（带碰撞检测 + 收益冷却）
   */
  private async tryIdleCompact(instanceId: string, sessionKey: string): Promise<void> {
    const instance = this.agentRegistry.get(instanceId)
    if (!instance) return

    // 碰撞检测：正在运行或已在压缩中
    if (instance.state === 'running' || instance.state === 'aborted') {
      return
    }

    // 同会话去重：一个会话可能挂多个实例（主 + 子 Agent），只允许一个在压
    if (this.idleCompactingSessions.has(sessionKey)) {
      return
    }
    this.idleCompactingSessions.add(sessionKey)

    try {
      const r = await this.compactor.compactContextAsync(instanceId, sessionKey, 6)
      const reclaimed = r.conversationTokensBefore - r.conversationTokensAfter
      const reclaimRatio =
        r.conversationTokensBefore > 0 ? reclaimed / r.conversationTokensBefore : 0
      log.info(
        `[tryIdleCompact] 实例 ${instanceId} idle 压缩完成（移出 ${r.messagesRemoved} 条，` +
          `回收 ${reclaimed} tokens / ${(reclaimRatio * 100).toFixed(1)}%，摘要=${r.hadSummary}）`,
      )
      // 收益判断看 token 而非消息条数：移出很多条小消息可能仍不省 token，
      // 移出少数几条巨型工具结果反而收益巨大。失败优先于收益判定，
      // 否则事务 ROLLBACK（不抛异常、只返回 success=false）会被误判成「收益过低」冷却 30min。
      const { cooldownMs, reason } = decideIdleCooldownMs({
        success: r.success,
        tokensBefore: r.conversationTokensBefore,
        tokensAfter: r.conversationTokensAfter,
      })
      this.setIdleCooldown(sessionKey, cooldownMs, reason)
      // 压缩后重置活动时间，否则 idle 时间持续增长导致每 60s 反复压同一会话
      const now = Date.now()
      for (const [id, st] of this.instanceStates.entries()) {
        if (this.instanceToConversation.get(id) === sessionKey) {
          st.lastActivityAt = now
        }
      }
    } catch (err) {
      log.warn(`[tryIdleCompact] 实例 ${instanceId} idle 压缩失败: ${err instanceof Error ? err.message : String(err)}`)
      // 失败冷却 10min，避免网络抖动时每分钟重试烧 API
      this.setIdleCooldown(sessionKey, IDLE_COOLDOWN_FAILURE_MS, '压缩失败')
      const now = Date.now()
      for (const [id, st] of this.instanceStates.entries()) {
        if (this.instanceToConversation.get(id) === sessionKey) {
          st.lastActivityAt = now
        }
      }
    } finally {
      this.idleCompactingSessions.delete(sessionKey)
    }
  }
}
