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

export { WikiGraphBuilder, subtopicNodeId, parseSubtopicNodeId } from "./wiki-graph.js";
export type {
  WikiGraphNodeKind,
  WikiGraphEdgeKind,
  WikiGraphNode,
  WikiGraphEdge,
  WikiGraphData,
  WikiGraphBuildOptions,
  WikiGraphLayer,
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

export {
  WikiFolderImporter,
  type WikiFolderImporterFs,
  type WikiFolderImporterFsEntry,
  type WikiFolderImporterBaseOptions,
  type WikiFolderCandidate,
  type WikiFolderScanResult,
  type WikiFolderImportResult,
} from "./wiki-folder-importer.js";

export { WikiOrganizer } from "./wiki-organizer.js";
export type { WikiOrganizerHooks } from "./wiki-organizer.js";

export {
  WIKI_NAV_SECTIONS,
  WIKI_PARKING_DIR,
  WIKI_META_DIR,
  navIdFromLegacyCategory,
  legacyCategoriesForNav,
  primaryLegacyCategoryForNav,
  navLabel,
  folderSlugForNavId,
  vaultDirSegmentsForSource,
} from "./wiki-nav-map.js";
export type { WikiNavId, WikiNavSectionDef } from "./wiki-nav-map.js";

export {
  WIKI_REF_KIND,
  WIKI_REF_VERSION,
  FILE_REF_EXT,
  URL_REF_EXT,
  isVaultRefPath,
  buildFileRefDoc,
  buildUrlRefDoc,
  parseRefDocument,
  readRefTarget,
  writeFileRef,
  writeUrlRef,
  moveRefFile,
} from "./wiki-ref-store.js";
export type { WikiRefDocument, WikiRefStoreFs, WikiRefType } from "./wiki-ref-store.js";

export { ensureWikiVaultLayout } from "./wiki-vault-layout.js";
export type { WikiVaultLayoutFs, WikiVaultLayoutResult } from "./wiki-vault-layout.js";

export {
  syncSourceToVault,
  backfillVaultFromSources,
  resolveVaultDirAbs,
  resolveOriginalFilePath,
  shouldUseRefSidecar,
} from "./wiki-vault-sync.js";
export type { WikiVaultFs, WikiVaultSyncDeps, WikiVaultSyncResult } from "./wiki-vault-sync.js";

export { WikiClipSaver } from "./wiki-clip-saver.js";
export type { WikiClipSaverDeps, WikiClipResult } from "./wiki-clip-saver.js";

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
export type { ClassifiedItem, WikiClassifyContext } from "./wiki-classifier.js";

export {
  buildFolderImportClassifyContext,
  buildDirectoryTreeText,
  buildTopicOccupancySummary,
  buildNavSectionGuide,
} from "./wiki-classify-context.js";
export type { BuildFolderImportContextParams } from "./wiki-classify-context.js";

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
} from "./types.js";

export { parseWikilinks } from "./wiki-link-parser.js";
export type { ParsedWikilink } from "./wiki-link-parser.js";

export { resolveWikilinkTarget } from "./wiki-link-resolver.js";
export type { WikilinkCandidatePage, WikilinkResolution } from "./wiki-link-resolver.js";

export { diffLines } from "./line-diff.js";
export type { DiffLine, DiffLineType } from "./line-diff.js";
