/**
 * compact 子系统 —— 统一门面
 *
 * 上下文压缩子系统的唯一对外入口。与 memory/ 子系统同级。
 *
 * 设计文档: .qoder/design/agent-context-compact/
 */

// === 主入口 ===
export { createTransformContext } from "./transform-context.js";

// === 类型 ===
export type {
  CompactConfig,
  CompactionInfo,
  SummaryGeneratorFn,
  CompactStrategy,
  CompactStageResult,
  TokenEstimation,
  ActiveTaskInfo,
  ResumeMode,
  PartialDirection,
  SummaryPromptOptions,
  LlmSummaryMessageOptions,
} from "./types.js";

// === 常量 ===
export {
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  DEFAULT_MICRO_COMPACT_RATIO,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_KEEP_RECENT_TURNS,
  COMPACTABLE_TOOLS,
} from "./types.js";

// === token 估算（基础设施，供 token-budget 等复用） ===
export { estimateTokenCount, estimateTextTokenCount, ceilTokenEstimate } from "./token-estimate.js";

// === 策略（供测试 / 高级宿主直接调用） ===
export { microcompactToolResults } from "./strategies/micro-compact.js";

// === 提示词（供宿主自定义摘要时复用） ===
export {
  buildCompactSummaryPrompt,
  buildPartialSummaryPrompt,
  formatCompactSummary,
  NO_TOOLS_PREAMBLE,
  NO_TOOLS_TRAILER,
} from "./summary-prompt.js";
export { buildLlmSummaryMessage, createFallbackPlaceholder } from "./summary-message.js";

// === 压缩后处理（B4） ===
export { RecompactionTracker } from "./post-compact.js";
export type { PostCompactRebuild, PostCompactContext } from "./post-compact.js";

// === 会话文件/技能索引（压缩后重建，兜底摘要遗漏） ===
export { SessionActivityIndex, buildActivityIndexAttachment } from "./session-index.js";
export type { FileOp, FileIndexEntry, SkillIndexEntry } from "./session-index.js";
