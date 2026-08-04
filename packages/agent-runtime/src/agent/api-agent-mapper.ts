/**
 * 将 API Server / 数据库返回的 Agent 记录映射为客户端 AgentDefinition
 *
 * 对齐 src/db/schema/agent-definitions 与 apps/api-server 的 transformAgentForFrontend 输出。
 */

import type {
  AgentDefinition,
  AgentSourceType,
  EffortValue,
  ModelTier,
} from "../types/agent-definition.js";
import type { AgentHooksConfig } from "../types/agent-definition.js";
import type { MemoryConfig, ProactivityConfig } from "../types/agent-definition.js";
import type { PermissionMode } from "../security/permission-types.js";

const MODEL_TIERS: readonly ModelTier[] = ["basic", "balanced", "performance"];

/**
 * 规范化模型级别
 */
function parseModelTier(raw: unknown): ModelTier {
  const s = String(raw ?? "balanced");
  return MODEL_TIERS.includes(s as ModelTier) ? (s as ModelTier) : "balanced";
}

/**
 * 解析来源类型（用户 Agent）
 */
function parseUserSourceType(raw: unknown): AgentSourceType {
  const s = String(raw ?? "custom");
  if (s === "fork" || s === "custom" || s === "template") return s;
  return "custom";
}

/**
 * 规范化记忆配置
 */
function parseMemory(raw: unknown): MemoryConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const scope = o.scope;
  if (scope !== "user" && scope !== "conversation" && scope !== "none") return undefined;
  return {
    scope,
    autoExtract: typeof o.autoExtract === "boolean" ? o.autoExtract : undefined,
    extractEvery: typeof o.extractEvery === "number" ? o.extractEvery : undefined,
  };
}

/**
 * 将网关 / API 返回的一条 Agent 记录转为客户端 AgentDefinition
 *
 * @param raw - GET /api/agents 或 GET /api/agents/:id 返回的数据对象
 */
export function mapApiRecordToAgentDefinition(raw: Record<string, unknown>): AgentDefinition {
  const id = String(raw.id ?? "");
  const name = String(raw.name ?? id);
  const userId = raw.userId as string | undefined;
  const isActive = (raw.isEnabled ?? raw.isActive) !== false;

  const sourceType: AgentSourceType = userId ? parseUserSourceType(raw.sourceType) : "system";

  const toolsWhitelist = raw.toolsWhitelist as string[] | undefined;
  const tools = toolsWhitelist ?? (raw.tools as string[] | undefined);

  const effortRaw = raw.effort;
  const effort: EffortValue | undefined =
    effortRaw === undefined || effortRaw === null
      ? undefined
      : typeof effortRaw === "number"
        ? effortRaw
        : (String(effortRaw) as EffortValue);

  const hooksConfig = raw.hooksConfig as AgentHooksConfig | undefined;

  const proactivity = raw.proactivityConfig as ProactivityConfig | undefined;

  return {
    id,
    name,
    description: raw.description as string | undefined,
    sourceType,
    version: typeof raw.version === "number" ? raw.version : 1,
    systemPrompt: raw.systemPrompt as string | undefined,
    personality: raw.personality as string | undefined,
    initialPrompt: raw.initialPrompt as string | undefined,
    criticalReminder: raw.criticalReminder as string | undefined,
    modelTier: parseModelTier(raw.modelTier),
    defaultPurpose:
      (raw.defaultPurpose as string | undefined) ??
      (raw.modelTier === "performance" ? "reasoning" : "chat"),
    model: raw.primaryModel as string | undefined,
    thinkingLevel: raw.thinkingLevel as AgentDefinition["thinkingLevel"],
    effort,
    tools,
    disallowedTools: (raw.toolsBlacklist ?? raw.skillBlacklist) as string[] | undefined,
    toolPermissions: raw.toolPermissions as AgentDefinition["toolPermissions"],
    skills: (raw.skillFilter as string[] | undefined) ?? undefined,
    maxTurns: raw.maxTurns as number | undefined,
    maxTokensPerRun: raw.maxTokensPerRun as number | undefined,
    maxTokensBudget: raw.maxTokensBudget as number | undefined,
    maxToolCallsPerRun: raw.maxToolCallsPerRun as number | undefined,
    timeoutMs: raw.timeoutMs as number | undefined,
    background: raw.background as boolean | undefined,
    permissionMode: raw.permissionMode as PermissionMode | undefined,
    memory: parseMemory(raw.memoryConfig),
    subagentMaxConcurrent: raw.subagentMaxConcurrent as number | undefined,
    canSpawnSubAgents: raw.canSpawnSubagents as boolean | undefined,
    allowedSubAgents: raw.allowedSubagents as string[] | undefined,
    canJoinTeam: raw.canJoinTeam as boolean | undefined,
    proactivity,
    hooks: hooksConfig,
    isActive,
  };
}
