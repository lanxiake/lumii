/**
 * Memory 模块入口
 */

export { AgentMemoryRepo } from "./memory-repo.js";
export { MemoryIndexRepo } from "./memory-index.js";
export type { FtsHealth } from "./memory-index.js";

// 自建记忆宫殿（去 Python 依赖）：palace_drawers + FTS5，替代 MemPalace
export { PalaceRepo, buildDrawerExcerpt, SEARCH_EXCERPT_CHARS } from "./palace-repo.js";
export type {
  PalaceClearResult,
  PalaceDrawerDetail,
  PalaceDrawerInput,
  PalaceListItem,
  PalaceListParams,
  PalaceListResult,
  PalaceScopeCounts,
  PalaceSearchItem,
  PalaceSearchParams,
  PalaceWingCount,
} from "./palace-repo.js";
export { PalaceIndexRepo } from "./palace-index.js";
export type { PalaceFtsHealth } from "./palace-index.js";

export { MemoryManager } from "./manager.js";
export type {
  MemoryManagerOptions,
  MemoryProvenance,
  SummarizedSource,
} from "./manager.js";

export {
  contentAddressId,
  deterministicDrawerId,
  DRAWER_ID_HEX_LEN,
  drawerPointerId,
} from "./content-address.js";

// 个人记忆条目化（P1-2）：结构字段（id / 创建日期）由 harness 独占，模型只改正文
export {
  parsePersonalMemory,
  reconcilePersonalMemory,
  stripPersonalMemoryMeta,
} from "./personal-memory-entries.js";
export type { PersonalMemoryEntry } from "./personal-memory-entries.js";

export {
  extractByRules,
  extractByLLM,
  buildExtractionPrompt,
  buildSegmentSummaryPrompt,
  parseCandidatesJson,
  hasMemoryTrigger,
  // 写入侧 schema 门：判据单点定义，写入门与主机侧记忆体检（asset-checkup）共用，
  // 避免两套规则各自漂移（2026-09-17）
  isJsonFragment,
  validateCandidates,
  logRejections,
  MIN_MEMORY_CHARS,
  MAX_MEMORY_CHARS,
} from "./memory-extractor.js";
export type {
  ExistingMemoryContext,
  CandidateRejection,
  CandidateRejectionReason,
  CandidateValidationResult,
} from "./memory-extractor.js";

export {
  formatMemoriesForPrompt,
  formatUserMemoryForPrompt,
  formatUnifiedMemoryBlock,
  injectMemories,
  stripMemoryPlaceholder,
  MEMORY_PLACEHOLDER,
} from "./memory-injector.js";
export type { UnifiedMemoryLimits } from "./memory-injector.js";

export {
  consolidateUserMemory,
  consolidateExistingPersonalMemory,
  buildMemoryConsolidationPrompt,
  needsPersonalMemoryConsolidation,
} from "./memory-consolidation.js";
export type { ConsolidationResult, ConsolidationTrigger } from "./memory-consolidation.js";

export {
  MEMORY_LAYERS,
  MEMORY_LAYER_RULES,
  PERSONAL_MEMORY_CATEGORIES,
  WORK_MEMORY_CATEGORIES,
  buildMemoryArchitectureSection,
  memoryCategoryToLayer,
} from "./memory-architecture.js";
export type { MemoryLayer, MemoryLayerInfo } from "./memory-architecture.js";

export type {
  MemoryCategory,
  MemoryEntry,
  MemoryRow,
  HotMemoryConfig,
  ExtractedCandidate,
  ExtractionOrchestratorConfig,
} from "./types.js";
export { DEFAULT_HOT_MEMORY_CONFIG, isPersonalCategory } from "./types.js";

export { scoreMemory } from "./scorer.js";
export type { MemoryScoreInput } from "./scorer.js";

export {
  computeTemperature,
  DEFAULT_TEMPERATURE_THRESHOLDS,
} from "./temperature.js";
export type {
  MemoryTemperature,
  TemperatureInput,
  TemperatureThresholds,
} from "./temperature.js";
