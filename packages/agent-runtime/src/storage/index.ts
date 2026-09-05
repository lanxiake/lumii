/**
 * Storage 模块入口
 */

export { LocalDatabase, withTransaction, createMemoryDatabase } from "./local-database.js";
export type {
  DatabaseAdapter,
  PreparedStatement,
  StatementResult,
  LocalDatabaseOptions,
} from "./local-database.js";

export { ConversationRepo } from "./conversation-repo.js";
export type {
  ConversationRow,
  MessageRow,
  PiMessage,
  PiContentBlock,
  PaginatedResult,
  MessagePageCursor,
  MessagePage,
  MessageContentJson,
  TextMessageContent,
  ToolResultContent,
  ToolCallRecord,
} from "./conversation-repo.js";
export { parseMessageContentJson, messageRowToAgentMessages } from "./conversation-repo.js";

export { TaskRepo } from "./task-repo.js";
export type { TaskRow, TaskStatus } from "./task-repo.js";

export { AuditRepo } from "./audit-repo.js";
export type { AuditLogRow } from "./audit-repo.js";

export { RuntimeStateRepo } from "./runtime-state-repo.js";

export { AutonomousRepo } from "./autonomous-repo.js";
export type {
  SatisfactionRow,
  GoalRow,
  CapabilityRow,
  ReflectionRow,
  PromptVariantRow,
} from "./autonomous-repo.js";

export { SegmentRepo } from "./segment-repo.js";
export type {
  MemorySegment,
  SegmentRow,
  SegmentStatus,
  CreateSegmentParams,
  AppendSegmentParams,
} from "./segment-repo.js";

export { SCHEMA_VERSION, MIGRATIONS } from "./schema.js";

export {
  isEnabledForSession,
  filterEnabledForSession,
  readSessionConfig,
  patchSessionConfig,
  clearInvalidSessionPreferredModels,
  toggleSessionDisabled,
} from "./session-config.js";
export type { SessionConfig } from "./session-config.js";

export { FileRepo } from "./file-repo.js";
export type {
  ClientFile,
  ClientFileRow,
  FileSourceType,
  FileCategory,
  RegisterFileParams,
  ListFilesOpts,
  SearchFilesOpts,
} from "./file-repo.js";

export {
  verifyDatabaseIntegrity,
  runBackupNow,
  pruneOldBackups,
  tryRestoreFromLatestBackup,
  restoreDatabaseFromBackup,
  listDatabaseBackups,
  findLatestBackupPath,
  deleteDatabaseBackup,
  deleteSqliteSidecarFiles,
  startScheduledDatabaseBackup,
  stopScheduledDatabaseBackup,
  msUntilNextLocalHour,
} from "./backup.js";
export type { DatabaseBackupInfo } from "./backup.js";

export {
  getLocalStorageStats,
  exportLocalDataAsJSONL,
  maybeRunAutoVacuumSync,
} from "./storage-stats.js";
export type { LocalStorageStats } from "./storage-stats.js";

export {
  applyAssistantPartEvent,
  finalizeAssistantParts,
  diffTurnSnapshots,
} from "./assistant-parts.js";
export type {
  AssistantPart,
  AssistantPartEvent,
  AssistantPartsContent,
  FileChangeEntry,
  TurnFileSnapshot,
  ApplyAssistantPartEventOptions,
} from "./assistant-parts.js";
