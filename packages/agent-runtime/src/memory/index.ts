/**
 * Memory 模块入口
 */

export { AgentMemoryRepo } from "./memory-repo.js";

export { MemoryManager } from "./manager.js";
export type {
  MemoryManagerOptions,
  MemoryProvenance,
  SummarizedSource,
} from "./manager.js";

export { contentAddressId, deterministicDrawerId, DRAWER_ID_HEX_LEN } from "./content-address.js";

export {
  extractByRules,
  extractByLLM,
  buildExtractionPrompt,
  buildSegmentSummaryPrompt,
  parseCandidatesJson,
  hasMemoryTrigger,
} from "./memory-extractor.js";
export type { ExistingMemoryContext } from "./memory-extractor.js";

export {
  formatMemoriesForPrompt,
  formatUserMemoryForPrompt,
  formatUnifiedMemoryBlock,
  injectMemories,
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
