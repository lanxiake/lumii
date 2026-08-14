/**
 * @mtbot/agent-runtime — 客户端 Agent Runtime 核心包
 *
 * 驱动 pi-agent-core 在客户端本地运行 Agent 循环。
 */

// === 类型导出 ===
export type {
  MtBotTool,
  ToolCategory,
  ToolExecutionContext,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  AgentDefinition,
  AgentToolPermissions,
  AgentSourceType,
  ModelTier,
  EffortValue,
  MemoryConfig,
  ProactivityConfig,
  ProactivityTrigger,
  AgentHooksConfig,
  AgentHook,
  AgentRuntimeEvent,
  AgentInstanceState,
} from "./types/index.js";
export {
  BUILT_IN_AGENTS,
  findBuiltInAgent,
  BUILTIN_AGENT_ID_PREFIX,
  isBuiltInSubAgentId,
  mapAgentEvent,
} from "./types/index.js";

// === 配置导出 ===
export type { AgentRuntimeConfig, AgentRuntimeFeatureFlags } from "./config/index.js";
export {
  DEFAULT_FEATURE_FLAGS,
  createFeatureFlags,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_ACTIVE_MEMORIES,
  AUTO_VACUUM_THRESHOLD_BYTES,
  DEFAULT_RETENTION_DAYS,
} from "./config/index.js";

// === 工具系统导出 ===
export {
  ToolRegistry,
  ToolRunner,
  wrapMtBotToolsWithRunner,
  createLoggingHook,
  createCacheHook,
  createReadBeforeWriteHook,
  createToolResultPersistHook,
  getFileStateCache,
  FileStateCache,
  normalizeFilePathKey,
  persistLargeResult,
  ToolTelemetryCollector,
  reportToolMetrics,
  ALL_BUILT_IN_TOOL_CONFIGS,
  createMtBotTool,
  resolveAgentFilePath,
} from "./tools/index.js";
export type {
  MtBotToolConfig,
  ToolHook,
  ToolHookContext,
  ToolHookResultContext,
  ToolHookErrorContext,
  ToolRunLifecycle,
  ToolRunnerLogger,
  FileStateEntry,
  ToolMetric,
  ToolMetricAggregate,
  TelemetrySink,
} from "./tools/index.js";
export {
  todoWriteToolConfig,
  spawnAgentToolConfig,
  sendMessageToolConfig,
  cronCreateToolConfig,
  cronListToolConfig,
  cronDeleteToolConfig,
  dashboardFeedWriteToolConfig,
  messageToolConfig,
  nodesToolConfig,
  memorySearchToolConfig,
  memoryReadToolConfig,
  profileMemoryToolConfig,
  systemPromptToolConfig,
  speechGenerateToolConfig,
  imageGenerateToolConfig,
  DEFAULT_IMAGE_MODEL_ID,
  IMAGE_GENERATION_MODEL_OPTIONS,
  isKnownImageGenerationModel,
  normalizeImageModelId,
  type ImageGenerationModelOption,
  skillListToolConfig,
  skillSearchToolConfig,
  skillInvokeToolConfig,
  sessionCreateToolConfig,
  sessionClearToolConfig,
  sessionCompactToolConfig,
  sessionResumeToolConfig,
  settingsThinkToolConfig,
  settingsBackendToolConfig,
  infoStatusToolConfig,
  memoryManageToolConfig,
  agentTeamGenerateToolConfig,
  agentTeamOptimizeToolConfig,
  agentRemoveToolConfig,
} from "./tools/built-in/index.js";

export { normalizeCacheKey, DEFAULT_CACHE_TTL_MINUTES } from "./tools/built-in/web-shared.js";

// === LLM 代理层导出 ===
export {
  createGatewayStreamFn,
  DEFAULT_GATEWAY_STREAM_PATH,
  gatewayErrorFromHttpResponse,
  type AssistantMessageWithLlmError,
  type GatewayLlmErrorDetail,
  type GatewayStreamConfig,
  type GatewayStreamDiagnostic,
  type StreamMetadata,
} from "./llm/index.js";
export { ModelRouter } from "./llm/index.js";
export {
  createDirectStreamFn,
  type DirectStreamCredentials,
  type CreateDirectStreamFnOptions,
} from "./llm/index.js";

// === Agent 生命周期导出 ===
export {
  AgentInstance,
  type AgentInstanceConfig,
  type AgentLifecycleCallbacks,
} from "./agent/index.js";
export { AgentRegistry, type AgentRegistryCreateConfig } from "./agent/index.js";
export { mapApiRecordToAgentDefinition } from "./agent/index.js";
export {
  AgentDefinitionStore,
  type AgentDefinitionStoreOptions,
  type DefinitionSyncStatus,
} from "./agent/index.js";
export {
  HookExecutor,
  type HookContext,
  type HookResult,
  type CommandExecutor,
} from "./agent/index.js";
export { ProactivityScheduler, type TriggerCallback } from "./agent/index.js";
export {
  createTransformContext,
  estimateTokenCount,
  microcompactToolResults,
  resolveManualCompactKeepCount,
  buildCompactSummaryPrompt,
  formatCompactSummary,
  NO_TOOLS_PREAMBLE,
  NO_TOOLS_TRAILER,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  DEFAULT_KEEP_RECENT_TURNS,
  type CompactConfig,
  type CompactionInfo,
  type SummaryGeneratorFn,
} from "./agent/index.js";
export {
  estimateTextTokenCount,
  ceilTokenEstimate,
  providerPromptTokens,
} from "./agent/index.js";
export {
  AgentOrchestrator,
  type AgentOrchestratorDeps,
  type SpawnAgentParams,
  type SpawnAgentResult,
  parseVerdict,
  formatVerdictBanner,
  type Verdict,
  type ParsedVerdict,
  shouldNudgeVerification,
  VERIFICATION_NUDGE_TEXT,
  type NudgeTaskLike,
  createVerificationGateHook,
} from "./agent/index.js";

// === 存储层导出 ===
export {
  LocalDatabase,
  withTransaction,
  createMemoryDatabase,
  ConversationRepo,
  TaskRepo,
  AuditRepo,
  RuntimeStateRepo,
  SCHEMA_VERSION,
  verifyDatabaseIntegrity,
  runBackupNow,
  tryRestoreFromLatestBackup,
  restoreDatabaseFromBackup,
  listDatabaseBackups,
  deleteDatabaseBackup,
  startScheduledDatabaseBackup,
  stopScheduledDatabaseBackup,
  getLocalStorageStats,
  exportLocalDataAsJSONL,
  maybeRunAutoVacuumSync,
  parseMessageContentJson,
  messageRowToAgentMessages,
  FileRepo,
  applyAssistantPartEvent,
  finalizeAssistantParts,
  diffTurnSnapshots,
} from "./storage/index.js";
export type {
  DatabaseAdapter,
  PreparedStatement,
  StatementResult,
  LocalDatabaseOptions,
  ConversationRow,
  MessageRow,
  PiMessage,
  PaginatedResult,
  TaskRow,
  TaskStatus,
  AuditLogRow,
  LocalStorageStats,
  DatabaseBackupInfo,
  ClientFile,
  FileSourceType,
  FileCategory,
  RegisterFileParams,
  ListFilesOpts,
  SearchFilesOpts,
  AssistantPart,
  AssistantPartEvent,
  AssistantPartsContent,
  FileChangeEntry,
  TurnFileSnapshot,
  ApplyAssistantPartEventOptions,
} from "./storage/index.js";

// === 记忆系统导出 ===
export {
  AgentMemoryRepo,
  MemoryManager,
  extractByRules,
  extractByLLM,
  buildExtractionPrompt,
  buildSegmentSummaryPrompt,
  parseCandidatesJson,
  hasMemoryTrigger,
  formatMemoriesForPrompt,
  formatUserMemoryForPrompt,
  formatUnifiedMemoryBlock,
  injectMemories,
  consolidateUserMemory,
  consolidateExistingPersonalMemory,
  buildMemoryConsolidationPrompt,
  needsPersonalMemoryConsolidation,
  buildMemoryArchitectureSection,
  MEMORY_LAYERS,
  MEMORY_LAYER_RULES,
  DEFAULT_HOT_MEMORY_CONFIG,
  isPersonalCategory,
  contentAddressId,
  deterministicDrawerId,
  DRAWER_ID_HEX_LEN,
} from "./memory/index.js";
export type {
  ExistingMemoryContext,
  ConsolidationResult,
  ConsolidationTrigger,
  MemoryProvenance,
  SummarizedSource,
} from "./memory/index.js";
export { SegmentMemoryPipeline } from "./memory/segment-memory-pipeline.js";
export type {
  SegmentMemoryPipelineDeps,
  ArchivePalaceMeta,
} from "./memory/segment-memory-pipeline.js";
export { SegmentTracker } from "./memory/segment-tracker.js";
export { SummarizationQueue } from "./memory/summarization-queue.js";
export { SegmentRepo } from "./storage/segment-repo.js";
export type { MemorySegment, SegmentStatus } from "./storage/segment-repo.js";
export type {
  MemoryCategory,
  MemoryEntry,
  MemoryRow,
  HotMemoryConfig,
  ExtractedCandidate,
  ExtractionOrchestratorConfig,
  MemoryManagerOptions,
} from "./memory/index.js";

// === 消息系统导出 ===
export {
  MessageBus,
  isStructuredMessage,
  normalizeMessage,
  serializeMessage,
  parseStructuredMessage,
} from "./messaging/index.js";
export type {
  AgentBusMessage,
  TextMessage,
  ShutdownRequest,
  ShutdownResponse,
  TaskNotification,
  PlanApprovalRequest,
  PlanApprovalResponse,
  StructuredMessage,
} from "./messaging/index.js";

// === MCP 工具代理导出 ===
export { McpStdioClient, loadMcpTools } from "./tools/mcp/index.js";
export type { McpServerConfig, McpToolDefinition } from "./tools/mcp/index.js";

// === 系统提示词构建导出 ===
export {
  buildClientSystemPrompt,
  buildClientSystemPromptStructured,
  filterAgentsForCollaborationPrompt,
  CACHE_BOUNDARY_MARKER,
  MEMORY_GUIDE_CONTENT,
  TASK_GUIDE_CONTENT,
  A2UI_GUIDE_CONTENT,
  type ClientSystemPromptParams,
  type SystemPromptResult,
  type ActiveTaskInfo,
  type PromptDetail,
  type SkillInfo,
  type SkillActivationHint,
  type CustomAgentInfo,
  type RouterResultLite,
  type WorkspaceLayout,
  type ContextFile,
  type UserDeviceInfo,
  type McpServerHint,
} from "./prompt/index.js";

// === 技能激活解析器（v12 扩展） ===
export { resolveSkillActivations, type ActivationContext } from "./skill/index.js";

// === ask_user_question 工具类型（v12 扩展） ===
export type { AskUserQuestionContextInput, AskUserQuestionContextResult } from "./types/index.js";
export {
  askUserQuestionToolConfig,
  formatAskUserQuestionResult,
  type AskUserQuestionInput,
  type AskUserQuestionQuestion,
  type AskUserQuestionOption,
  type AskUserQuestionAnswer,
} from "./tools/built-in/index.js";

// === 安全与权限导出 ===
export type {
  PermissionMode,
  ExternalPermissionMode,
  PermissionBehavior,
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionRule,
  PermissionDecision,
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDenyDecision,
  PermissionDecisionReason,
  PermissionUpdate,
  ToolPermissionChecker,
  ToolPermissionContext,
  RulesBySource,
  PermissionCheckResult,
  ParameterizedToolPermission,
  ToolParamConstraint,
} from "./security/index.js";
export {
  RULE_SOURCE_PRIORITY,
  WRITE_TOOL_NAMES,
  createPermissionContext,
  addRules,
  withMode,
  encodeRuleKey,
  decodeRuleKey,
  findMatchingRule,
  buildChildPermissionContext,
  checkPermission,
  resolveChildPermissionMode,
  filterToolsForReadOnly,
  parseToolPermissionSpec,
  extractToolName,
  matchesParameterizedPermission,
  checkParameterConstraints,
  validatePath,
  normalizePath,
  sanitizeEnv,
  isSensitiveEnvKey,
  listSensitiveEnvKeys,
  PermissionMemory,
  DEFAULT_PERMISSION_MEMORY_MS,
} from "./security/index.js";

// === Shell 执行策略导出（主题4 P1）===
export {
  BashProvider,
  PowerShellProvider,
  CmdProvider,
  resolveShell,
  winToPosix,
  posixToWin,
} from "./shell/index.js";
export type {
  ShellProvider,
  ShellKind,
  ShellEncoding,
  ResolvedShell,
  ResolveShellOptions,
} from "./shell/index.js";

// === host-kit 宿主装配层导出（阶段 A）===
export type {
  EventSink,
  PermissionProvider,
  PermissionRequest,
  PermissionDecisionOutcome,
  ConfigProvider,
  ProviderSource,
  ProviderCredentials,
  ModelOverride,
  ResolvedModel,
  StreamFnKind,
  StreamFnContext,
  StreamFnFactory,
  PromptContextProvider,
  AssembleAgentOptions,
  AssembledAgent,
} from "./host-kit/index.js";
export {
  createStreamFnFactory,
  createGatewayStreamFnFactory,
  createDirectStreamFnFactory,
} from "./host-kit/index.js";
export type {
  GatewayStreamFnFactoryConfig,
  DirectStreamFnFactoryConfig,
} from "./host-kit/index.js";
export { assembleTools, filterToolsByDefinition, createPermissionGateHook } from "./host-kit/index.js";
export type {
  AssembleToolsOptions,
  AssembledTools,
  PermissionGateHookDeps,
  ToolAuditRow,
} from "./host-kit/index.js";
export { assembleSystemPrompt } from "./host-kit/index.js";
export type {
  AssembleSystemPromptOptions,
  AssembledSystemPrompt,
  SystemPromptBuilder,
} from "./host-kit/index.js";
export { assembleAgent } from "./host-kit/index.js";
export type { AssembleAgentRuntime, AssembledAgentResult } from "./host-kit/index.js";
