/**
 * Wiki 模块入口
 */

export { wikiRecordsShareFileIdentity } from "./wiki-source-identity.js";
export type { WikiFileIdentity } from "./wiki-source-identity.js";
export { WikiRepo } from "./wiki-repo.js";
export type { WikiSourceSearchHit } from "./wiki-repo.js";

export { WikiCleanupScanner } from "./wiki-cleanup.js";
export type {
  WikiCleanupReason,
  WikiCleanupSuggestion,
  WikiCleanupScanOptions,
} from "./wiki-cleanup.js";

export {
  DEFAULT_EXCLUDED_WIKI_INGEST_EXTENSIONS,
  shouldSkipWikiIngestPath,
  wikiIngestFileExtension,
} from "./wiki-ingest-filter.js";

export { resolveWikiSourceFileExists } from "./wiki-source-exists.js";
export type { WikiSourceExistsChecker } from "./wiki-source-exists.js";

export {
  listBrokenWikiSources,
  purgeBrokenWikiSources,
} from "./wiki-broken-source-purge.js";
export type { WikiBrokenSourcePurgeResult } from "./wiki-broken-source-purge.js";

export {
  listInvalidWikiFiles,
  purgeInvalidWikiFiles,
} from "./wiki-invalid-file-purge.js";
export type { WikiInvalidFilePurgeResult } from "./wiki-invalid-file-purge.js";

export { serializeAttachmentReference, isAttachmentReferenceLine } from "./wiki-attachments.js";

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

export {
  computeForgettingScore,
  rankByForgettingScore,
} from "./wiki-forgetting.js";
export type { ForgettingScoreInput } from "./wiki-forgetting.js";

export {
  WikiEroRepo,
  mergeRelationStrength,
} from "./wiki-ero.js";
export {
  WikiEroExtractor,
  buildEroExtractPrompt,
  parseEroExtractResponse,
  DEFAULT_ERO_EXTRACT_MAX_PAGES,
  DEFAULT_ERO_EXTRACT_MAX_CHARS,
} from "./wiki-ero-extractor.js";
export type { WikiEroExtractSourceScope, WikiEroExtractSourceResult } from "./wiki-ero-extractor.js";
export type {
  WikiEntityType,
  WikiEntity,
  WikiObservation,
  WikiRelation,
} from "./wiki-ero.js";

export {
  createBigramHashEmbedder,
  cosineSimilarity,
  reciprocalRankFusion,
  hashContent,
  DEFAULT_EMBED_MODEL_ID,
  DEFAULT_EMBED_DIMS,
  RRF_K,
} from "./wiki-vector.js";
export type {
  WikiEmbedder,
} from "./wiki-vector.js";

export { WikiSourceVectorIndex, buildVectorCorpus, mergeSourceHybridRanks, VECTOR_CORPUS_MAX_CHARS } from "./wiki-source-vector.js";

export { WikiExporter, sanitizeFilenameSegment, isPathTraversalSafe, resolveUniqueFilename } from "./wiki-exporter.js";
export type {
  WikiExporterDeps,
  WikiExportResult,
  WikiExportFailure,
} from "./wiki-exporter.js";

export { WikiIndexRepo, wikiBigramJoin } from "./wiki-index.js";
export type { WikiFtsHealth } from "./wiki-index.js";

export {
  buildHeuristicSummary,
  buildExtractiveSummary,
  buildSummaryPrompt,
  WikiSummarizer,
  SUMMARY_MAX_CHARS,
  HEURISTIC_MAX_TEXT,
  EXTRACTIVE_MAX_TEXT,
  LLM_HEAD_CHARS,
  LLM_TAIL_CHARS,
} from "./wiki-summary.js";
export type { SummaryResult, SummaryLevel } from "./wiki-summary.js";

export {
  PARKING_CATEGORY,
  TOPIC_CATEGORIES_META_KEY,
  DEFAULT_TOPIC_TREE,
  parseTopicTree,
  validateTopicTree,
  validateTopicAssignment,
  treeHasOrphans,
  topicTreeHasLegacyV1Categories,
  mergeDefaultSubtopics,
} from "./wiki-topic-tree.js";
export type { WikiTopicTree } from "./wiki-topic-tree.js";

export {
  WikiReclassifier,
  RECLASSIFY_CONFIDENCE_THRESHOLD,
} from "./wiki-reclassifier.js";
export type {
  WikiReclassifyCandidate,
  WikiReclassifyRun,
  WikiReclassifyScope,
  WikiReclassifyStatus,
} from "./wiki-reclassify-types.js";

export type {
  WikiMigratePhase,
  WikiMigrateProgress,
  MigrateFolderMapping,
  WikiMigrateRun,
} from "./wiki-migrate-types.js";
export { MIGRATE_RUN_META_KEY } from "./wiki-migrate-types.js";

export { buildMigrateInventory } from "./wiki-migrate-inventory.js";
export type {
  MigrateFolderCluster,
  MigrateInventory,
  BuildMigrateInventoryParams,
} from "./wiki-migrate-inventory.js";

export {
  buildLibraryInventory,
  ANCHOR_SAMPLES_PER_LEAF,
} from "./wiki-library-inventory.js";
export type {
  LibraryInventory,
  LibraryInventoryScope,
  LeafOccupancy,
  InventoryFileRow,
} from "./wiki-library-inventory.js";

export {
  buildLibraryImpression,
  buildStructurePrompt,
  parseStructureResponse,
  buildContentPrompt,
  STRUCTURE_BATCH_SIZE,
  CONTENT_BATCH_SIZE,
} from "./wiki-catalog-prompt.js";
export type { StructureDecision } from "./wiki-catalog-prompt.js";

export {
  titleInfoScore,
  isLowInfoTitle,
  LOW_INFO_THRESHOLD,
  shouldAcceptRenameProposal,
  RENAME_CONFIDENCE_THRESHOLD,
} from "./wiki-title-score.js";

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

export { WikiOrganizer, WIKI_INBOX_ITEM_TYPES } from "./wiki-organizer.js";
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

export { ensureWikiVaultLayout, WIKI_VAULT_LAYOUT_ID } from "./wiki-vault-layout.js";
export type { WikiVaultLayoutFs, WikiVaultLayoutResult } from "./wiki-vault-layout.js";

export {
  syncSourceToVault,
  backfillVaultFromSources,
  resolveVaultDirAbs,
  resolveOriginalFilePath,
  shouldUseRefSidecar,
  removeSourceVaultArtifacts,
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
