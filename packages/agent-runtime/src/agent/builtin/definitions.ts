/**
 * 内置 Agent 定义（客户端离线兜底镜像）
 *
 * 对齐 .qoder/design/client-agent-runtime/12-技能触发-预制子Agent-协调层-详细设计.md
 * 与 claude-code-rev `src/tools/AgentTool/built-in/*`。
 *
 * ⚠️ 架构约束（v13）：
 * 1. **权威数据源 = api-server PostgreSQL `system_agents` 表**（由
 *    `src/db/seed/system-agents.ts::seedSystemAgentsWithDb` 在服务端 seed）。
 * 2. 客户端本文件仅作为 **离线兜底 / 启动冷启动兜底**：
 *    - 当 API 不可达（网络故障、首次冷启动）时，`AgentDefinitionStore.get`
 *      的最后一步会落到 `findBuiltInAgent` 返回这里的静态副本。
 *    - 这些定义与 api-server `DEFAULT_SYSTEM_AGENTS` 保持语义一致，
 *      但**不会主动写入客户端 SQLite**（SQLite 仅缓存 API 实际返回的记录）。
 * 3. 修改这里的字段时，**必须同步修改** api-server
 *    `src/db/seed/system-agents.ts::DEFAULT_SYSTEM_AGENTS`，否则两端会漂移。
 * 4. 仅包含下发到客户端侧会被"默认使用"的 Agent：
 *    - `assistant`：通用入口
 *    - `builtin:explore`：快速代码探索子 Agent
 *    - `builtin:plan`：架构规划子 Agent
 *    - `builtin:verify`：对抗性验证子 Agent
 *
 * 命名空间：新增内置子 Agent 使用 `builtin:` 前缀，避免与用户/API Agent 冲突。
 */

import type { AgentDefinition } from "../../types/agent-definition.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SPAWN_AGENT_TOOL_NAME,
} from "../../tools/built-in/tool-names.js";
import {
  ASSISTANT_PERSONALITY,
  ASSISTANT_PROMPT,
  ASSISTANT_WHEN_TO_USE,
  EXPLORE_AGENT_PROMPT,
  EXPLORE_WHEN_TO_USE,
  PLAN_AGENT_PROMPT,
  PLAN_WHEN_TO_USE,
  VERIFY_AGENT_PROMPT,
  VERIFY_CRITICAL_REMINDER,
  VERIFY_WHEN_TO_USE,
} from "./prompts.js";

/**
 * 内置 Agent ID 命名空间前缀
 *
 * 约定：
 * - `assistant`（无前缀）：通用入口 Agent，对应 api-server system_agents.id = "assistant"
 * - `builtin:<subtype>`：Claude Code 风格的预制子 Agent，仅用于被 assistant 调度
 */
export const BUILTIN_AGENT_ID_PREFIX = "builtin:";

// --- 通用助手 ---

const ASSISTANT_DEF: AgentDefinition = {
  id: "assistant",
  name: "系统默认",
  description: ASSISTANT_WHEN_TO_USE,
  sourceType: "system",
  version: 3,
  // 短占位 prompt，走 BUILTIN_SHORT_PROMPTS 白名单 → identity 使用 SOUL
  systemPrompt: ASSISTANT_PROMPT,
  // role / 委派规则 / 原则 —— 由 builder 注入在 SOUL 之后
  personality: ASSISTANT_PERSONALITY,
  modelTier: "balanced",
  defaultPurpose: "chat",
  tools: ["*"],
  permissionMode: "default",
  maxTurns: 80,
  canSpawnSubAgents: true,
  // 主 Agent 默认可委派给任意 Agent（含用户在 AI 团队创建的自定义 Agent）。
  // 不设 allowedSubAgents（undefined = 全放行），避免白名单把用户自建 Agent 误过滤。
  memory: { scope: "user", autoExtract: true, extractEvery: 10 },
  isActive: true,
};

// --- Explore（快速代码搜索） ---

const EXPLORE_DEF: AgentDefinition = {
  id: "builtin:explore",
  name: "Explore (代码探索)",
  description: EXPLORE_WHEN_TO_USE,
  sourceType: "system",
  version: 1,
  systemPrompt: EXPLORE_AGENT_PROMPT,
  modelTier: "basic",
  defaultPurpose: "chat",
  permissionMode: "readOnly",
  disallowedTools: [
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    SPAWN_AGENT_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    ASK_USER_QUESTION_TOOL_NAME,
  ],
  maxTurns: 30,
  canSpawnSubAgents: false,
  memory: { scope: "none" },
  isActive: true,
};

// --- Plan（只读架构规划） ---

const PLAN_DEF: AgentDefinition = {
  id: "builtin:plan",
  name: "Plan (架构规划)",
  description: PLAN_WHEN_TO_USE,
  sourceType: "system",
  version: 1,
  systemPrompt: PLAN_AGENT_PROMPT,
  modelTier: "performance",
  defaultPurpose: "reasoning",
  permissionMode: "readOnly",
  disallowedTools: [
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    SPAWN_AGENT_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    ASK_USER_QUESTION_TOOL_NAME,
  ],
  maxTurns: 40,
  canSpawnSubAgents: false,
  memory: { scope: "none" },
  isActive: true,
};

// --- Verify（对抗性验证） ---

const VERIFY_DEF: AgentDefinition = {
  id: "builtin:verify",
  name: "Verify (对抗性验证)",
  description: VERIFY_WHEN_TO_USE,
  sourceType: "system",
  version: 1,
  systemPrompt: VERIFY_AGENT_PROMPT,
  criticalReminder: VERIFY_CRITICAL_REMINDER,
  modelTier: "balanced",
  defaultPurpose: "chat",
  permissionMode: "readOnly",
  disallowedTools: [
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    SPAWN_AGENT_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    ASK_USER_QUESTION_TOOL_NAME,
  ],
  maxTurns: 60,
  canSpawnSubAgents: false,
  memory: { scope: "none" },
  isActive: true,
};

/**
 * 客户端内置 Agent 离线镜像
 *
 * 供 `AgentDefinitionStore.get` 在 API 不可达时返回给调用方。
 * 注意：此数组不会被主动写入 SQLite；只有当 API 返回相同 ID 的定义后，
 * 该 ID 才会落盘到 `agent_definition_cache`。
 */
export const BUILTIN_AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  ASSISTANT_DEF,
  EXPLORE_DEF,
  PLAN_DEF,
  VERIFY_DEF,
];

/**
 * 按 ID 查找内置 Agent 定义（纯内存查找，不访问 DB）
 *
 * 仅用于离线兜底 / 启动冷启动场景；运行时请优先通过 AgentDefinitionStore。
 */
export function findBuiltInAgent(id: string): AgentDefinition | undefined {
  // 历史兼容：旧代码里的 "main" / "default" 映射到 "assistant"
  if (id === "main" || id === "default") {
    return BUILTIN_AGENT_DEFINITIONS.find((a) => a.id === "assistant");
  }
  return BUILTIN_AGENT_DEFINITIONS.find((a) => a.id === id);
}

/**
 * 判断给定 ID 是否为内置子 Agent（不含 assistant）
 */
export function isBuiltInSubAgentId(id: string): boolean {
  return id.startsWith(BUILTIN_AGENT_ID_PREFIX);
}
