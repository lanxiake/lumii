/**
 * Wiki 模块入口
 */

export { WikiRepo } from "./wiki-repo.js";
export type { WikiSearchHit } from "./wiki-repo.js";

export { WikiIndexRepo, wikiBigramJoin } from "./wiki-index.js";
export type { WikiFtsHealth } from "./wiki-index.js";

export { WikiIngestHook } from "./wiki-ingest-hook.js";

export { WikiOrganizer } from "./wiki-organizer.js";

export { WikiOrganizeQueue, computeBackoffDelayMs, MAX_ORGANIZE_ATTEMPTS } from "./wiki-organize-queue.js";

export { WikiContentExtractor } from "./wiki-content-extractor.js";
export type { WikiContentExtractorDeps, ExtractInput } from "./wiki-content-extractor.js";

export {
  buildClassifyPrompt,
  parseClassifyResponse,
  classifyBatch,
} from "./wiki-classifier.js";
export type { ClassifiedItem } from "./wiki-classifier.js";

export {
  generateWikiId,
  validateWikiPath,
  AI_WRITABLE_CATEGORIES,
} from "./types.js";
export type {
  WikiCategory,
  WikiMediaType,
  WikiInboxItemType,
  WikiInboxStatus,
  WikiInboxItem,
  WikiSource,
  WikiPage,
  WikiPageRevision,
  WikiRevisionEditor,
  WikiOrganizeRun,
  WikiOrganizeRunStatus,
} from "./types.js";
