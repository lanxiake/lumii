/**
 * bash-evolution — bash 命令工具进化（采集 + 挖掘 + 归一化）
 *
 * 管道总览（设计见 docs/plans/2026-09-08-bash-命令工具进化-design.md）：
 * - bash-command-log-hook：ToolRunner 全局 hook，逐条落库命令原文
 * - command-miner：规则归一化 + 聚合 + 过滤（纯函数，粗聚类）
 * - refine-patterns：LLM 精归一化（语义参数名 + 参数说明，失败回退规则模式）
 */

export { createBashCommandLogHook } from "./bash-command-log-hook.js";
export type { BashCommandLogHookDeps } from "./bash-command-log-hook.js";
export {
  mineCommandPatterns,
  normalizeCommand,
  splitCommandChain,
  hasDedicatedTool,
} from "./command-miner.js";
export type {
  CommandSample,
  CommandPattern,
  MinerOptions,
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
