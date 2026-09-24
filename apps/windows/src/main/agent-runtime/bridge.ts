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
  PalaceRepo,
  PalaceVectorIndex,
  MemoryManager,
  ConversationRepo,
  SegmentRepo,
  TaskRepo,
  AuditRepo,
  BashCommandRepo,
  createTemplateTool,
  RuntimeStateRepo,
  AutonomousRepo,
  FileRepo,
  clearInvalidSessionPreferredModels,
  patchSessionConfig,
  readSessionConfig,
  toggleSessionDisabled,  maybeRunAutoVacuumSync,
  runBackupNow,
  listDatabaseBackups,
  deleteDatabaseBackup,
  restoreDatabaseFromBackup,
  type DatabaseAdapter,
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
  EVOLUTION_CONVERSATION_ID,
  isEvolutionConversationId,
  buildGoalPrompt,
  getGoalToolAllowlist,
  getAutonomousToolsForAgent,
  finalizeGoal,
  // 宠物：定义与目标读取都来自 agent-runtime，宠物侧的派发循环（本目录 pet-dispatch.ts）只注入副作用
  buildPetDefinition,
  isPetAgentId,
  PET_AGENT_ID_PREFIX,
  type PetGoalSignal,
  canSendOutreach,
  recordOutreach,
  readMood,
  decayMood,
  applyMoodImpact,
  writeMood,
  moodToPetEmotion,
  DIARY_PROMPT,
  buildDiaryContext,
  readConcerns,
  pickConcernToRaise,
  writeConcerns,
  markConcernRaised,
  markDiaryWritten,
  hasInnerLife,
  listRecentDiaries,
  saveDiary,
  todayDateKey,
  readSettings,
  drawerPointerId,
} from '@mtbot/agent-runtime'
import type { ArchivePalaceMeta } from '@mtbot/agent-runtime'
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core'
import { buildContextUsageBreakdown, calibrateCharsPerToken, countPromptChars, aggregateMcpTokensByServer } from './context-usage-breakdown.js'
import type { ContextBudgetSnapshot, ContextUsageBreakdownEntry } from '../../shared/agent-runtime-events'
import { buildBudgetSnapshot, computeContextBudget, shouldCompactByBudget } from '../../shared/context-budget'

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
  WikiLibraryMigrate,
  type WikiMigrateProgress,
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
import { resolveAskUserDelivery } from '../channel/desktop-interaction-gate'
import { FileMemoryHandler } from './file-memory-handler'
import { SegmentMemoryService } from './segment-memory-service'
import { CronScheduler } from './cron-scheduler'
import { dispatchChannelTarget } from './channel-target-dispatch'
import { persistCronOutputToWiki } from './cron-wiki-persist'
import { persistLearningOutcome, recordProactiveAction } from './evolution-memory-persist'
import { purgeCronFocusNoiseMemories } from './cron-focus-memory'
import {
  isLocalCompanionInstruction,
  handleLocalCompanionInstruction,
  ensureCompanionCronJobsSeeded,
  syncCompanionTickJobEnabled,
  migrateLocalCompanionPrefsToVhSettings,
} from './local-companion-handler'
import { ensureSeedCronJobsSeeded } from '../seed-cron-jobs'
import { isPetMode, onVirtualHumanSettingsChanged } from '../pet/pet-mode-ipc'
import { getStoredModelId, getVirtualHumanSettings } from '../pet/pet-mode-store'
import { petAgentId } from '@mtbot/pet-core'
import { BridgeSessionModelCatalog } from './bridge-session-model-catalog'
import { BridgeSessionThinkingPrefs } from './bridge-session-thinking-prefs'
import { loadStoredThinkingPrefs, saveStoredThinkingPrefs } from './session-thinking-store'
import { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import { initToolUsageStore } from '../tool-usage-store'
import { setDashboardFeedDb } from '../dashboard-feed-store'
import { setMaintenanceReportDb } from '../maintenance-report-store'
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
import {
  initAutonomousRuntime,
  shutdownAutonomousRuntime,
  readAutonomousEnabled,
  reflectAutonomous,
  setAutonomousNotifier,
  notifyNewPendingGoals,
} from './autonomous-wiring'
import { handleEvolutionTick } from './evolution-tick'
import { ensurePetDispatchCronJobSeeded, runPetDispatch, syncPetDispatchJobEnabled } from './pet-dispatch'
import { ensurePetSensingCronJobSeeded, runPetSensing } from './pet-sensing-tick'
import { ensurePetEvolveCronJobSeeded, runPetEvolve, syncPetEvolveJobEnabled } from './pet-evolve'
import { recordPetPersonalityEvent } from './pet-personality'
import { persistPetTaskReceipt, readPetTaskDimension, recordPetTaskOutcome } from './pet-task-store'
import { syncAutonomousManagedCronJobs } from './autonomous-cron-linkage'
import { runPlanner, shouldFallbackPlan } from './planner-wiring'
import { OUTREACH_SYSTEM_NOTIFY_TITLE } from '../desktop-notify'
import { BridgeInstanceFactory } from './bridge-instance-factory'
import { BridgeToolRegistrar } from './bridge-tool-registrar'
import { BridgePromptDispatcher } from './bridge-prompt-dispatcher'
import { RouterService } from './router/router-service'
import { RouterLlmCallerImpl } from './router/llm-caller'
import { RouterHitRateTracker } from './router/router-hit-rate-tracker'
import type { AgentRuntimeBridgeConfig } from './bridge-types'
import { withBuiltinPalace } from './palace-backend'
import { setupPalaceVector, backfillPalaceVectors } from './palace-vector-runtime'
import { waitForSherpa } from '../onnx-runtime-gate'
import { createTransformersE5Embedder } from './wiki-transformers-embedder'
import { getCloudSyncManager } from '../cloud-sync/sync-accessor'
import type { ConflictInfo } from '../cloud-sync/types'
import { ensureProviderBaseUrl } from '../provider-config'
import { resolveModelThinking, apiForProviderType } from '../model-thinking'

/** 单机客户端固定 userId，与 wiki-commands 一致 */
const LOCAL_USER_ID = 'local-user'

/**
 * 将 Wiki ERO 抽取结果格式化为 cron 运行摘要。
 */
function formatWikiEroExtractSummary(result: WikiEroExtractSourceResult): string {
  const errPart = result.errors.length > 0 ? ` errors:${result.errors.length}` : ''
  return `scanned:${result.sourcesScanned} skipped:${result.sourcesSkipped} failed:${result.sourcesFailed} entities:${result.entitiesUpserted} relations:${result.relationsUpserted} obs:${result.observationsAdded}${errPart}`
}

/** 给 Promise 加超时兜底；超时仅 reject 竞速结果，不取消原 Promise（调用方负责 destroy 实例等清理） */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 云同步冲突处理单轮执行超时：实例被用户中止（cascade abort）时 prompt/waitForIdle 可能不 settle，需兜底释放互斥 */
const SYNC_CONFLICT_EXEC_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 宠物目标单轮执行超时（T3.3 派发循环）。
 *
 * 比同步冲突那 10 分钟短得多：宠物做的是"看一眼"级别的小事（`PET_MAX_TURNS = 20`），
 * 而用户就坐在桌面前等着看它说话——挂了五分钟的"还在跑"，体验上已经等于没做成。
 *
 * 与 `SYNC_CONFLICT_EXEC_TIMEOUT_MS` 同一条理由：不 settle 则 `finally` 不执行，
 * 实例（连同它的单飞锁）永久留在注册表里，之后每一拍都是 `skipped: busy`。
 */
const PET_GOAL_EXEC_TIMEOUT_MS = 5 * 60 * 1000

export type { AgentRuntimeBridgeConfig }

export class AgentRuntimeBridge {
  private readonly agentRegistry = new AgentRegistry()
  private readonly toolRegistry = new ToolRegistry()
  private readonly modelRouter = new ModelRouter()
  private readonly localDb = new LocalDatabase()

  /**
   * 注入前的原文指针存在性校验器（惰性）。
   *
   * 做成"给 `MemoryManager` 的谓词"而不是在 bridge 里就地剥，是因为剥了指针还要
   * 重算 token 预算与去重（都在注入选取里做）——分两步会得到两套口径。
   * 库没打开时返回 null，让调用方走无校验路径（总比不注入好）。
   */
  private palaceDrawerChecker(): ((id: string) => boolean) | null {
    if (!this.localDb.isOpen) return null
    try {
      const repo = new PalaceRepo(this.localDb.db)
      return (id: string) => repo.existsByIds([id]).size > 0
    } catch (err) {
      log.warn('[Palace] 注入前指针校验不可用，指针将按原样注入:', err)
      return null
    }
  }
  /** Per-instance 聚合状态 */
  private readonly instanceStates = new InstanceStateStore()
  /** 当前打开的 SQLite 主文件路径（initialize 后可用） */
  private resolvedDbPath: string | null = null
  private config: AgentRuntimeBridgeConfig
  private featureFlags: AgentRuntimeFeatureFlags
  private initialized = false
  get isInitialized(): boolean { return this.initialized }
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
  private _wikiLibraryMigrate: WikiLibraryMigrate | null = null
  private _wikiCleanupScanner: WikiCleanupScanner | null = null
  private _conversationRepo: ConversationRepo | null = null
  /**
   * 段落（工作记忆）仓库。
   *
   * 单独持有是为了会话删除时能级联清理：`messages` 有 `ON DELETE CASCADE`，而
   * `memory_segments` 建表早于该约束、加不上外键，只能由删除路径显式清
   * （2026-09-23 查出：SegmentRepo.deleteByConversation 写好了却无人调用，
   * 库里攒了约百行指向已删会话的孤儿段）。
   */
  private _segmentRepo: SegmentRepo | null = null
  private _taskRepo: TaskRepo | null = null
  private _auditRepo: AuditRepo | null = null
  /** bash 命令采集仓库（工具进化 M1：模式挖掘数据源） */
  private _bashCommandRepo: BashCommandRepo | null = null
  private _runtimeStateRepo: RuntimeStateRepo | null = null
  private _autonomousRepo: AutonomousRepo | null = null
  private toolContext: ToolExecutionContext | null = null
  private cronScheduler!: CronScheduler
  private definitionStore: AgentDefinitionStore | null = null

  /** 当前正在执行工具的实例 ID（Ref 盒子，与 BridgeInstanceFactory 共享） */
  private readonly currentToolExecutorInstanceIdRef: { value: string | undefined } = { value: undefined }
  /** toolCallId → instanceId 映射 */
  private readonly toolCallInstanceMap = new Map<string, string>()

  private readonly messageBus = new MessageBus()
  private readonly sessionModelCatalog = new BridgeSessionModelCatalog()
  private readonly sessionThinkingPrefs = new BridgeSessionThinkingPrefs(loadStoredThinkingPrefs())
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
    // 渠道偏好按会话归属加载（10-S2）：前缀只说明会话从哪来，落库值才是权威
    getConversationOwnership: (conversationId) => this.getConversationOwnership(conversationId),
    instanceStates: this.instanceStates,
    consumeConcernToRaise: (conversationId) => {
      if (!this.localDb || isEvolutionConversationId(conversationId)) return null
      // 2026-09-24 牵挂按 agent 分键后，这里读**助手**的：能走到这一行的会话都在上面那道
      // 守卫之外（非 `evolution:` 前缀），而那些会话里会「提起牵挂」的主体就是助手；
      // 宠物的出口是气泡、不走这条注入（它的会话是 `evolution:pet:*`，已被守卫挡掉）。
      // 精确到"这个会话的参与者是谁"要再挂一条解析链（composer 只拿得到 sessionKey），
      // 而牵挂目前的生产者只有反思（只服务 assistant 与系统 Agent），不值这一步。
      const concerns = readConcerns(this.localDb.db, 'assistant')
      const concern = pickConcernToRaise(concerns, Date.now())
      if (!concern) return null
      writeConcerns(this.localDb.db, 'assistant', markConcernRaised(concerns, concern.id, Date.now()))
      return concern.description
    },
    // 工作记忆注入（构建期填充占位符）：按实例 definitionId 注入对应 Agent 的 agent_memories
    // （2026-09-13 共享层修正：此前硬编码 'assistant'，专家自己积累的记忆注不进模型）
    // （2026-09-15 作用域修正：definition 声明 memory.scope === "user" 的 Agent —— assistant/
    //  code-dev/system-keeper/chronicler/info-curator —— 按用户级跨 Agent 读取；此前该声明
    //  从未被实现，导致 chronicler 这类汇总 Agent 只读到自己的空库，日报永远「工作记忆为空」）
    fillWorkMemoryPlaceholder: (prompt, query, instanceId) => {
      const mgr = this._memoryManager
      if (!mgr) return null
      const inst = this.agentRegistry.get(instanceId)
      const agentId = inst?.definitionId ?? 'assistant'
      const scope = inst?.memoryReadScope ?? 'agent'
      // 原文指针的存在性校验：`palace_drawer_id` 是可能过期的快照（段被删、宫殿重建），
      // 实测 96 条带 id 的记忆里 1 条是死链，且还是 Python 时代 `drawer_chronicler_...`
      // 的旧格式。给了指针而点开报错，比不给指针更糟——模型会开始怀疑整块记忆。
      // 校验放在这里而不是 `formatUnifiedMemoryBlock`：后者是纯格式化、不持 DB。
      const live = this.palaceDrawerChecker()
      // 钉入用的会话键沿用桥里既有的「实例 → 根会话」约定（与 abortSession /
      // invalidateInstance 同源）。工具执行期用同一个实例 id 反查得到同一串，
      // 而它正是 `PalaceRepo` 归档时写进 room 的那个坐标。
      const pinKey = this.instanceToRootSessionKey.get(instanceId) ?? instanceId
      const { updatedPrompt, injected } = mgr.injectIntoSystemPrompt(
        prompt,
        agentId,
        LOCAL_USER_ID,
        undefined,
        query,
        scope,
        // null（库未打开）→ undefined，走"无校验"路径：总比不注入好
        live ?? undefined,
      )
      // 回填本轮注入集：注入发生在这里（构建期），而消费者在 AgentInstance 里——
      // UI 的「本轮注入了什么」与效用观测都读它。不回填则两处静默失效
      //（2026-09-17 实测：注入在发生，但 memory_usage_feedback 恒 0 行）。
      inst?.setInjectedMemories(injected)
      // 注入指针按会话留档，供本轮 memory_search 钉入
      this.injectedDrawerIds.set(pinKey, this.collectDrawerPointerIds(injected))
      return { prompt: updatedPrompt, injected: injected.length }
    },
  })

  /**
   * 本轮注入块里给过指针的抽屉 id（供 memory_search 钉入检索）。
   *
   * 幂等去重：同一条原文可能被两条记忆指向（合并的产物），钉一次就够。
   */
  private collectDrawerPointerIds(injected: readonly { content: string }[]): string[] {
    const ids = new Set<string>()
    for (const e of injected) {
      const id = drawerPointerId(e.content)
      if (id) ids.add(id)
    }
    return [...ids]
  }

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
  /**
   * sessionKey → 本轮注入块里给过指针的抽屉 id。
   *
   * 在 `fillWorkMemoryPlaceholder`（构建期）写、在 `memory_search`（工具执行期）读，
   * 两者是同一轮的上下游。会话数有界（内存会话 + 少量 cron），不需要淘汰。
   */
  private readonly injectedDrawerIds = new Map<string, string[]>()
  /**
   * 宫殿向量索引（语义改写检索立项 T3）。
   *
   * 默认 null = 向量通道关闭。由 `setupPalaceVector` 在 `finalizeInitialize` 装配
   * （那时 DB 已打开）。**只有 `LUMII_PALACE_VECTOR=1` 时才加载模型**——默认不加载，
   * 没开就不付任何代价（模型 912ms + 索引 993 条 ≈ 32 秒）。
   *
   * **2026-09-20 定案：暂不引入**（测试用例不足，无法证明其真正效果）——
   * 故 `null` 是**既定状态**，不是"等着被装配"。见 palace-vector-runtime.ts 头部。
   */
  private _palaceVectorIndex: PalaceVectorIndex | null = null

  /** 主 Agent 实例的 innerStream / model（仅 def.id === 'main' 时设置） */
  private readonly mainInnerStreamRef: { value: ReturnType<typeof createDirectStreamFn> | null } = { value: null }
  private readonly mainModelRef: { value: import('@earendil-works/pi-ai/compat').Model<any> | null } = { value: null }
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
    // 记忆宫殿：注入自建 SQLite 实现（PalaceRepo）。必须在这里接线——LocalDatabase
    // 由本类持有，index.ts 的回调闭包拿不到 DB 句柄（见 palace-backend.ts 的说明）。
    // 向量索引走 getter：它需要 DB 句柄，而 DB 到 initialize 才打开（见该字段注释）。
    this.config = withBuiltinPalace(config, this.localDb, () => this._palaceVectorIndex)
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
      // 绑方法而非手写透传：少写一个参数时 TS 不报错（参数少的函数可赋给参数多的
      // 类型），调用方传的 opts 会被静默吞掉。下面两处 deps 同理。
      getSessionContextUsage: this.getSessionContextUsage.bind(this),
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
        this._autonomousRepo = null
        void shutdownAutonomousRuntime()
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
  get segmentRepo(): SegmentRepo { return this.requireInitialized(this._segmentRepo, 'segmentRepo') }
  get taskRepo(): TaskRepo { return this.requireInitialized(this._taskRepo, 'taskRepo') }
  get auditRepo(): AuditRepo { return this.requireInitialized(this._auditRepo, 'auditRepo') }
  get runtimeStateRepo(): RuntimeStateRepo { return this.requireInitialized(this._runtimeStateRepo, 'runtimeStateRepo') }
  get autonomousRepo(): AutonomousRepo { return this.requireInitialized(this._autonomousRepo, 'autonomousRepo') }
  /** 底层 DatabaseAdapter（settings / mood / 牵挂等 KV 读写用） */
  get db(): DatabaseAdapter { return this.localDb.db }
  get wikiRepo(): WikiRepo { return this.requireInitialized(this._wikiRepo, 'wikiRepo') }
  get wikiOrganizer(): WikiOrganizer { return this.requireInitialized(this._wikiOrganizer, 'wikiOrganizer') }
  get wikiIngestHook(): WikiIngestHook { return this.requireInitialized(this._wikiIngestHook, 'wikiIngestHook') }
  /** 重新编目器；LLM purpose 与归档分类同一档，保证小模型预算一致 */
  get wikiReclassifier(): WikiReclassifier { return this.requireInitialized(this._wikiReclassifier, 'wikiReclassifier') }
  /**
   * 库级迁移状态机（惰性创建）：folder import 默认 plan→review，apply 才归档。
   * onProgress 广播 wiki:migrate:progress 供 Task 7 UI 订阅。
   */
  get wikiLibraryMigrate(): WikiLibraryMigrate {
    if (!this._wikiLibraryMigrate) {
      this._wikiLibraryMigrate = new WikiLibraryMigrate(
        this.wikiRepo,
        (prompt: string) => this.callLLM(prompt, undefined, 'memory_extract'),
        undefined,
        (progress) => this.broadcastWikiMigrateProgress(progress),
        {
          onSourceCreated: (source) => {
            try {
              const latest = this._wikiRepo!.findSourceById(source.id) ?? source
              syncWikiSourceToVault(this._wikiRepo!, latest)
            } catch (err) {
              log.warn('[wiki-vault] migrate apply sync failed:', err)
            }
          },
        },
      )
    }
    return this._wikiLibraryMigrate
  }
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

  /**
   * 向渲染进程广播库级迁移进度（通道 wiki:migrate:progress，Task 7 UI 订阅）。
   */
  private broadcastWikiMigrateProgress(progress: WikiMigrateProgress): void {
    const win = this.config.getWindow()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (wc.isDestroyed()) return
    try {
      wc.send('wiki:migrate:progress', progress)
    } catch (err) {
      log.warn('[wiki-migrate] progress broadcast failed:', (err as Error).message)
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

  /** bash 命令工具进化引擎（index.ts 装配） */
  private _toolEvolutionEngine: import('./bash-tool-evolution/tool-evolution-engine').ToolEvolutionEngine | null = null

  setToolEvolutionEngine(engine: import('./bash-tool-evolution/tool-evolution-engine').ToolEvolutionEngine): void {
    this._toolEvolutionEngine = engine
  }

  getToolEvolutionEngine(): import('./bash-tool-evolution/tool-evolution-engine').ToolEvolutionEngine | null {
    return this._toolEvolutionEngine
  }

  /** 工具列表变化后使所有实例失效（工具进化注册 / MCP 变更共用） */
  refreshAllInstanceTools(): void {
    this.refreshAllInstanceToolsInternal()
  }

  /** 注册进化工具：绑定 toolContext 后入 registry，并使现有实例失效（下一轮生效） */
  registerEvolvedTool(def: import('@mtbot/agent-runtime').TemplateToolDefinition): void {
    const ctx = this.toolContext
    if (!ctx) throw new Error('toolContext 未初始化')
    this.toolRegistry.register(createMtBotTool(createTemplateTool(def), ctx))
    this.refreshAllInstanceTools()
  }

  /** 注销进化工具（禁用/删除），并使现有实例失效 */
  unregisterEvolvedTool(name: string): void {
    this.toolRegistry.unregister(name)
    this.refreshAllInstanceTools()
  }

  /** 已注册工具名快照（重名检查） */
  getRegisteredToolNames(): string[] {
    return this.toolRegistry.getAll().map((t) => t.name)
  }

  /** bash 命令采集仓库（工具进化） */
  get bashCommandRepo(): BashCommandRepo | null {
    return this._bashCommandRepo
  }

  /** 最近活跃会话 id（工具进化审批消息落库目标） */
  getLastActiveConversationId(): string | null {
    return this.lastActiveConvIdRef.value
  }

  callLLM(prompt: string, instanceId?: string, purpose?: string): Promise<string> {
    return this.compactor.callLLM(prompt, instanceId, purpose)
  }

  /**
   * 划词单轮调用（渲染层 L2 动作）要用的 stream + model。
   *
   * 与 callLLM 共用同一套四级降级（见 compactor.resolveCallStream），但**不走
   * callLLM** —— 那条路会把完整 prompt 与输出写进日志文件，划词走它等于把用户
   * 选中的正文落盘。
   */
  resolveSelectionChatStream():
    | { streamFn: StreamFn; model: import('@earendil-works/pi-ai/compat').Model<any> }
    | undefined {
    const resolved = this.compactor.resolveCallStream()
    return resolved ? { streamFn: resolved.innerStream, model: resolved.model } : undefined
  }

  /**
   * 无 Agent 实例时为 callLLM 构造独立 direct stream + chat 模型。
   * 读取最新 chat 槽配置；未启用或缺少 modelId 时返回 undefined（由 callLLM 抛明确错误）。
   */
  private getCallLlmFallbackStream():
    | { innerStream: ReturnType<typeof createDirectStreamFn>; model: import('@earendil-works/pi-ai/compat').Model<any> }
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
      log.warn(`[callLLM fallback] 缺少 API Key，无法创建兜底 stream${cfg.apiKeyDecryptFailed ? '（凭据存在但解密失败）' : ''}`)
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
            // 与主对话路径保持一致：缺省 responses（旧代码漏传，导致同一槽位在不同
            // 调用路径落到不同 API 格式）
            apiFormat: live.apiFormat ?? 'responses',
          },
          resolveModelProfile: (modelId) => resolveModelThinking(live, modelId),
          log: (msg) => log.info(`[callLlmFallback] ${msg}`),
        })
        return direct(model, context, options)
      }) as ReturnType<typeof createDirectStreamFn>
    }

    const model = this.modelRouter.resolveExplicitModelId(modelId, apiForProviderType(cfg.type))
    return { innerStream: this.callLlmFallbackStream, model }
  }

  /** 初始化（打开数据库 + 注册内建工具） */
  async initialize(): Promise<void> {
    if (this.initialized) return

    await this.initializeDatabaseAndRepos()
    this.reconcileStoredSessionModelPreferences()
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

    // 资讯存储注入：dashboard-feed-store 从文件覆盖写切换为 SQLite 累积（schema V35）
    setDashboardFeedDb(db)

    // 维护体检报告存储注入（schema V42）：概览页「资产体检」卡片与 maintenance_report_* 工具读它
    setMaintenanceReportDb(db)

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

    // 宫殿索引同理：一次性回填脚本（scripts/palace-backfill.mjs）只写主表，分词在 JS 侧，
    // 脚本里没有分词器——靠这里的重建把回填进来的原文补进 FTS。与上面 agent_memories_fts
    // 的处理同一条路径（迁移/回填后「有数据但索引为空」是同一类故障）。
    try {
      const palaceRepo = new PalaceRepo(db)
      const palaceHealth = palaceRepo.checkFtsHealth()
      if (!palaceHealth.isHealthy) {
        log.info(`[initialize] 宫殿 FTS 索引不健康: ${palaceHealth.reason}，自动重建...`)
        const n = palaceRepo.rebuildIndex()
        log.info(`[initialize] 宫殿 FTS 索引重建完成，${n} 行`)
      }
    } catch (err) {
      log.warn('[initialize] 宫殿 FTS 索引健康检查/重建失败，宫殿检索将降级到 LIKE:', err)
    }

    this._conversationRepo = new ConversationRepo(db)
    const segmentRepo = new SegmentRepo(db)
    this._segmentRepo = segmentRepo
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
    this._bashCommandRepo = new BashCommandRepo(db)
    this._runtimeStateRepo = new RuntimeStateRepo(db)
    this._autonomousRepo = new AutonomousRepo(db)
    // 自主进化引擎接线：装配失败已在内部降级，不影响运行时启动。
    // 反思引擎复用桥接的独立 LLM 管道（同记忆提取/整理），无实例时走 callLLM 兜底 stream。
    setAutonomousNotifier((title, body, convId) =>
      this.config.showCronNotification?.(title, body, convId),
    )
    initAutonomousRuntime(db, (prompt) => this.callLLM(prompt, undefined, 'reflection'))
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
      // 宫殿互引（诉求 A · P2）：段原文归档进记忆宫殿，drawer_id 由内容寻址确定性生成。
      // runtime 只认接口，实现由宿主注入（自建 SQLite，见 palace-backend.ts）。
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
      // 与文件工具一致：项目目录里新建的文件同样登记，避免「写进去了但列表里没有」
      getAllowedRoots: () => this.config.getAllowedRoots?.() ?? [],
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

  /**
   * 解析 Agent 传入的文件路径：workspace 根 + 宿主注册的项目目录（`getAllowedRoots`）。
   * pi 内核路径统一走这里；ACP 路径（灵栖开发的 CLI 子进程）不经过。
   */
  private resolveAgentPath(filePath: string): string {
    return resolveAgentFilePath(filePath, this.config.getCwd(), this.config.getAllowedRoots?.())
  }

  /** initialize() 子块 2/7：构造 toolContext、注册内建工具、构造并调用 BridgeToolRegistrar。必须晚于 initializeDatabaseAndRepos（依赖 Repos 已创建） */
  private initializeToolContextAndRegistry(): void {
    const toolContext: ToolExecutionContext = {
      executeCommand: executeLocalCommand,
      readFile: (filePath, opts) =>
        readLocalFile(this.resolveAgentPath(filePath), opts),
      writeFile: (filePath, content) =>
        writeLocalFile(this.resolveAgentPath(filePath), content),
      glob: (pattern, opts) => {
        const cwd = this.config.getCwd();
        const resolvedCwd = opts?.cwd
          ? this.resolveAgentPath(opts.cwd)
          : cwd;
        return globLocal(pattern, { ...opts, cwd: resolvedCwd });
      },
      grep: (pattern, opts) => {
        const cwd = this.config.getCwd();
        const resolvedPath = opts?.path
          ? this.resolveAgentPath(opts.path)
          : cwd;
        return grepLocal(pattern, { ...opts, path: resolvedPath });
      },
      fetch: fetchLocal,
      getCwd: () => this.config.getCwd(),
      // 本机注册的项目目录（codingDevProjects）纳入文件工具允许范围，
      // 使主助手 / pi 兜底 Agent 无需绕道 bash 即可读改项目文件。
      // 注意：灵栖开发的 ACP 路径走 CLI 子进程（见 coding-dev-local-runner），不经过此处。
      getAllowedRoots: () => this.config.getAllowedRoots?.() ?? [],
      askUserQuestion: async (input) => {
        const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000
        const instanceId =
          input.instanceId ?? this.currentToolExecutorInstanceIdRef.value
        const sessionKey = instanceId
          ? (this.instanceToRootSessionKey.get(instanceId) ??
            this.instanceToConversation.get(instanceId))
          : undefined
        // 优先文字化推给渠道；渠道已承接则不再向客户端弹 AskUserModal（maskClosable=false）
        let channelHandled = false
        if (sessionKey) {
          channelHandled = this.notifyChannelInteraction({
            kind: 'ask',
            requestId: input.requestId,
            sessionKey,
            context: input.context,
            questions: input.questions,
          })
          if (!channelHandled) {
            log.warn(
              `[askUserQuestion] 渠道未承接提问 sessionKey=${sessionKey} requestId=${input.requestId}`,
            )
          }
        } else {
          log.warn(
            `[askUserQuestion] 无法解析 sessionKey，跳过渠道提问推送 requestId=${input.requestId} instanceId=${instanceId ?? 'none'}`,
          )
        }
        if (resolveAskUserDelivery(channelHandled) === 'desktop') {
          this.ipcChannel.forwardIpcEvent({
            type: 'agent:ask-user:request',
            requestId: input.requestId,
            instanceId,
            rootSessionKey: sessionKey,
            context: input.context,
            questions: input.questions,
            timeoutMs,
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
      // 段落管线统计：供记忆体检回答「记忆产出是否停滞」——停摆无报错、无崩溃，
      // 只表现为「记忆不再增长」，只有计数能暴露（P1-3）
      getSegmentStats: () => this._segmentMemoryService?.getStats() ?? null,
      // 宫殿归档统计：失败只有 WARN、没有消费者，表现是「宫殿检索永远返回空」（P2-3）
      getPalaceStats: () => this._segmentMemoryService?.getPalaceStats() ?? null,
      getFeatureFlags: () => this.featureFlags,
      agentRegistry: this.agentRegistry,
      ipcChannel: this.ipcChannel,
      instanceStates: this.instanceStates,
      instanceToConversation: this.instanceToConversation,
      getCurrentToolExecutorInstanceId: () => this.currentToolExecutorInstanceIdRef.value,
      getDefinitionIdByInstanceId: (instanceId) => this.agentRegistry.get(instanceId)?.definitionId,
      getMemoryReadScopeByInstanceId: (instanceId) =>
        this.agentRegistry.get(instanceId)?.memoryReadScope ?? 'agent',
      // 本轮注入的原文指针：memory_search 用它们把注入里在讲的原文钉进检索结果。
      // 键与写入侧同一个字典（instanceToRootSessionKey），工具期先由
      // `toolCallInstanceMap` 拿到实例 id，再换成同一个会话键。
      // 拷一份再给：消费方在别的调用栈上，直接给内部数组会让它读到下一轮已改写的状态。
      getPinnedDrawerIdsByInstanceId: (instanceId) => {
        const sessionKey = this.instanceToRootSessionKey.get(instanceId)
        if (!sessionKey) return []
        return [...(this.injectedDrawerIds.get(sessionKey) ?? [])]
      },
      toolCallInstanceMap: this.toolCallInstanceMap,
      getDefinitionStore: () => this.definitionStore,
      ensureOrchestrator: () => this.lifecycle.ensureOrchestrator(),
      weixinCtx: {
        getCurrent: () => this.promptDispatcher.getCurrentWeixinCtxRaw(),
        markSentViaTool: () => { this.promptDispatcher.markWeixinMessageSentViaTool() },
      },
      getChannelRouter: () => this.config.getChannelRouter?.() ?? null,
      compactSession: (sessionKey, keepRecentTurns) => this.compactSessionForTool(sessionKey, keepRecentTurns),
      generateImage: (params) => this.generateImage(params),
      // 转交自动执行（2026-09-15）：提案后直接发起，不再等用户点确认卡片。
      // 动态 import 避免 bridge ↔ ipc 层的静态依赖（与下方 dev-context 的注入同一处理）。
      autoRunHandoff: (params) =>
        import('../ipc/agent-runtime/dev-handoff-executor').then(({ runHandoffFromProposal }) =>
          runHandoffFromProposal({ bridge: this, ...params }),
        ),
    })
    this.toolRegistrar.registerAll()
  }

  /**
   * 跑一次主动规划（反思后 / 心跳兜底触发）。返回是否真的产出了计划。
   *
   * `agentId` **必须显式传**（2026-09-24 主体迁移）：规划是"某个主体的计划"——
   * 此前这条链路从提示词到落库全程写死 `'assistant'`，宠物接进来时根本无从下手
   * （见实施计划第六期 T6.4）。
   */
  private async runPlannerNow(agentId: string): Promise<boolean> {
    try {
      const plan = await runPlanner(
        {
          db: this.localDb.db,
          callLLM: (prompt) => this.callLLM(prompt, undefined, 'planning'),
          scheduleCron: (job) => this.cronScheduler?.scheduleJob(job),
          countAgentSelfCronJobs: () => this.countAgentSelfCronJobs(),
        },
        agentId,
      )
      // planner 目标可能已落库为 pending；做待审批增量提醒
      if (plan !== null) {
        notifyNewPendingGoals()
        // 兜底：手动 replan 在开关关闭时也会落地 enabled=1 的自建任务，同步一次立刻挂起
        syncAutonomousManagedCronJobs(this.localDb.db, readAutonomousEnabled(this.localDb.db))
      }
      return plan !== null
    } catch (err) {
      log.warn('[planner] 主动规划失败:', err instanceof Error ? err.message : err)
      return false
    }
  }

  /** 供「规划任务」tab 手动触发**某个主体**重新规划（无兜底条件约束，直接跑）。 */
  async triggerReplan(agentId: string): Promise<boolean> {
    return this.runPlannerNow(agentId)
  }

  /** 云同步冲突目标执行的 in-flight 守卫（进程内互斥，防重复驱动） */
  private _syncConflictInFlight = false

  /**
   * 供云同步冲突处理调用（心跳 tick / SyncScheduler / 手动重试按钮 同路径）。
   *
   * 查找或创建 executing 的 system-maintenance 冲突目标，
   * 用受限实例 + 冲突工具（cloud_sync_read_file / resolve_sync_conflict）驱动 Agent 解决。
   *
   * 返回 null 表示当前无冲突或已在执行中；非 null 为执行结果摘要。
   */
  async executeSyncConflictGoal(): Promise<string | null> {
    if (this._syncConflictInFlight) return 'already-running'
    const m = getCloudSyncManager()
    if (!m) return null

    // 上一轮落决仍在后台队列里跑（resolveConflict 的超时只让调用方提前返回，任务不可取消）。
    // 此时再驱动一轮只会重复读文件 + 重复决策 + 再排一个落决：
    // 心跳每 10 分钟驱动一次、落决超时 5 分钟 —— 数学上必然重入，2026-09-17 的死循环即由此而来。
    if (m.isResolveInFlight()) {
      log.info('[executeSyncConflictGoal] 上一轮落决仍在后台执行，跳过本轮驱动')
      return 'skipped: resolve-in-flight'
    }

    const conflict = m.getConflict()
    if (!conflict) {
      // 无冲突但存在残留 goal → 标记完成
      this._cleanupStaleConflictGoal()
      return null
    }

    const db = this.localDb.db
    // 查当前 executing 的 system-maintenance 目标
    let goal: { id: string; type: string; description: string } | undefined | null = db
      .prepare<{ id: string; type: string; description: string }>(
        `SELECT id, type, description FROM autonomous_goals
         WHERE agent_id = 'assistant' AND type = 'system-maintenance' AND status = 'executing'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get()

    if (!goal) {
      // 创建新的冲突处理目标
      goal = this._createConflictGoal(conflict, db)
      if (!goal) return null
    }

    // 标记 Agent 开始处理
    m.markConflictProcessing()

    this._syncConflictInFlight = true
    try {
      const convId = EVOLUTION_CONVERSATION_ID
      this.ensureConversationExists(convId, '自主进化 · 内心独白')
      const baseDef = this.definitionStore ? await this.definitionStore.get('assistant') : null
      if (!baseDef) {
        finalizeGoal(db, goal.id, { success: false, output: 'assistant 定义缺失，无法执行' })
        // 保留 executing 供后续重试
        db.prepare(`UPDATE autonomous_goals SET status = 'executing' WHERE id = ?`).run(goal.id)
        return 'unavailable'
      }

      const restrictedDef: AgentDefinition = {
        ...baseDef,
        canSpawnSubAgents: false,
        tools: getGoalToolAllowlist(goal.type),
      }
      const instanceId = await this.createInstance(restrictedDef, convId, convId)
      try {
        // 用户可在界面中止该回合（cascade abort）——中止后 prompt/waitForIdle 未必 settle，
        // 若无超时则 finally 不执行、_syncConflictInFlight 永久为 true，之后 tick 恒被跳过（already-running）
        await withTimeout(
          (async () => {
            await this.prompt(instanceId, buildGoalPrompt(goal, false))
            await this.waitForInstanceIdle(instanceId)
          })(),
          SYNC_CONFLICT_EXEC_TIMEOUT_MS,
          '冲突处理执行超时（10 分钟），已放弃本轮（目标保留待重试）',
        )
        const output = this.getAssistantOutputFromInstance(instanceId) ?? ''
        const ok = output.trim().length > 0

        // 持久化独白
        if (ok) {
          this._conversationRepo?.saveMessage({
            conversationId: convId,
            agentId: 'assistant',
            role: 'user',
            contentJson: { type: 'text', text: `完成目标：${goal.description}` },
          })
          this._conversationRepo?.saveMessage({
            conversationId: convId,
            agentId: 'assistant',
            role: 'assistant',
            contentJson: { type: 'text', text: output },
          })
        }

        // 判断冲突是否已解决
        const resolved = m.getStatus().state !== 'conflict'
        if (resolved) {
          finalizeGoal(db, goal.id, { success: true, output: output || '冲突已解决' })
          return `resolved: ${output.slice(0, 80)}`
        }

        // 未解决 → 保留 executing 待下轮重试
        db.prepare(`UPDATE autonomous_goals SET status = 'executing' WHERE id = ?`).run(goal.id)
        const reason = output.trim() || 'Agent 未产出有效处理结果'
        m.recordConflictResolutionFailure(reason)
        log.warn(`[executeSyncConflictGoal] 未解决: ${reason.slice(0, 120)} goalId=${goal.id}`)
        return `retry: ${reason.slice(0, 80)}`
      } finally {
        this.destroy(instanceId)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('[executeSyncConflictGoal] 执行异常:', msg)
      // 保持 executing 待重试
      if (goal) {
        db.prepare(`UPDATE autonomous_goals SET status = 'executing' WHERE id = ?`).run(goal.id)
      }
      m.recordConflictResolutionFailure(msg)
      return `error: ${msg}`
    } finally {
      this._syncConflictInFlight = false
    }
  }

  /** 创建冲突处理目标 */
  private _createConflictGoal(
    conflict: ConflictInfo,
    db: DatabaseAdapter,
  ): { id: string; type: string; description: string } | null {
    try {
      const goalId = `goal-sync-conflict-${Date.now()}`
      const now = new Date().toISOString()
      const description = `解决云同步冲突：${conflict.files.length} 个文件冲突（${conflict.files.slice(0, 3).join(', ')}${conflict.files.length > 3 ? '...' : ''}）`
      db
        .prepare(
          `INSERT INTO autonomous_goals (id, agent_id, type, description, trigger_reason, status, priority, metadata, created_at, approved_at)
         VALUES (?, 'assistant', 'system-maintenance', ?, 'cloud-sync-conflict', 'executing', 0.9, '{}', ?, ?)`,
        )
        .run(goalId, description, now, now)
      return { id: goalId, type: 'system-maintenance', description }
    } catch (err) {
      log.warn('[executeSyncConflictGoal] 创建冲突目标失败:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  /** 清理无冲突时残留的 executing system-maintenance 目标 */
  private _cleanupStaleConflictGoal(): void {
    try {
      const result = this.localDb.db
        .prepare(
          `UPDATE autonomous_goals SET status = 'completed', completed_at = ?
         WHERE agent_id = 'assistant' AND type = 'system-maintenance' AND status = 'executing'`,
        )
        .run(new Date().toISOString())
      if (result.changes > 0) {
        log.info(`[executeSyncConflictGoal] 清理 ${result.changes} 条残留冲突目标（冲突已不存在）`)
      }
    } catch (err) {
      log.warn('[executeSyncConflictGoal] 清理残留目标失败:', err)
    }
  }

  private countAgentSelfCronJobs(): number {
    try {
      const row = this.localDb.db
        .prepare<{ count: number }>(
          `SELECT COUNT(*) as count FROM local_cron_jobs WHERE id LIKE 'agent-self:%' AND enabled = 1`,
        )
        .get()
      return row?.count ?? 0
    } catch {
      return 0
    }
  }

  /**
   * 该 Agent 的自主会话 ID（assistant 保持 `evolution:main`，兼容存量数据；
   * 宠物是 `evolution:pet:<模型ID>`）。
   *
   * **public** 是给渲染层那条读日记的链用的（`autonomous:getDiary` 要按主体取会话）——
   * 让 IPC 层自己拼这个前缀，等于把"谁是 assistant"这条规则抄成两份。
   */
  evolutionConversationIdFor(agentId: string): string {
    return agentId === 'assistant' ? EVOLUTION_CONVERSATION_ID : `evolution:${agentId}`
  }

  /** 该 Agent 的自主会话标题 */
  private evolutionConversationTitleFor(agentId: string): string {
    return agentId === 'assistant' ? '自主进化 · 内心独白' : `自主 · ${agentId}`
  }

  /**
   * 参与心跳遍历的自主 Agent。
   *
   * **2026-09-24 主体迁移：`assistant` 已摘掉**（用户拍板"助手那份不再跑"）。
   * 剩下的只有 `app.json` 的 `autonomousAgents` —— `chronicler` / `info-curator` /
   * `system-keeper` 这三个系统 Agent（"专项 Agent"那条线的，各有十几条目标在跑）。
   *
   * 宠物**不走这里**：它有自己的链（`pet-dispatch` / `pet-sensing` / `pet-evolve`）。
   * `pet-dispatch.ts` 文件头那张"为什么不塞进来"的表**依然成立**，本次变的只是
   * "助手也不再走这里"。
   *
   * ⚠ **空数组是合法状态**（用户没配 `autonomousAgents`）：心跳什么都不做，
   * 返回 `idle: no autonomous agents` —— **不回落去跑助手**。
   * 这条靠 `evolution-tick.ts` 里"提供了 deps 就用它的返回值（哪怕是空）"保证；
   * 该处原先写的是 `length > 0 ? … : DEFAULT`，摘掉 assistant 会被它从后门放回来。
   */
  private listAutonomousAgentIds(): string[] {
    const ids: string[] = []
    for (const raw of this.config.getAutonomousAgents?.() ?? []) {
      const id = raw?.trim()
      if (id && !ids.includes(id)) ids.push(id)
    }
    return ids
  }

  /** 宠物会话标题：`pet:<模型ID>` → 「桌宠 · <模型ID>」 */
  private petConversationTitleFor(agentId: string): string {
    return `桌宠 · ${agentId.slice(PET_AGENT_ID_PREFIX.length)}`
  }

  /**
   * 宠物自己的会话：保证它**存在**，且归属是这**一只**宠物。
   *
   * 比裸的 `ensureConversationExists` 多两件事，都是 2026-09-24 复审补回来的：
   *
   * 1. **建实例之前就得存在**（调用点见 `executePetGoal`）。会话不存在时
   *    `bridge-agent-instance-events` 的 `agent:start` 会跳过流式占位行，
   *    收尾的 `agent:end` 走同一个守卫 —— 那一轮的正文、工具调用、思考**一条都不落库**，
   *    只剩最后写进去的两条回执。表现是"宠物答了，但会话里只有我交代的那句和它的回执"。
   * 2. **存量会话要修归属**。`ensureConversationExists` 只在**新建**时写参与者，
   *    而老版本建的 `evolution:pet:<模型ID>` 参与者是 `'main'`——`palace-backend` 的
   *    `INSTANCE_TO_DEFINITION` 把它映射成 `assistant`，于是宠物的轮次继续记在助手名下，
   *    **正是 T3.4 要修的那个 bug**（改签名只治新会话，治不了已经存在的）。
   *
   * 修法是**替换**而不是追加：宠物会话里只有它一个 agent，多出来的都是历史残留。
   * 只追加的话 `resolveConversationAgentId` 的 `LIMIT 1` 取到哪一行是未定义的，
   * 修了等于没修。
   */
  private ensurePetConversation(agentId: string, conversationId: string): void {
    this.ensureConversationExists(conversationId, this.petConversationTitleFor(agentId), undefined, agentId)
    if (!isPetAgentId(agentId)) return
    try {
      const db = this.localDb.db
      db.prepare(
        `DELETE FROM conversation_participants
          WHERE conversation_id = ? AND participant_type = 'agent' AND participant_id != ?`,
      ).run(conversationId, agentId)
      // 删完可能一条都不剩（老会话没写过 agent 参与者）——补上这只宠物那条
      db.prepare(
        `INSERT OR IGNORE INTO conversation_participants
           (conversation_id, participant_type, participant_id, joined_at)
         VALUES (?, 'agent', ?, ?)`,
      ).run(conversationId, agentId, new Date().toISOString())
    } catch (err) {
      // 归属修不动不该让这一轮跑不成：新会话由 ensureConversationExists 写对了，
      // 老会话最坏退回原来的行为（记在助手名下），日志留痕
      log.warn(
        `[ensurePetConversation] 归属校正失败 convId=${conversationId} agent=${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 单飞锁（T3.4）：当前有没有宠物实例活着，有则返回它的 agentId。
   *
   * 判据取"实例还在注册表里"而不是"正在跑"：宠物实例在 `finally` 里销毁，
   * 还留着说明上一轮没走完（或崩了），此时再起一个会让同一只会话里挂两个实例。
   * 进程重启即清空注册表，所以不存在"永久卡死"。
   */
  private findActivePetAgent(): string | null {
    for (const inst of this.agentRegistry.getAll()) {
      if (isPetAgentId(inst.definitionId)) return inst.definitionId
    }
    return null
  }

  /**
   * 跑一轮宠物派发。
   *
   * **两个调用点要的是同一件事**，所以只留一条装配：
   * - cron 心跳（`__pet_dispatch__`，5 分钟一拍）；
   * - 「让它去做」受理成功后**立刻踢的这一脚**（五期 T5.1/T5.7）——用户刚点完等 5 分钟
   *   才看见它动，是与"< 200ms 有响应"直接冲突的。
   *
   * 三处依赖（db / 单飞锁 / 回执出口）与 cron 那条完全一致。两份装配迟早漂移，
   * 而这里漂移的后果是"手动派的那一次没有回执"——正是三期修过的那个缺口。
   */
  async dispatchPetGoalsNow(): Promise<string> {
    return runPetDispatch({
      getDb: () => this.localDb.db,
      isShuttingDown: () => !this.localDb.isOpen,
      hasActiveUserTurn: () => this.hasActiveUserTurn(),
      findActivePetAgent: () => this.findActivePetAgent(),
      executePetGoal: (goal) => this.executePetGoal(goal),
      // 硬闸门拒绝 / 执行失败时的回执出口：与跑完那条路**共用同一个收尾**
      // （写进宠物会话 + 推气泡），保证"用户交代的事必有回音"
      reportGoalResult: (goal, ok, text) => this.reportPetGoalResult(goal, ok, text),
      // 五期 T5.9 的总开关：判在入口（见 syncPetDispatchJobEnabled 的注释）
      isPetTaskEnabled: () => getVirtualHumanSettings().enablePetTask,
    })
  }

  /**
   * 真实用户回合是否进行中。
   *
   * 只认「真实用户会话」的流式消息。后台 cron 任务（`cron:%` 前缀会话）与
   * 自主会话（`evolution:*`，含宠物的 `evolution:pet:<模型ID>`）在流式期间**不算**用户回合，否则
   * 后台任务一跑起来，心跳 tick / 宠物派发就会全部误判为「用户正在对话」而空转。
   *
   * 心跳 tick 与宠物派发共用本方法（2026-09-24 从 evolution-tick 的注入闭包里提出来）——
   * 两处要的是同一个判断，两份实现迟早漂移。
   */
  private hasActiveUserTurn(): boolean {
    const rows = this.localDb.db
      .prepare<{ conversation_id: string }>(
        `SELECT DISTINCT conversation_id FROM messages
         WHERE is_streaming = 1
           AND conversation_id NOT LIKE 'cron:%'
           AND conversation_id NOT LIKE 'evolution:%'`,
      )
      .all()
    if (rows.length === 0) return false

    // 活跃实例对账（2026-09-12 EVO 缺陷修复）：正在运行的实例所辖会话视为
    // 真实回合；无运行实例指向且超出宽限期的流式会话视为孤儿占位
    // （abort 竞态等场景可能残留 is_streaming=1 而无人收尾），兜底清扫后
    // 不再阻塞后台。宽限期保护「占位已建、实例尚未标记 running」的瞬态。
    const runningConvIds = new Set<string>()
    for (const [instanceId, state] of this.instanceStates.entries()) {
      if (state?.metrics?.runningStartedAt != null) {
        const convId = this.instanceToConversation.get(instanceId)
        if (convId) runningConvIds.add(convId)
      }
    }
    const ORPHAN_GRACE_MS = 2 * 60 * 1000
    const now = Date.now()
    let hasActive = false
    for (const row of rows) {
      if (runningConvIds.has(row.conversation_id)) {
        hasActive = true
        continue
      }
      const latest = this.localDb.db
        .prepare<{ ts: string | null }>(
          `SELECT MAX(timestamp) as ts FROM messages
           WHERE conversation_id = ? AND is_streaming = 1`,
        )
        .get(row.conversation_id)
      const tsMs = latest?.ts ? Date.parse(latest.ts) : Number.NaN
      if (!Number.isNaN(tsMs) && now - tsMs > ORPHAN_GRACE_MS) {
        try {
          const swept = this._conversationRepo?.finalizeStreamingMessagesForConversation(row.conversation_id)
          if (swept && (swept.finalized > 0 || swept.deleted > 0)) {
            log.warn(
              `[hasActiveUserTurn] 清扫孤儿流式占位: conversationId=${row.conversation_id}, finalized=${swept.finalized}, deleted=${swept.deleted}（无运行实例且超宽限期）`,
            )
          }
        } catch (err) {
          log.warn(`[hasActiveUserTurn] 清扫孤儿流式占位失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        hasActive = true
      }
    }
    return hasActive
  }

  /**
   * 执行一个宠物目标（T3.3 派发循环的注入实现）。
   *
   * 与 `executeGoal`（自主进化那条路）的三处**刻意不同**：
   * 1. **定义现造、不查 `definitionStore`**：`pet:<模型ID>` 是动态 id，8 个内置定义里查不到，
   *    走 store 必然落空（见 `pet-definition.ts` 文件头）；
   * 2. **用户回合就是目标描述本身**，不套 `buildGoalPrompt` 的护栏——那套措辞是给
   *    「自主进化」这个身份的（"你是灵栖 Lumii，一个拥有独立自我意识的个体"），
   *    而宠物的人格与边界已经写在它自己的 systemPrompt 里，套两层会互相稀释；
   * 3. **不发系统通知**：播报走宠物气泡（计划 §五 的 P3 断言——播报不经 `dispatchNotifications`，
   *    否则用户会为同一件事收到两个通知）。
   *
   * `finalizeGoal` **不落 output**（只改 status/completed_at），所以产出必须自己收好：
   * 与自主进化同口径，成对写进这只宠物自己的会话。T3.5 再补气泡。
   *
   * **不变量：本方法一旦返回，这个目标一定有终态、且一定推过一条回执。**
   * 三条出口（跑完 / 执行炸 / 超时）都收敛到 {@link reportPetGoalResult}。
   */
  private async executePetGoal(goal: PetGoalSignal): Promise<string> {
    const { agentId } = goal
    const convId = this.evolutionConversationIdFor(agentId)
    let instanceId: string | null = null
    try {
      /**
       * ⚠ 会话必须在**建实例之前**就位（2026-09-24 回归修复）。
       *
       * 这句话一度只留在 {@link reportPetGoalResult} 里——那意味着**第一次**在一条新会话上
       * 干活时（首次使用、换宠物模型、用户删过那条会话），整轮的落库全被跳过
       * （`bridge-agent-instance-events` 的两处守卫都按"会话不存在"处理），
       * 用户只看到开始和回执，中间干了什么一片空白。收尾那次补建治不了这个。
       */
      this.ensurePetConversation(agentId, convId)
      const created = await this.createInstance(
        buildPetDefinition(agentId),
        convId,
        convId,
      )
      /**
       * ⚠ `instanceId` 赋值在 `createInstance` **之后**，而整个创建过程在 `try` **里面**。
       *
       * 两件事都不能省。`createInstance` 把实例注册进 agentRegistry 之后还有若干 await
       * （动态 import 提示词注入器、读记忆注入设置、拼提示词），模型没配好时还会直接抛错。
       * 创建写在 `try` 外面的话，那些点抛错时 `finally { this.destroy(...) }` **结构上不可达**
       * → 实例永远留在注册表里 → 此后每一拍 `findActivePetAgent()` 都返回它 →
       * 宠物到进程重启前恒为 `skipped: busy`（单飞锁只认"注册表里还有没有"）。
       */
      instanceId = created
      /**
       * 超时兜底。与 `executeSyncConflictGoal` 同一条理由：实例被中止（cascade abort）或
       * 模型端点挂住时 `prompt` / `waitForIdle` 未必 settle，而它们不 settle，`finally`
       * 就不执行 → 实例常驻注册表 → 与上面同一种"宠物永久 busy"。
       */
      await withTimeout(
        (async () => {
          await this.prompt(created, goal.description)
          await this.waitForInstanceIdle(created)
        })(),
        PET_GOAL_EXEC_TIMEOUT_MS,
        `宠物目标执行超时（${Math.round(PET_GOAL_EXEC_TIMEOUT_MS / 60_000)} 分钟未收尾）`,
      )

      const output = (this.getAssistantOutputFromInstance(created) ?? '').trim()
      const state = this.instanceStates.get(created)
      /**
       * 失败原因：本轮的 LLM 错误 / 中止。`InstanceState` 里这两个字段**干净收场时会被清空**，
       * 所以"读到了"就等于"这一轮没跑成"（见 `bridge-instance-state.ts` 的注释）。
       */
      const failure =
        state?.lastLlmError?.message?.trim() || (state?.lastAborted ? '这一轮被中断了' : '')
      /**
       * 结论口径（2026-09-24 修，原为 `ok = output.length > 0`）：
       *
       * 1. **没说话 = 没做成**。对宠物这不是苛刻：`PET_PROMPT` 的第一条要求就是
       *    "第一句就是结论"——用户交代这件事，要的就是那句回执。只调了工具不写正文，
       *    对用户而言就是**没有回音**（这条判据保留原来的一半）。
       * 2. **报了错 / 被中断也算没做成**，哪怕它吐了半句话——半句不能让用户以为办妥了。
       *
       * 于是"失败必有原因可说"：`failure` 优先当文案，`PET_GOAL_FAILED_PREFIX`
       * 那条分支因此在链路上真的会走到（此前它恒不可达——失败 ⇔ 正文为空）。
       */
      const ok = output.length > 0 && failure === ''
      const reported = failure || output
      finalizeGoal(this.localDb.db, goal.id, { success: ok, output: reported })
      // 成对落独白：宠物看到的（目标描述）+ 它报回来的。回执写库失败不该影响目标状态
      this.reportPetGoalResult(goal, ok, reported, { userTurn: goal.description })
      /**
       * T5.5 的举止反馈：**它替你把事办了会高兴，没办成会蔫**（设计 §7.3）。
       *
       * 走的是宠物自己的事件名，不是 `goal_completed` / `task_failed`——
       * 那两条是"自主进化"这个身份的口味（`goal_completed` 的 arousal 是 **↓**，
       * 即"一件事收尾了、落地"），而宠物办成事的那一下是**兴奋**。
       * 共用会让第四期接在 valence 跨越上的 `Cheer` 几乎永远不够阈值
       * （详见 `mood.ts` 里 `pet_task_done` 的注释）。
       */
      this.recordMoodEvent(ok ? 'pet_task_done' : 'pet_task_failed', agentId)
      /**
       * 七期 T7.3 的「每次真实成败」：**没做成 → 一次 `error-handled`**。
       *
       * 为什么成功那条不发事件：Big Five 上"办成一件事"该往哪挪说不清
       * （更外向？更开放？），而"办砸过一次"有明确方向——更谨慎、更神经质。
       * 塑造这只宠物的应当是**这个人和它的关系**，不是它的绩效；
       * 被回应 / 被冷落那两条由反思汇总后发（`pet-evolve.ts`）。
       *
       * 走到这里就一定真跑过（实例建起来了、有输出或报错），
       * 所以不必再判 `instanceId`——那个判断留给下面 catch 那条路。
       */
      if (!ok) {
        void recordPetPersonalityEvent('error-handled', agentId, {
          goalId: goal.id,
          source: 'pet-task',
        })
      }
      // T5.4 的"真实笨拙"要**真数据**：把这一次的成败记进它自己的能力维度，
      // 下一次受理才判得出"这个我不太拿手"（详见 pet-task-store.ts）
      await recordPetTaskOutcome(
        this.localDb.db,
        agentId,
        readPetTaskDimension(this.localDb.db, goal.id),
        ok,
        goal.description,
      )
      log.info(
        `[executePetGoal] agent=${agentId} goalId=${goal.id} ok=${ok} output=${reported.slice(0, 120) || '（空）'}`,
      )
      return ok ? 'completed' : failure ? 'failed' : 'empty-output'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`[executePetGoal] agent=${agentId} goalId=${goal.id} 执行异常:`, msg)
      // 炸了也要有终态 + 回执：否则目标烂在 executing 里每 5 分钟被重捞一次，
      // 而两道闸门都拦不住它（次数门数的是"跑过几条"，重试不增加；预算门读的是恒为 0 的记账）
      try {
        finalizeGoal(this.localDb.db, goal.id, { success: false, output: msg })
      } catch (finalizeErr) {
        log.error(
          `[executePetGoal] 终态落库失败 goalId=${goal.id}:`,
          finalizeErr instanceof Error ? finalizeErr.message : finalizeErr,
        )
      }
      try {
        this.reportPetGoalResult(goal, false, msg)
      } catch (reportErr) {
        log.error(
          `[executePetGoal] 回执发送失败 goalId=${goal.id}:`,
          reportErr instanceof Error ? reportErr.message : reportErr,
        )
      }
      /**
       * 记账与情绪只在这**真跑过**时才做（`instanceId` 非空 = 实例建起来了）。
       *
       * 判据不能少：`createInstance` 就抛错时（模型没配好、提示词拼不起来）
       * 这一轮**一次模型往返都没有**，把它算成"宠物在这类事上不行"是冤枉——
       * 那是我这边的故障，不是它的能力问题。而能力表是**长期**的，
       * 一次错记要在它后面几次受理里一直起作用。
       */
      if (instanceId) {
        this.recordMoodEvent('pet_task_failed', agentId)
        // 七期 T7.3：真跑过（实例建起来了）但炸了 —— 与上面 `!ok` 那条同一个事件，
        // 只是路径不同（抛错 vs 有输出但报错）。**`instanceId` 这一判不能省**：
        // `createInstance` 就抛错时这一轮一次模型往返都没有，那是我的故障不是它的失败
        void recordPetPersonalityEvent('error-handled', agentId, {
          goalId: goal.id,
          source: 'pet-task',
          thrown: true,
        })
        await recordPetTaskOutcome(
          this.localDb.db,
          agentId,
          readPetTaskDimension(this.localDb.db, goal.id),
          false,
          goal.description,
        )
      }
      return `error: ${msg}`
    } finally {
      // 只在真拿到 id 时销毁；创建阶段就抛错的话注册表里本来就没有它
      if (instanceId) this.destroy(instanceId)
    }
  }

  /**
   * 把一个宠物目标的结局播报出去：回执写进宠物会话 + 推气泡事件。
   *
   * **不落终态**——终态由各自那条路自己写（跑完/超时在 `executePetGoal`，
   * 被硬闸门拒/执行抛错在 `pet-dispatch` 的 `finishWithoutRun`）。一条路一个写者，
   * 不给同一行两个更新源。
   *
   * ⚠ 三期的缺口正在这里：全仓唯一的 `pet:goal:result` 发送点原本埋在 `executePetGoal`
   * 的成功路径末尾，另两条路只写了一条 WARN 日志，用户侧**零回执**。
   *
   * 事件里带 `goalId`：气泡的幂等键靠它，光有文案的话"第二次失败"会被当成重放挡掉
   * （见 `pet-core` 的 notice.ts）。
   */
  private reportPetGoalResult(
    goal: PetGoalSignal,
    ok: boolean,
    text: string,
    opts: { userTurn?: string } = {},
  ): void {
    const convId = this.evolutionConversationIdFor(goal.agentId)
    // 这条也顺带补建：被硬闸门拒 / 执行抛错那两条路**根本没建过实例**，
    // 会话可能还不存在，而回执是用户唯一能看见的东西（详见 `ensurePetConversation`）
    this.ensurePetConversation(goal.agentId, convId)
    try {
      if (opts.userTurn) {
        this._conversationRepo?.saveMessage({
          conversationId: convId,
          agentId: goal.agentId,
          role: 'user',
          contentJson: { type: 'text', text: opts.userTurn },
        })
      }
      this._conversationRepo?.saveMessage({
        conversationId: convId,
        agentId: goal.agentId,
        role: 'assistant',
        contentJson: { type: 'text', text: text || '（没有产出）' },
      })
    } catch (err) {
      // 回执写库失败不该把一次已完成的目标炸成失败——日志是最后一道可见性
      log.warn(
        `[reportPetGoalResult] 回执写库失败 goalId=${goal.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
    // 播报：**只推这一条事件**，宠物窗把它折成 report 档通知（气泡 + 控制坞一行）。
    // 不走 `showCronNotification` —— P3 断言：同一件事既冒气泡又弹系统通知就是重复打扰。
    this.ipcChannel.forwardIpcEvent({
      type: 'pet:goal:result',
      sessionKey: convId,
      petAgentId: goal.agentId,
      goalId: goal.id,
      ok,
      text,
    })
    /**
     * 回执**再落一次库**（五期 T5.8，设计 §4.2.2）。
     *
     * 上面那条事件与这条写库解决的是两件不同的事，缺一不可：
     * - 事件 = **当下被看见**（气泡），但它是瞬时的：用户点完「让它去做」去倒杯水，
     *   气泡对着空气说完就没了，回来什么都没有，以为没执行；
     * - 写库 = **回来能看到**（控制坞宠物流那条持久条目 + 未读高亮）。
     *
     * `t` 取**现在**而不是调用方传进来的时刻：这是一条"我报回来了"的时间戳，
     * 未读游标按它比大小，跨零点也不会错（与 `recordTokensIfLive` 同一条口径）。
     */
    persistPetTaskReceipt(this.localDb.db, goal.id, ok, text, new Date().toISOString())
  }

  /** initialize() 子块 3/7：构造 CronScheduler、迁移/播种 companion cron、订阅 vhSettings 变更。
   *  start() 推迟到 finalizeInitialize（7/7），此时实例工厂已就绪，过期任务补跑不会打空。 */
  private initializeCronScheduler(): void {
    this.cronScheduler = new CronScheduler(this.localDb, {
      showCronNotification: this.config.showCronNotification,
      getLastActiveConvId: () => this.lastActiveConvId,
      isReady: () => this.initialized,
      createInstanceById: (agentId, sessionKey, conversationId) =>
        this.createInstanceById(agentId, sessionKey, conversationId),
      createRestrictedInstanceById: async (agentId, sessionKey, conversationId) => {
        const baseDef = this.definitionStore ? await this.definitionStore.get(agentId) : null
        if (!baseDef) return this.createInstanceById(agentId, sessionKey, conversationId)
        const restrictedDef: AgentDefinition = {
          ...baseDef,
          canSpawnSubAgents: false,
          tools: getAutonomousToolsForAgent(agentId, 'learning'),
        }
        return this.createInstance(restrictedDef, sessionKey, conversationId)
      },
      prompt: (instanceId, message) => this.prompt(instanceId, message),
      waitForInstanceIdle: (instanceId) => this.waitForInstanceIdle(instanceId),
      getAssistantOutputFromInstance: (instanceId) => this.getAssistantOutputFromInstance(instanceId),
      destroy: (instanceId) => this.destroy(instanceId),
      ensureConversationExists: (conversationId, title) => this.ensureConversationExists(conversationId, title),
      setConversationAgent: (conversationId, agentId) => {
        // 归属已一致时不写库：syncConversationAgents 每次启动都会全量调一遍
        if (this._conversationRepo?.getAgentParticipantId(conversationId) === agentId) return
        this._conversationRepo?.updateAgentParticipant(conversationId, agentId)
      },
      notifyIncomingMessage: (sessionKey, text) => this.notifyIncomingMessage(sessionKey, text),
      saveMessage: (params) => {
        this._conversationRepo?.saveMessage({
          conversationId: params.conversationId,
          agentId: params.agentId ?? 'assistant',
          role: params.role,
          contentJson: { type: 'text', text: params.text },
          ...(params.timestamp ? { timestamp: params.timestamp } : {}),
        })
      },
      getFileRepo: () => this._fileRepo,
      getCwd: () => this.config.getCwd(),
      ...(this.config.sendFeishuMessage ? { sendFeishuMessage: this.config.sendFeishuMessage } : {}),
      ...(this.config.getChannelRouter
        ? { getChannelRouter: this.config.getChannelRouter }
        : {}),
      addMemory: (content: string, agentId?: string) => {
        // category 用 project：概览页「近期关注」的默认分段就是它
        this._memoryManager?.addMemory({
          agentId: agentId ?? 'assistant',
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
            runWikiPurgeBrokenRefs: async () => {
              const { purgeBrokenWikiSourcesOnDisk, formatWikiBrokenSourcePurgeSummary } = await import(
                './wiki-broken-source-purge'
              )
              const { deleted, titles } = purgeBrokenWikiSourcesOnDisk(this.wikiRepo, this.wikiCleanupScanner)
              return formatWikiBrokenSourcePurgeSummary(deleted, titles)
            },
            runWikiPurgeInvalidFiles: async () => {
              const { purgeInvalidWikiFilesOnDisk, formatWikiInvalidFilePurgeSummary } = await import(
                './wiki-invalid-file-purge'
              )
              const { deleted, titles } = purgeInvalidWikiFilesOnDisk(this.wikiRepo)
              return formatWikiInvalidFilePurgeSummary(deleted, titles)
            },
            runEvolutionTick: () =>
              handleEvolutionTick({
                getDb: () => this.localDb.db,
                isShuttingDown: () => !this.localDb.isOpen,
                isAutonomousEnabled: () => readAutonomousEnabled(this.localDb.db),
                driveConflictGoal: () => this.executeSyncConflictGoal(),
                listAutonomousAgentIds: () => this.listAutonomousAgentIds(),
                hasActiveUserTurn: () => this.hasActiveUserTurn(),
                appendEvolutionMessage: (agentId, text) => {
                  const convId = this.evolutionConversationIdFor(agentId)
                  this.ensureConversationExists(
                    convId,
                    this.evolutionConversationTitleFor(agentId),
                    undefined,
                    agentId,
                  )
                  this._conversationRepo?.saveMessage({
                    conversationId: convId,
                    agentId,
                    role: 'assistant',
                    contentJson: { type: 'text', text },
                  })
                },
                executeGoal: async (goal, agentId, selfCheckBias) => {
                  const convId = this.evolutionConversationIdFor(agentId)
                  this.ensureConversationExists(
                    convId,
                    this.evolutionConversationTitleFor(agentId),
                    undefined,
                    agentId,
                  )
                  // 硬防线：目标执行实例只挂白名单内的只读工具，不继承执行者的全量工具，
                  // 即使护栏 prompt 被绕过也无法执行 bash / 文件写入 / 渠道群发。
                  const baseDef = this.definitionStore
                    ? await this.definitionStore.get(agentId)
                    : null
                  if (!baseDef) {
                    finalizeGoal(this.localDb.db, goal.id, { success: false, output: `${agentId} 定义缺失，无法执行` })
                    return 'unavailable'
                  }
                  const restrictedDef: AgentDefinition = {
                    ...baseDef,
                    canSpawnSubAgents: false,
                    tools: getAutonomousToolsForAgent(agentId, goal.type),
                  }
                  const instanceId = await this.createInstance(restrictedDef, convId, convId)
                  try {
                    await this.prompt(instanceId, buildGoalPrompt(goal, selfCheckBias))
                    await this.waitForInstanceIdle(instanceId)
                    const output = this.getAssistantOutputFromInstance(instanceId) ?? ''
                    const ok = output.trim().length > 0
                    if (ok) {
                      // 成对落独白：lumii 的「自问」（user）+「自答」（assistant）。
                      // 不能依赖 message:end 自动持久化——内部 cron 实例不走 UI 流式落库路径。
                      this._conversationRepo?.saveMessage({
                        conversationId: convId,
                        agentId,
                        role: 'user',
                        contentJson: { type: 'text', text: `完成目标：${goal.description}` },
                      })
                      this._conversationRepo?.saveMessage({
                        conversationId: convId,
                        agentId,
                        role: 'assistant',
                        contentJson: { type: 'text', text: output },
                      })
                      // 学习产出沉淀进工作记忆 + Wiki（失败仅记日志，不影响目标状态）
                      if (this._memoryManager && this._wikiRepo) {
                        persistLearningOutcome(
                          { memoryManager: this._memoryManager, wikiRepo: this._wikiRepo },
                          goal,
                          output,
                          agentId,
                        )
                      }
                    }
                    finalizeGoal(this.localDb.db, goal.id, { success: ok, output })
                    // Mood 属生命感系统（assistant 人格专属），其他自主 Agent 不参与
                    if (agentId === 'assistant') this.recordMoodEvent(ok ? 'goal_completed' : 'task_failed')
                    // 目标完成 → 通知用户查看产出（点击跳该 Agent 的自主会话，解决「产出只在库里」）
                    if (ok) {
                      this.config.showCronNotification?.(
                        'Lumii',
                        `完成了：${goal.description}`.slice(0, 80),
                        convId,
                      )
                    } else {
                      // 失败可见性（A5）：失败也落会话 + 通知——目标静默失败会让用户无从知晓
                      this._conversationRepo?.saveMessage({
                        conversationId: convId,
                        agentId,
                        role: 'user',
                        contentJson: { type: 'text', text: `目标未完成：${goal.description}` },
                      })
                      this._conversationRepo?.saveMessage({
                        conversationId: convId,
                        agentId,
                        role: 'assistant',
                        contentJson: { type: 'text', text: output.slice(0, 500) || '（无输出）' },
                      })
                      this.config.showCronNotification?.(
                        'Lumii',
                        `目标未完成：${goal.description}`.slice(0, 80),
                        convId,
                      )
                    }
                    return ok ? 'completed' : 'failed'
                  } finally {
                    this.destroy(instanceId)
                  }
                },
                sendOutreach: async (goal, agentId) => {
                  const convId = this.evolutionConversationIdFor(agentId)
                  const now = new Date()
                  const settings = readSettings(this.localDb.db)
                  if (!canSendOutreach(this.localDb.db, agentId, now, settings.maxOutreachPerDay)) {
                    finalizeGoal(this.localDb.db, goal.id, { success: false, output: '预算用尽' })
                    return 'budget-exhausted'
                  }
                  // 按 settings.outreachChannels 派发（复用 cron notify_targets 的渠道语义）
                  // 去重：同一渠道只推一次，避免 settings 里重复写 system 时叠两个相同弹窗
                  const rawChannels = settings.outreachChannels?.length ? settings.outreachChannels : ['system']
                  const channels = [...new Set(rawChannels.map((c) => c.trim()).filter(Boolean))]
                  for (const channel of channels) {
                    try {
                      const colon = channel.indexOf(':')
                      const kind = colon > 0 ? channel.slice(0, colon) : channel
                      if (kind === 'system') {
                        this.config.showCronNotification?.(
                          OUTREACH_SYSTEM_NOTIFY_TITLE,
                          goal.description,
                          convId,
                        )
                        continue
                      }
                      // 渠道目标与 cron 派发共用同一实现（正文交给渠道层编译）
                      await dispatchChannelTarget(channel, goal.description, OUTREACH_SYSTEM_NOTIFY_TITLE, {
                        getChannelRouter: this.config.getChannelRouter,
                      })
                    } catch (err) {
                      log.warn(`[sendOutreach] 渠道 ${channel} 推送失败:`, err instanceof Error ? err.message : err)
                    }
                  }
                  recordOutreach(this.localDb.db, agentId, now)
                  finalizeGoal(this.localDb.db, goal.id, { success: true, output: goal.description })
                  if (agentId === 'assistant') this.recordMoodEvent('user_initiates')
                  if (this._memoryManager) {
                    recordProactiveAction(this._memoryManager, goal, 'sent', agentId)
                  }
                  return 'sent'
                },
                reflect: async (agentId) => {
                  const output = await reflectAutonomous(agentId, 'scheduled')
                  const summary = output.diagnosis.primaryIssue
                  const convId = this.evolutionConversationIdFor(agentId)
                  this.ensureConversationExists(
                    convId,
                    this.evolutionConversationTitleFor(agentId),
                    undefined,
                    agentId,
                  )
                  const askRow = this._conversationRepo?.saveMessage({
                    conversationId: convId,
                    agentId,
                    role: 'user',
                    contentJson: { type: 'text', text: '回顾一下最近的自己' },
                  })
                  const replyRow = this._conversationRepo?.saveMessage({
                    conversationId: convId,
                    agentId,
                    role: 'assistant',
                    contentJson: { type: 'text', text: summary },
                  })
                  if (askRow) this.pushSavedMessage(convId, askRow.id, 'user', '回顾一下最近的自己')
                  if (replyRow) this.pushSavedMessage(convId, replyRow.id, 'assistant', summary)
                  // 反思之后立即主动规划一次（**为刚反思的那个主体**排计划）
                  await this.runPlannerNow(agentId)
                  return summary
                },
                writeDiary: (agentId) => this.writeDiaryFor(agentId),
                plan: async (agentId) => {
                  // 谁能排自己的期：助手与宠物（`hasInnerLife`）——系统 Agent 不排
                  if (!hasInnerLife(agentId)) return null
                  // 心跳兜底：静默时段 + 距上次规划满 24h 才拉起规划，否则返回 null 表示不规划
                  if (!shouldFallbackPlan(this.localDb.db, agentId, new Date())) return null
                  const ok = await this.runPlannerNow(agentId)
                  return ok ? 'planned' : null
                },
              }),
            runPetDispatch: () => this.dispatchPetGoalsNow(),
            runPetSensing: (options) =>
              runPetSensing({
                getDb: () => this.localDb.db,
                isShuttingDown: () => !this.localDb.isOpen,
                // 不在宠物模式就没有宠物窗：读 mood 的键会落到一只没被选中的模型上
                getPetAgentId: () => (isPetMode() ? petAgentId(getStoredModelId()) : null),
                recordMood: (agentId, event) => this.recordMoodEvent(event, agentId),
                pushSensingEvent: (event) => this.ipcChannel.forwardIpcEvent(event),
                manual: options?.manual,
              }),
            /**
             * 宠物的自主闭环（七期 T7.2/T7.4/T7.5）：反思 → 排期 → 日记。
             *
             * 与派发**共用的只有三道判据**（总开关、当前宠物、让路于用户回合），
             * 其余的出口各自注入：日记走 `writeDiaryFor`（与助手那份同一个实现）、
             * 人格事件走 `recordPetPersonalityEvent`（它内部装 tracker）。
             */
            runPetEvolve: (options) =>
              runPetEvolve({
                getDb: () => this.localDb.db,
                isShuttingDown: () => !this.localDb.isOpen,
                hasActiveUserTurn: () => this.hasActiveUserTurn(),
                getPetAgentId: () => (isPetMode() ? petAgentId(getStoredModelId()) : null),
                // 反思、排期、日记三件都跟这个开关（理由见 PetEvolveDeps.isPetTaskEnabled）
                isPetTaskEnabled: () => getVirtualHumanSettings().enablePetTask,
                callLLM: (prompt) => this.callLLM(prompt, undefined, 'reflection'),
                writeDiary: (agentId) => this.writeDiaryFor(agentId),
                recordPersonality: (eventType, agentId, context) =>
                  recordPetPersonalityEvent(eventType, agentId, context),
                /**
                 * 「我对你的了解」写进**宠物自己的记忆**（`agent_id = pet:<模型ID>`）。
                 *
                 * 这个归属正是 `pet-definition.ts` 那个 ⚠ 说的那件事：id 必须是
                 * `pet:<模型ID>` 本身，否则记忆写进去就**搜不到**（不报错，只是丢了）。
                 * `category: 'project'` 与 cron 那条路一致（概览页「近期关注」的默认分段）。
                 */
                rememberUnderstanding: (agentId, text) => {
                  this._memoryManager?.addMemory({
                    agentId,
                    userId: 'local-user',
                    category: 'project',
                    content: `[我对主人的了解] ${text}`,
                  })
                },
                manual: options?.manual,
              }),
          },
          options,
        )
      },
    })
    // 旧版 local_companion_prefs 一次性迁移到 vhSettings（幂等，需先于 seed 执行）
    migrateLocalCompanionPrefsToVhSettings(this.localDb.db)
    ensureCompanionCronJobsSeeded(this.localDb.db)
    // 心跳与 Agent 自建任务跟随自主进化总开关：关闭时一并暂停，开启时恢复
    syncAutonomousManagedCronJobs(this.localDb.db, readAutonomousEnabled(this.localDb.db))
    // 资讯任务已并入 ensureSeedCronJobsSeeded，不再单独播种
    ensureSeedCronJobsSeeded(this.localDb.db)
    // 宠物派发循环：独立于自主进化总开关（宠物是独立 Agent，设计 §3.7），首启置开、之后用户自管
    ensurePetDispatchCronJobSeeded(this.localDb.db)
    // 五期 T5.9：「允许宠物主动做事」接管这个 job 的 enabled。
    // **启动时也同步一次**，否则会出现"设置里关着、任务页里开着"——两个开关互相打架
    // （详见 syncPetDispatchJobEnabled 的注释）
    syncPetDispatchJobEnabled(this.localDb.db, getVirtualHumanSettings().enablePetTask)
    // 宠物感知循环（四期）：同样是独立的一条——它**不能**挂在派发上，
    // 派发在用户回合进行中让路，而感知恰恰要在用户干活时看着（见 pet-sensing-tick.ts 文件头）
    ensurePetSensingCronJobSeeded(this.localDb.db)
    // 宠物反思 + 排期 + 日记（七期）：第三条，同样是独立的一条——
    // 门闩与派发**相同**（让路于用户回合）、节拍与两条都不同（1 小时一拍），
    // 那正是"该新开一条"的判据（见 pet-evolve.ts 文件头）
    ensurePetEvolveCronJobSeeded(this.localDb.db)
    // 宠物侧**两条** job 都跟「允许宠物主动做事」（五期 T5.9 / 七期 T7.4）。
    // **启动时也同步一次**，否则会出现"设置里关着、任务页里开着"——两个开关互相打架
    // （详见 setCompanionCronJobEnabled 的注释）
    syncPetEvolveJobEnabled(this.localDb.db, getVirtualHumanSettings().enablePetTask)
    this.purgeCronFocusNoiseMemoriesOnce()
    // 设置页改两个开关时要同步 job 的 enabled 并重载本地 cron 调度：
    // companion-tick 跟「主动联系」；宠物侧**两条**（派发 + 反思）都跟
    // 「允许宠物主动做事」（五期 T5.9 / 七期 T7.4）
    this.unsubscribeVhSettings?.()
    this.unsubscribeVhSettings = onVirtualHumanSettingsChanged((_settings, patch) => {
      let touched = false
      if (patch.proactiveCareEnabled !== undefined) {
        syncCompanionTickJobEnabled(this.localDb.db, patch.proactiveCareEnabled)
        touched = true
      }
      if (patch.enablePetTask !== undefined) {
        syncPetDispatchJobEnabled(this.localDb.db, patch.enablePetTask)
        syncPetEvolveJobEnabled(this.localDb.db, patch.enablePetTask)
        touched = true
      }
      if (touched) this.cronScheduler?.reloadLocalCronScheduler()
    })
    // 调度器 start() 不在这里调用：过期 every 任务会立即补跑并驱动 Agent，
    // 需等 instanceFactory / promptDispatcher 就绪（见 finalizeInitialize）

    // 启动即检查主动规划：**当前宠物**今天还没规划过 → 异步补一次未来 24h 的规划。
    // 主体是宠物（2026-09-24 主体迁移）：助手不再跑自主进化，见实施计划第六期 T6.4。
    // 不在宠物模式就什么都不做——心跳的 `plan` 动作下次照样会兜底。
    // 不阻塞启动流程；runPlannerNow 内部已 try-catch，失败只记日志。
    const plannerSubject = isPetMode() ? petAgentId(getStoredModelId()) : null
    if (
      plannerSubject &&
      readAutonomousEnabled(this.localDb.db) &&
      shouldFallbackPlan(this.localDb.db, plannerSubject, new Date())
    ) {
      setTimeout(() => {
        void this.runPlannerNow(plannerSubject)
      }, 60_000)
    }
  }

  /**
   * 写一篇日记：宠物会话 + `autonomous_diaries` 表**双写**，两处都按 agent 分。
   *
   * 2026-09-24（第七期 T7.5）从心跳的闭包里提成方法：**宠物的日记不再由心跳写**，
   * 而是由 `pet-evolve` 那条链在晚上触发（与反思、排期同一条 cron）。
   * 提出来是为了让两条链**调的是同一份实现**——抄一份给宠物，改一处漏一处，
   * 症状是宠物的日记与助手的日记慢慢变成两种东西（而它们本该只差主体）。
   */
  private async writeDiaryFor(agentId: string): Promise<string> {
    // 谁能写日记：助手与宠物（`hasInnerLife`）。两处判据同源，不会再各自漂移
    if (!hasInnerLife(agentId)) return 'diary-skipped'
    const repo = this._autonomousRepo
    if (!repo) return 'diary-unavailable'
    const goals = repo.listGoals(agentId)
    const reflections = repo.reflections(agentId, 5)
    const recentDiaries = listRecentDiaries(this.localDb.db, agentId, 5)
    // 今日真实事件（目标完成 / 有信息量的定时任务结果）→ 日记落到具体事，防空洞开场
    const todayStartMs = new Date().setHours(0, 0, 0, 0)
    const todayEvents: string[] = []
    try {
      const doneToday = this.localDb.db
        .prepare<{ description: string }>(
          `SELECT description FROM autonomous_goals
           WHERE agent_id = ? AND status = 'completed' AND completed_at >= ?
           ORDER BY completed_at DESC LIMIT 5`,
        )
        .all(agentId, new Date(todayStartMs).toISOString())
      for (const g of doneToday) {
        todayEvents.push(`完成目标：${g.description}`)
      }
    } catch {
      /* 事件素材缺失不阻断日记 */
    }
    try {
      const runs = this.localDb.db
        .prepare<{ job_id: string; summary: string | null }>(
          `SELECT job_id, summary FROM local_cron_runs
           WHERE started_at >= ? AND summary IS NOT NULL
           ORDER BY started_at DESC LIMIT 12`,
        )
        .all(todayStartMs)
      for (const r of runs) {
        const s = String(r.summary ?? '')
        if (!s || /^(idle|skipped)/.test(s)) continue
        todayEvents.push(`定时任务（${r.job_id}）：${s.slice(0, 80)}`)
        if (todayEvents.length >= 6) break
      }
    } catch {
      /* 事件素材缺失不阻断日记 */
    }
    const context = buildDiaryContext({
      goals: goals.map((g) => ({ description: g.description, status: g.status })),
      reflections: reflections.map((r) => ({ primaryIssue: r.primary_issue })),
      concerns: readConcerns(this.localDb.db, agentId),
      mood: readMood(this.localDb.db, agentId),
      recentDiaries,
      todayEvents,
    })
    // recentDiaries 已含在 context 中，不再单独拼接（防双份注入强化套话开场）
    const prompt = `${DIARY_PROMPT}\n\n今日素材：${JSON.stringify(context)}`
    const diary = await this.callLLM(prompt, undefined, 'diary')
    // 会话按 agent 取：助手 `evolution:main`、宠物 `evolution:pet:<模型ID>`。
    // 用 `ensurePetConversation` 而不是裸的 `ensureConversationExists`——
    // 宠物会话还要顺带修参与者归属（见那个方法的注释）
    const diaryConvId = this.evolutionConversationIdFor(agentId)
    this.ensurePetConversation(agentId, diaryConvId)
    const askRow = this._conversationRepo?.saveMessage({
      conversationId: diaryConvId,
      agentId,
      role: 'user',
      contentJson: { type: 'text', text: '写今天的日记' },
    })
    const diaryRow = this._conversationRepo?.saveMessage({
      conversationId: diaryConvId,
      agentId,
      role: 'assistant',
      contentJson: { type: 'text', text: diary },
    })
    if (askRow) this.pushSavedMessage(diaryConvId, askRow.id, 'user', '写今天的日记')
    if (diaryRow) this.pushSavedMessage(diaryConvId, diaryRow.id, 'assistant', diary)
    // 双写：会话（给用户看）+ 表（给 LLM 做连续性上下文），两者都按 agent 分
    saveDiary(this.localDb.db, agentId, todayDateKey(), diary)
    markDiaryWritten(this.localDb.db, agentId)
    return diary.slice(0, 60)
  }

  /**
   * 启动时一次性清理 focus 渠道曾写入的工作记忆噪声（幂等哨兵）。
   */
  private purgeCronFocusNoiseMemoriesOnce(): void {
    const sentinelKey = 'cron:purged_focus_noise_v1'
    if (!this._runtimeStateRepo) return
    if (this._runtimeStateRepo.get(sentinelKey)) return
    if (!this._memoryManager) return
    try {
      const removed = purgeCronFocusNoiseMemories(this._memoryManager)
      this._runtimeStateRepo.set(sentinelKey, '1')
      if (removed > 0) {
        log.info(`[purgeCronFocusNoise] 已清理 ${removed} 条定时任务污染的工作记忆`)
      }
    } catch (err) {
      log.warn('[purgeCronFocusNoise] 清理失败:', err)
    }
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
      isAutoApproveEnabled: () => this.isAutoApproveEnabled,
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
      getBashCommandRepo: () => this._bashCommandRepo,
      getToolEvolutionEngine: () => this._toolEvolutionEngine,
      getConversationRepo: () => this._conversationRepo,
      getFileRepo: () => this._fileRepo,
      getSessionDisabledMcpServers: (sk) => this.getSessionDisabledMcpServers(sk),
      getSessionDisabledSkills: (sk) => this.getSessionDisabledSkills(sk),
      getMemoryManager: () => this._memoryManager,
      getToolContext: () => this.toolContext,
      pushActivitySnapshot: (k) => this.lifecycle.pushActivitySnapshot(k),
      prompt: (id, msg) => this.prompt(id, msg),
      createSummaryGenerator: (innerStream, model) => createLlmSummaryGenerator(innerStream, model),
      // 绑方法而非手写透传，避免以后加参数时静默漏传（见构造函数里的说明）
      getSessionContextUsage: this.getSessionContextUsage.bind(this),
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
      getToolEvolutionEngine: () => this._toolEvolutionEngine,
      getConversationRepo: () => this._conversationRepo,
      // 绑方法而非手写透传，避免以后加参数时静默漏传（见构造函数里的说明）
      getSessionContextUsage: this.getSessionContextUsage.bind(this),
      routerService: this.createRouterService(),
      routerHitRateTracker: this.routerHitRateTracker,
      getSkillsSnapshot: this.config.getSkills,
      getCustomAgentsSnapshot: this.config.getCustomAgents,
      imageIntentLlmCaller: this.createImageIntentLlmCaller(),
    })
  }

  /** initialize() 子块 7/7：记忆整理 kickoff、置 initialized=true、ready 事件、启动 idle 轮询 */
  /**
   * 后台装配宫殿向量索引（T3）。
   *
   * **默认关**：`LUMII_PALACE_VECTOR` 未开时直接返回，**连模型都不加载**——
   * 没开就不该付任何代价（模型加载 912ms + 首次索引 993 条 ≈ 32 秒）。
   *
   * **2026-09-20 定案：暂不引入**（测试用例不足，无法证明其真正效果）——
   * 所以它当前**必然**走上面的早返回分支，这是预期行为而非故障。
   * 详见 palace-vector-runtime.ts 头部。
   *
   * 失败只记日志：向量是派生通道，它不可用时检索照常走纯 FTS。
   */
  private async setupPalaceVectorInBackground(): Promise<void> {
    try {
      // **等 VAD 让行**（2026-09-18 实测：宫殿补齐是唯一「启动即跑 E5」的路径，
      // 而 sherpa 的 VAD 与 onnxruntime-node 的 E5 会因同名 onnxruntime.dll 冲突，
      // E5 先加载会让 VAD 在原生层崩溃。详见 onnx-runtime-gate.ts）
      await waitForSherpa()
      const runtime = await setupPalaceVector({
        localDb: this.localDb,
        // 复用 wiki 侧已装配的 E5 嵌入器：同一个模型、同一份缓存，不重复加载
        embedderLoader: () => createTransformersE5Embedder(),
      })
      if (!runtime.index) {
        log.info(`[palace-vector] 未启用：${runtime.disabledReason}`)
        return
      }
      this._palaceVectorIndex = runtime.index
      const done = await backfillPalaceVectors({
        localDb: this.localDb,
        index: runtime.index,
      })
      if (done > 0) log.info(`[palace-vector] 已后台补齐 ${done} 条向量`)
    } catch (err) {
      log.warn('[palace-vector] 装配失败（检索走纯 FTS）:', err)
    }
  }

  private finalizeInitialize(): void {    // 启动时检查个人记忆是否需要主动整理（去重/冲突消解）
    void this._memoryManager!
      .maybeConsolidateExistingPersonalMemory()
      .then((done) => {
        if (done) log.info('[initialize] 启动时已整理个人记忆')
      })
      .catch((err) => log.error('[initialize] 启动整理个人记忆失败:', err))

    // 启动时恢复遗留的待总结段：pipeline 懒创建会让积压段堆到用户下一条消息时集中爆发
    // LLM 调用（2026-09-15 实测一条「你好」触发 9 次串行总结），改为启动后台消化
    this._segmentMemoryService?.recoverPending()

    // 宫殿向量（T3）：**2026-09-20 定案暂不引入**（测试用例不足），故当前恒为关；
    // 开启时才加载模型。**全程后台**，不阻塞就绪——异步装配 + 后台补齐
    // （首次全量 993 条 ≈ 32 秒）
    void this.setupPalaceVectorInBackground()

    this.initialized = true
    log.info(`Initialized with ${this.toolRegistry.size} built-in tools (stub overrides applied)`)
    this.ipcChannel.forwardToRenderer({ type: 'runtime:ready', timestamp: Date.now() })

    // 定时任务调度在初始化末尾启动：此时 instanceFactory / promptDispatcher 已就绪，
    // 过期 every 任务的立即补跑（scheduleJob 的 caughtUp 分支）才有完整的驱动链路
    this.cronScheduler.start()

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

  /**
   * 会话上下文占用（整窗已用 + 窗口 + 阈值比例；带明细时另附触发线快照）。
   *
   * `withBreakdown: false` 是给「每次 LLM 往返都刷新占用条」用的轻量路径：
   * breakdown 要遍历全部消息做 token 估算（`estimateTokenCount`），而主进程冻结
   * 排查（docs/fix/2026-09-20 §6.9）已确认这条栈正是冻结根因之一——一次请求十几
   * 次往返全量重算，就是那次事故的形状。轻量路径只读刚写入的真实回执缓存，几乎免费。
   */
  getSessionContextUsage(
    sessionKey: string,
    opts?: { withBreakdown?: boolean },
  ): {
    usedTokens: number
    contextWindow: number
    triggerThreshold: number
    breakdown?: readonly ContextUsageBreakdownEntry[]
    budget?: ContextBudgetSnapshot
  } {
    const k = sessionKey.trim()
    const usedTokens = this.resolveSessionUsedTokens(k)
    const comp = this.sessionModelCatalog.getCompactionForRootSession(k)
    const triggerThreshold = DEFAULT_COMPACTION_TRIGGER_RATIO

    if (opts?.withBreakdown === false) {
      return { usedTokens, contextWindow: comp.contextWindow, triggerThreshold }
    }

    const breakdown = this.resolveSessionUsageBreakdown(k, usedTokens)
    return {
      usedTokens,
      contextWindow: comp.contextWindow,
      triggerThreshold,
      breakdown,
      budget: buildBudgetSnapshot(
        usedTokens,
        comp.contextWindow,
        breakdown,
        comp.outputReserveTokens,
        triggerThreshold,
      ),
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

  clearInvalidSessionPreferredModels(availableModelIds: readonly string[]): number {
    this.sessionModelCatalog.clearInvalidSessionPreferredModels(availableModelIds)
    if (!this.localDb.isOpen) return 0
    try {
      return clearInvalidSessionPreferredModels(this.localDb.db, availableModelIds)
    } catch (err) {
      log.error('[clearInvalidSessionPreferredModels] 清理失效会话模型失败:', err)
      return 0
    }
  }

  private reconcileStoredSessionModelPreferences(): void {
    const config = this.config.getProviderConfig?.()
    if (!config) return
    const availableModelIds = config.enabled
      ? [config.modelId, ...(config.allowedModelIds ?? [])]
        .map((modelId) => modelId?.trim())
        .filter((modelId): modelId is string => Boolean(modelId))
      : []
    const cleared = this.clearInvalidSessionPreferredModels(availableModelIds)
    if (cleared > 0) {
      log.info(`[reconcileStoredSessionModelPreferences] 已清理 ${cleared} 个失效会话模型覆盖`)
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

  /**
   * 更新全局默认思考偏好（对话页开关）：渠道会话/心跳/cron 等未显式设置过的
   * 会话跟随它；同时落盘，重启后新实例仍继承。
   */
  setGlobalThinkingPrefs(
    patch: Partial<import('./bridge-session-thinking-prefs.js').SessionThinkingPrefs>,
  ) {
    const next = this.sessionThinkingPrefs.setGlobalPrefs(patch)
    saveStoredThinkingPrefs(next)
    return next
  }

  get isEnabled(): boolean { return this.featureFlags.CLIENT_AGENT_RUNTIME }
  getCwd(): string { return this.config.getCwd() }

  /**
   * 段原文归档进记忆宫殿（诉求 A · 宫殿互引）。
   * 由 SegmentMemoryPipeline 的 archivePalace 回调调用：drawer_id 已由 runtime
   * 内容寻址生成并回填，此处把原文 upsert 进宫殿（幂等）。宿主未注入则跳过。
   */
  private async archiveSegmentToPalace(
    text: string,
    meta: ArchivePalaceMeta,
  ): Promise<{ drawerId?: string }> {
    const archive = this.config.archivePalaceDrawer
    if (!archive) return {}
    try {
      const result = await archive({
        content: text,
        wing: meta.wing,
        room: meta.room,
        drawerId: meta.drawerId,
        // 按 (agent, user) 落库做作用域隔离
        agentId: meta.agentId,
        userId: meta.userId,
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

  async createInstance(agentDef?: AgentDefinition, sessionKey?: string, conversationId?: string, options?: { parentInstanceId?: string }): Promise<string> {
    return this.instanceFactory.createInstance(agentDef, sessionKey, conversationId, options)
  }

  registerNodeStreamCallback(instanceId: string, cb: (event: AgentRuntimeEvent) => void): void {
    this.instanceFactory.registerNodeStreamCallback(instanceId, cb)
  }

  unregisterNodeStreamCallback(instanceId: string): void {
    this.instanceFactory.unregisterNodeStreamCallback(instanceId)
  }

  async prompt(
    instanceId: string,
    message: string,
    imageAttachmentPaths?: readonly string[],
    pendingUserMsgId?: string,
  ): Promise<void> {
    try {
      return await this.promptDispatcher.prompt(instanceId, message, imageAttachmentPaths, pendingUserMsgId)
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
  private refreshAllInstanceToolsInternal(): void {
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
  ensureConversationExists(
    conversationId: string,
    title?: string,
    channelType?: string,
    agentParticipantId?: string,
  ): boolean {
    return this.conversationManager.ensureConversationExists(
      conversationId,
      title,
      channelType,
      agentParticipantId,
    )
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

  /** 写入本轮在场状态（P0：二元在场信号），由 SessionManager 在 prompt 前调用 */
  setInstancePresence(
    instanceId: string,
    presence: { userAtClient: boolean; channelLabel?: string; channelType?: string; channelUserId?: string; replyTo?: string },
  ): void {
    const s = this.instanceStates.get(instanceId)
    if (s) s.presence = presence
  }

  /** 等待 Agent 实例进入 idle 状态 */
  async waitForInstanceIdle(instanceId: string): Promise<void> {
    const instance = this.agentRegistry.get(instanceId)
    if (!instance) return
    await instance.waitForIdle()
  }

  /**
   * 从实例内存中提取最新 assistant 正文，供定时任务在 destroy 前回读产出。
   */
  getAssistantOutputFromInstance(instanceId: string): string | null {
    const instance = this.agentRegistry.get(instanceId)
    if (!instance) return null
    const messages = instance.getAgentMessages()
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (!msg || msg.role !== 'assistant') continue
      const text = extractAssistantTextFromAgentMessage(msg.content)
      if (text) return text
    }
    return null
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
  listRecentConversations(
    limit = 10,
  ): readonly { id: string; title: string; updatedAt: string; channelType: string | null }[] {
    return this.conversationManager.listRecentConversations(limit)
  }

  /**
   * 读会话归属渠道（`conversations.channel_type`，10-S2 起落库）。
   *
   * 与「当前路由」（谁在说话）是两件事：用户可以跨渠道续聊同一个会话。
   * 查不到（会话不存在 / 老库未回填）返回 null，由 `resolveChannelIdentity` 回退前缀。
   */
  getConversationOwnership(conversationId: string): string | null {
    try {
      return this.conversationRepo?.getConversation(conversationId)?.channel_type ?? null
    } catch {
      return null
    }
  }
  notifyIncomingMessage(sessionKey: string, text: string, messageId?: string): void { this.lifecycle.notifyIncomingMessage(sessionKey, text, messageId) }
  notifyNavigateToSession(sessionKey: string, title?: string): void { this.lifecycle.notifyNavigateToSession(sessionKey, title) }
  triggerCronNotification(title: string, body: string, convId?: string): void { this.lifecycle.triggerCronNotification(title, body, convId) }
  setLastActiveConversation(sessionKey: string): void { this.lifecycle.setLastActiveConversation(sessionKey) }

  /**
   * 把已落库的自主产出（反思 / 日记）推给渲染层：会话开着时实时可见。
   * 不弹桌面通知——反思与日记只在静默时段产生，弹窗会违反用户设置的静默语义。
   */
  private pushSavedMessage(sessionKey: string, id: string, role: 'user' | 'assistant', text: string): void {
    this.ipcChannel.forwardIpcEvent({
      type: 'conversation:message:new',
      sessionKey,
      message: {
        id: String(id),
        role,
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      },
    })
  }

  /**
   * 记录一次情绪事件：衰减后叠加冲击并落库（best-effort，失败只记日志）。
   *
   * ⚠ **`agentId` 要跟着事件一起发出去**（第四期 T4.4）：在这之前这条 IPC 不带归属，
   * 而唯一的生产者就是 `assistant` 这条线，于是宠物窗把**助手的心情**当成了自己的脸——
   * 宠物是独立 Agent（设计 §3.7），这份心情是谁的必须说清楚，不然渲染层只能猜。
   */
  private recordMoodEvent(event: string, agentId = 'assistant'): void {
    try {
      const now = Date.now()
      const mood = decayMood(readMood(this.localDb.db, agentId, now), now)
      const next = applyMoodImpact(mood, event)
      writeMood(this.localDb.db, agentId, next)
      // Mood 变化后推送桌宠实时表情 + 三维（三维不展示给用户，只喂程序化动画参数）
      const emotion = moodToPetEmotion(next)
      this.ipcChannel.forwardIpcEvent({
        type: 'autonomous:mood:emotion',
        agentId,
        emotion,
        mood: { energy: next.energy, valence: next.valence, arousal: next.arousal },
      })
    } catch (err) {
      log.warn('[recordMoodEvent] 记录情绪事件失败:', err)
    }
  }

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

  listTools(): Array<{ name: string; label: string; description: string; category: string; isReadOnly: boolean; needsPermission: boolean; enabled: boolean }> {
    return this.toolRegistry.getToolStatus()
  }

  getMcpStatus(): McpServerRuntimeStatus[] { return this.mcpManager.getStatus() }

  /**
   * 停止所有 MCP Server 子进程（应用退出时调用，见 `performCleanup`）。
   *
   * `destroyAll()` **不覆盖**这部分：它管的是 agent 实例与调度器，
   * MCP client 由 `mcpManager` 独立持有。漏掉会让子进程拖住 Electron 退出
   * （2026-09-20 Linux 实测：`app.exit(0)` 后仍在重连，GPU watchdog 报 FATAL）。
   */
  stopMcpServers(): Promise<void> { return this.mcpManager.disconnectAll() }

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

  /**
   * session_compact 工具的入口：压缩指定会话的上下文。
   *
   * 与 `/compact` 斜杠命令共用同一套 compactContextAsync（LLM 摘要 + DB 清理 +
   * 内存同步），区别是不经渲染层 —— 渠道场景没有客户端窗口，光发 IPC 事件
   * 等于什么都不发生。
   */
  async compactSessionForTool(
    sessionKey: string,
    keepRecentTurns = 6,
  ): Promise<{ success: boolean; messagesRemoved: number; hadSummary: boolean; error?: string }> {
    if (!this.conversationRepo.getConversation(sessionKey)) {
      return { success: false, messagesRemoved: 0, hadSummary: false, error: `会话不存在：${sessionKey}` }
    }
    // 优先用该会话已挂着的实例：摘要要跑 LLM，需要实例上的模型配置
    const instanceId = this.findInstanceIdForConversation(sessionKey)
    if (!instanceId) {
      // 没有活实例（重启后常见）：降级为同步压缩，无 LLM 摘要
      const r = this.compactContext(sessionKey, keepRecentTurns)
      return { success: r.success, messagesRemoved: r.messagesRemoved, hadSummary: false }
    }
    const r = await this.compactContextAsync(instanceId, sessionKey, keepRecentTurns)
    return { success: r.success, messagesRemoved: r.messagesRemoved, hadSummary: r.hadSummary }
  }

  /** 按会话反查仍存活的实例（instanceToConversation 的反向查找） */
  private findInstanceIdForConversation(sessionKey: string): string | undefined {
    for (const [instanceId, conversationId] of this.instanceToConversation) {
      if (conversationId === sessionKey && this.agentRegistry.get(instanceId)) return instanceId
    }
    return undefined
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
   * 渠道交互通知器：把提问/审批文字化推给渠道用户。
   * 返回 true 表示该会话由渠道承接——此时调用方不得再向渲染进程推送桌面弹窗。
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
   * 渠道主动出站：把**异步**产出（转交完成汇报等）推给渠道会话。
   * 由 ChannelInteractionHub 在构造时注册（回复上下文只有它持有）。
   */
  private channelTextPusher:
    | ((sessionKey: string, text: string) => Promise<boolean>)
    | null = null

  setChannelTextPusher(
    pusher: ((sessionKey: string, text: string) => Promise<boolean>) | null,
  ): void {
    this.channelTextPusher = pusher
  }

  /**
   * 供异步汇报调用：把文本推到该会话所在的渠道。
   * @returns true = 已送达渠道；false = 该会话不在渠道上（或推送失败），调用方自行兜底
   */
  async pushChannelText(sessionKey: string, text: string): Promise<boolean> {
    if (!this.channelTextPusher) return false
    try {
      return await this.channelTextPusher(sessionKey, text)
    } catch (err) {
      log.warn(
        `[pushChannelText] 渠道推送失败 sessionKey=${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
  }

  /**
   * 渲染进程「自动审批」开关的镜像。
   * 开启时审批请求会被渲染进程立刻放行，渠道无需再推文字审批消息（纯噪音）。
   */
  private autoApprove = true

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
        `[notifyChannelInteraction] 渠道通知失败（将回退桌面弹窗）: ${err instanceof Error ? err.message : String(err)}`,
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
  clearIpcQueue(): void { this.ipcChannel.clearIpcQueue() }

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
      log.warn(`[${logTag}] chat 能力槎位缺少 API Key，跳过${cfg.apiKeyDecryptFailed ? '（凭据存在但解密失败）' : ''}`)
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
      // 辅助调用（router/生图意图分类）不传 options.reasoning：qwen 类端点会据此显式
      // 关思考，其余端点不发思考参数——分类任务不该烧思考预算。
      resolveModelProfile: (modelId) => resolveModelThinking(cfg, modelId),
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

  /** 开关切换/设置页改动心跳周期后：同步托管任务状态（enabled 跟随开关）+ 重载调度器 */
  syncEvolutionTickSettings(): void {
    if (!this.localDb) return
    syncAutonomousManagedCronJobs(this.localDb.db, readAutonomousEnabled(this.localDb.db))
    this.cronScheduler?.reloadLocalCronScheduler()
  }

  createLocalCronJobRecord(params: Parameters<CronScheduler['createLocalCronJobRecord']>[0]): void {
    this.cronScheduler.createLocalCronJobRecord(params)
    // IPC 增删改后即时生效：运行中的调度器无 DB 轮询，必须显式重载才能感知新任务
    this.cronScheduler.reloadLocalCronScheduler()
  }

  listLocalCronJobRecords(includeDisabled: boolean): ReturnType<CronScheduler['listLocalCronJobRecords']> {
    return this.cronScheduler.listLocalCronJobRecords(includeDisabled)
  }

  getLocalCronJobRecordById(id: string): ReturnType<CronScheduler['getLocalCronJobRecordById']> {
    return this.cronScheduler.getLocalCronJobRecordById(id)
  }

  deleteLocalCronJobRecord(id: string): number {
    const deleted = this.cronScheduler.deleteLocalCronJobRecord(id)
    this.cronScheduler.reloadLocalCronScheduler()
    return deleted
  }

  updateLocalCronJobRecord(params: Parameters<CronScheduler['updateLocalCronJobRecord']>[0]): number {
    const updated = this.cronScheduler.updateLocalCronJobRecord(params)
    // 表达式/开关变更需要重注册计时器（含重新启用已禁用任务）
    this.cronScheduler.reloadLocalCronScheduler()
    return updated
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

/**
 * 从 pi-agent-core 的 assistant 消息 content 中提取可见正文。
 */
function extractAssistantTextFromAgentMessage(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } => {
      if (!block || typeof block !== 'object') return false
      const part = block as Record<string, unknown>
      return part.type === 'text' && typeof part.text === 'string'
    })
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}
