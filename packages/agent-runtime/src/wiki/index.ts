/**
 * Wiki 模块入口
 */

export { WikiRepo } from "./wiki-repo.js";
export type { WikiSearchHit, WikiSourceSearchHit } from "./wiki-repo.js";

export { WikiCleanupScanner } from "./wiki-cleanup.js";
export type {
  WikiCleanupReason,
  WikiCleanupSuggestion,
  WikiCleanupScanOptions,
} from "./wiki-cleanup.js";

export { serializeAttachmentReference, isAttachmentReferenceLine } from "./wiki-attachments.js";

export { WikiConceptCandidateScanner, buildConceptScanPrompt } from "./wiki-concept-candidate.js";
export type { WikiConceptType, WikiConceptCandidate } from "./wiki-concept-candidate.js";

export {
  WikiSynthesizer,
  chunkByParagraphs,
  truncateSynthesis,
  buildSynthesisFilename,
  resolveUniqueFilename,
  buildAcceptedSynthesisPageMd,
  parseSynthesisProgress,
  SYNTHESIS_CHUNK_SIZE,
  SYNTHESIS_MAX_OUTPUT_CHARS,
  SYNTHESIS_MAX_CHUNKS,
} from "./wiki-synthesizer.js";
export type {
  WikiSynthesizerFsDeps,
  WikiSynthesizeOptions,
  WikiSynthesizeDirectOptions,
} from "./wiki-synthesizer.js";

export {
  AUTO_SYNTHESIS_CATEGORIES,
  WikiAutoSynthesisRunner,
  autoSynthesisPath,
  selectPagesForAutoSynthesis,
} from "./wiki-auto-synthesis.js";
export type {
  AutoSynthesisCategory,
  AutoSynthesizeCategoryResult,
  AutoSynthesisRunResult,
  AutoSynthesizeAllResult,
} from "./wiki-auto-synthesis.js";

export { WikiGraphBuilder } from "./wiki-graph.js";
export type {
  WikiGraphNodeKind,
  WikiGraphEdgeKind,
  WikiGraphNode,
  WikiGraphEdge,
  WikiGraphData,
  WikiGraphBuildOptions,
} from "./wiki-graph.js";

export { WikiPageStatusScanner } from "./wiki-page-status.js";
export type {
  WikiStatusScanReason,
  WikiPageStatusCandidate,
  WikiPageStatusScanOptions,
} from "./wiki-page-status.js";

export {
  computeForgettingScore,
  rankByForgettingScore,
} from "./wiki-forgetting.js";
export type { ForgettingScoreInput } from "./wiki-forgetting.js";

export {
  WikiEroRepo,
  bootstrapEroFromWikilinks,
  mergeRelationStrength,
} from "./wiki-ero.js";
export {
  WikiEroExtractor,
  buildEroExtractPrompt,
  parseEroExtractResponse,
  DEFAULT_ERO_EXTRACT_MAX_PAGES,
  DEFAULT_ERO_EXTRACT_MAX_CHARS,
} from "./wiki-ero-extractor.js";
export type { WikiEroExtractResult } from "./wiki-ero-extractor.js";
export type {
  WikiEntityType,
  WikiEntity,
  WikiObservation,
  WikiRelation,
} from "./wiki-ero.js";

export {
  WikiVectorIndex,
  createBigramHashEmbedder,
  cosineSimilarity,
  reciprocalRankFusion,
  mergeHybridRanks,
  hashContent,
  DEFAULT_EMBED_MODEL_ID,
  DEFAULT_EMBED_DIMS,
  RRF_K,
} from "./wiki-vector.js";
export type {
  WikiEmbedder,
  WikiHybridSearchHit,
  WikiHybridSearchResult,
} from "./wiki-vector.js";

export { WikiSourceVectorIndex, mergeSourceHybridRanks } from "./wiki-source-vector.js";

export { WikiExporter, sanitizeFilenameSegment, isPathTraversalSafe } from "./wiki-exporter.js";
export type {
  WikiExporterDeps,
  WikiExportOptions,
  WikiExportResult,
  WikiExportFailure,
} from "./wiki-exporter.js";

export { WikiIndexRepo, wikiBigramJoin } from "./wiki-index.js";
export type { WikiFtsHealth } from "./wiki-index.js";

export {
  PARKING_CATEGORY,
  TOPIC_CATEGORIES_META_KEY,
  DEFAULT_TOPIC_TREE,
  parseTopicTree,
  validateTopicTree,
  validateTopicAssignment,
  treeHasOrphans,
} from "./wiki-topic-tree.js";
export type { WikiTopicTree } from "./wiki-topic-tree.js";

export {
  WikiReclassifier,
  buildReclassifyPrompt,
  parseReclassifyResponse,
  RECLASSIFY_BATCH_SIZE,
  RECLASSIFY_RUN_META_KEY,
} from "./wiki-reclassifier.js";
export type {
  WikiReclassifyCandidate,
  WikiReclassifyRun,
  WikiReclassifyScope,
  WikiReclassifyStatus,
} from "./wiki-reclassify-types.js";

export { GRAPH_EXTRACT_CURSOR_META_KEY } from "./wiki-graph-types.js";
export type { WikiGraphExtractCursor } from "./wiki-graph-types.js";

export { planTopicMutation, topicCountKey, DEFAULT_NEW_SUBTOPIC } from "./wiki-topic-mutate.js";
export type {
  FileDisposition,
  WikiTopicMutation,
  TopicCascade,
  TopicMutationPlan,
} from "./wiki-topic-mutate.js";

export { WikiIngestHook } from "./wiki-ingest-hook.js";

export { WikiOrganizer } from "./wiki-organizer.js";

export { WikiOrganizeQueue, computeBackoffDelayMs, MAX_ORGANIZE_ATTEMPTS } from "./wiki-organize-queue.js";

export {
  WikiContentExtractor,
  isTextReadablePath,
  MAX_EXTRACT_BYTES,
} from "./wiki-content-extractor.js";
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
  WikiPageStatus,
  WikiPageRevision,
  WikiRevisionEditor,
  WikiOrganizeRun,
  WikiOrganizeRunStatus,
  WikiOrganizeRunDetailItem,
  WikiOrganizeRunDetailOutcome,
  WikiOrganizeRunDetailExtract,
  WikiLink,
  WikiBacklink,
  WikiAttachment,
  WikiSynthesis,
  WikiSynthesisStatus,
} from "./types.js";

export { parseWikilinks } from "./wiki-link-parser.js";
export type { ParsedWikilink } from "./wiki-link-parser.js";

export { resolveWikilinkTarget } from "./wiki-link-resolver.js";
export type { WikilinkCandidatePage, WikilinkResolution } from "./wiki-link-resolver.js";

export { diffLines } from "./line-diff.js";
export type { DiffLine, DiffLineType } from "./line-diff.js";
