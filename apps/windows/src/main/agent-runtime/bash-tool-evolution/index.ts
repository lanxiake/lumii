/**
 * bash-tool-evolution — bash 命令工具进化（宿主装配）
 *
 * 详见 docs/design/Agent协作与提示词/2026-09-08-Bash命令工具进化设计.md
 */

export {
  ToolEvolutionEngine,
  buildApprovalPrompt,
  clampTriggerThreshold,
  DEFAULT_TRIGGER_THRESHOLD,
  DEFAULT_CHECK_INTERVAL_MS,
  MIN_TRIGGER_THRESHOLD,
  MAX_TRIGGER_THRESHOLD,
  TRIGGER_THRESHOLD_KEY,
  LAST_MINING_AT_KEY,
  WEEK_MS,
} from './tool-evolution-engine'
export type { ToolEvolutionEngineDeps, MiningSummary } from './tool-evolution-engine'
export {
  loadPendingDrafts,
  savePendingDrafts,
  saveApprovedTool,
  loadApprovedTools,
  loadStoredTools,
  updateToolStatus,
  removeApprovedTool,
  resolveToolsDir,
} from './tool-writer'
export type { StoredToolDefinition, PendingToolDraft } from './tool-writer'
