/**
 * bash-evolution — bash 命令工具进化（采集 + 挖掘 + 归一化）
 *
 * 管道总览（设计见 docs/plans/2026-09-08-bash-命令工具进化-design.md）：
 * - bash-command-log-hook：ToolRunner 全局 hook，逐条落库命令原文
 * - command-miner：规则归一化 + 聚合 + 过滤（纯函数，粗聚类）+ 高频价值筛选
 * - refine-patterns：LLM 精归一化（兼容保留；主路径已合并进 tool-drafter 单次调用）
 * - tool-drafter：单次 LLM 草拟参数化工具（含语义化模板）
 */

export { createBashCommandLogHook } from "./bash-command-log-hook.js";
export type { BashCommandLogHookDeps } from "./bash-command-log-hook.js";
export {
  mineCommandPatterns,
  normalizeCommand,
  splitCommandChain,
  hasDedicatedTool,
  selectHighValuePatterns,
  DEFAULT_MIN_COUNT_EXCLUSIVE,
  DEFAULT_TOP_N_FOR_LLM,
} from "./command-miner.js";
export type {
  CommandSample,
  CommandPattern,
  MinerOptions,
  HighValuePatternOptions,
} from "./command-miner.js";
export { refinePatternWithLLM } from "./refine-patterns.js";
export type { RefinedPattern, RefinePatternDeps } from "./refine-patterns.js";
export { draftToolFromPattern, buildDraftPrompt } from "./tool-drafter.js";
export type { ToolDraft, DraftToolDeps } from "./tool-drafter.js";
export {
  checkToolDraft,
  sampleReplayRate,
  openTemplateRejectionReason,
} from "./tool-quality-gate.js";
export type { QualityGateResult } from "./tool-quality-gate.js";
