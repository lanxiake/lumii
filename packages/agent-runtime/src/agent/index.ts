export {
  AgentInstance,
  type AgentInstanceConfig,
  type AgentLifecycleCallbacks,
} from "./agent-instance.js";
export { AgentRegistry, type AgentRegistryCreateConfig } from "./agent-registry.js";
export { mapApiRecordToAgentDefinition } from "./api-agent-mapper.js";
export {
  AgentDefinitionStore,
  type AgentDefinitionStoreOptions,
  type DefinitionSyncStatus,
} from "./definition-store.js";
export {
  BUILTIN_AGENT_DEFINITIONS,
  BUILTIN_AGENT_ID_PREFIX,
  findBuiltInAgent,
  isBuiltInSubAgentId,
} from "./builtin/definitions.js";
export {
  HookExecutor,
  type HookContext,
  type HookResult,
  type CommandExecutor,
} from "./hook-executor.js";
export { ProactivityScheduler, type TriggerCallback } from "./proactivity-scheduler.js";
export {
  createTransformContext,
  estimateTokenCount,
  microcompactToolResults,
  resolveManualCompactKeepCount,
  buildCompactSummaryPrompt,
  formatCompactSummary,
  NO_TOOLS_PREAMBLE,
  NO_TOOLS_TRAILER,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  DEFAULT_KEEP_RECENT_TURNS,
  shouldIdleCompact,
  decideIdleCooldownMs,
  IDLE_COOLDOWN_FAILURE_MS,
  IDLE_COOLDOWN_LOW_YIELD_MS,
  ProgressFence,
  withProgressTimeout,
  type CompactConfig,
  type CompactionInfo,
  type SummaryGeneratorFn,
} from "../compact/index.js";
export {
  estimateTextTokenCount,
  ceilTokenEstimate,
  providerPromptTokens,
} from "../compact/index.js";
export {
  AgentOrchestrator,
  type AgentOrchestratorDeps,
  type SpawnAgentParams,
  type SpawnAgentResult,
} from "./orchestrator.js";
export {
  parseVerdict,
  formatVerdictBanner,
  type Verdict,
  type ParsedVerdict,
} from "./verdict-parser.js";
export {
  shouldNudgeVerification,
  VERIFICATION_NUDGE_TEXT,
  type NudgeTaskLike,
} from "./verification-nudge.js";
export {
  markVerified,
  isVerified,
  recordCompleteAttempt,
  resetCompleteAttempts,
  _clearVerificationRegistry,
} from "./verification-tracker.js";
export { createVerificationGateHook } from "./hooks/verification-gate-hook.js";
