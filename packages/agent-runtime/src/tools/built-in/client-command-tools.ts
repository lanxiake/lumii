/**
 * client_command_tools — Windows 客户端命令工具
 *
 * 将斜杠命令封装为 Agent 可主动调用的工具。
 * 这些是 stub 配置，Electron bridge 层覆盖 execute 实现真实逻辑。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

const notImplemented = (): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
  details: undefined,
});

// ── 会话管理 ──

const SessionCreateParams = Type.Object({});
type SessionCreateInput = Static<typeof SessionCreateParams>;

export const sessionCreateToolConfig: MtBotToolConfig<typeof SessionCreateParams> = {
  name: "session_create",
  label: "Create Session",
  description: "Create a new conversation session.",
  parameters: SessionCreateParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,
  async execute(_id: string, _p: SessionCreateInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};

const SessionClearParams = Type.Object({
  sessionKey: Type.String({ description: "Session key/ID to clear." }),
});
type SessionClearInput = Static<typeof SessionClearParams>;

export const sessionClearToolConfig: MtBotToolConfig<typeof SessionClearParams> = {
  name: "session_clear",
  label: "Clear Session",
  description: "Delete all messages in the specified conversation session.",
  parameters: SessionClearParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: true,
  async execute(_id: string, _p: SessionClearInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};

const SessionCompactParams = Type.Object({
  sessionKey: Type.Optional(
    Type.String({
      description: "Session key/ID to compact. Omit to compact the current session.",
    }),
  ),
  keepRecentTurns: Type.Optional(
    Type.Number({ description: "Number of recent turns to keep (default: 6).", minimum: 1 }),
  ),
});
type SessionCompactInput = Static<typeof SessionCompactParams>;

export const sessionCompactToolConfig: MtBotToolConfig<typeof SessionCompactParams> = {
  name: "session_compact",
  label: "Compact Context",
  description: "Compress conversation context by removing older messages, keeping recent turns.",
  parameters: SessionCompactParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,
  async execute(_id: string, _p: SessionCompactInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};

const SessionResumeParams = Type.Object({
  sessionKey: Type.String({ description: "Session key/ID to switch to." }),
});
type SessionResumeInput = Static<typeof SessionResumeParams>;

export const sessionResumeToolConfig: MtBotToolConfig<typeof SessionResumeParams> = {
  name: "session_resume",
  label: "Resume Session",
  description:
    "Switch the conversation to another session so the user continues there. " +
    "Pass the sessionKey returned by session_list (do not invent one). " +
    "On a chat channel the switch also redirects the user's subsequent messages to that session.",
  parameters: SessionResumeParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,
  async execute(_id: string, _p: SessionResumeInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};

const SessionListParams = Type.Object({
  query: Type.Optional(
    Type.String({ description: "Optional keyword to filter sessions by title." }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of sessions to return (default: 20).",
      minimum: 1,
      maximum: 50,
    }),
  ),
});
type SessionListInput = Static<typeof SessionListParams>;

export const sessionListToolConfig: MtBotToolConfig<typeof SessionListParams> = {
  name: "session_list",
  label: "List Sessions",
  description:
    "List the user's recent conversations, each with its short id, title, source channel " +
    "(desktop/WeChat/Feishu/WeCom/QQ), last-updated time and whether it is the current one. " +
    "Call this first when the user refers to a conversation by name, or asks what conversations " +
    "they have — then pass the returned sessionKey to session_resume.",
  parameters: SessionListParams,
  category: "agent",
  isReadOnly: true,
  needsPermission: false,
  async execute(_id: string, _p: SessionListInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};

// ── 设置 ──

const SettingsThinkParams = Type.Object({
  level: Type.Union(
    [Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
    { description: "Thinking level: off / low / medium / high." },
  ),
});
type SettingsThinkInput = Static<typeof SettingsThinkParams>;

export const settingsThinkToolConfig: MtBotToolConfig<typeof SettingsThinkParams> = {
  name: "settings_think",
  label: "Set Think Level",
  description: "Configure the LLM thinking/reasoning level for subsequent messages.",
  parameters: SettingsThinkParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,
  async execute(_id: string, _p: SettingsThinkInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};

const SettingsBackendParams = Type.Object({
  backendId: Type.String({
    description:
      "ACP backend ID: lumii | claude | codex | opencode | gemini | qoder | qwen | kimi | copilot | auggie | cursor",
  }),
});
type SettingsBackendInput = Static<typeof SettingsBackendParams>;

export const settingsBackendToolConfig: MtBotToolConfig<typeof SettingsBackendParams> = {
  name: "settings_backend",
  label: "Set ACP Backend",
  description: "Switch the ACP coding assistant backend (e.g., claude, opencode, lumii).",
  parameters: SettingsBackendParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,
  async execute(_id: string, _p: SettingsBackendInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};

// ── 信息查询 ──

const InfoStatusParams = Type.Object({
  sessionKey: Type.String({ description: "Session key/ID to query." }),
});
type InfoStatusInput = Static<typeof InfoStatusParams>;

export const infoStatusToolConfig: MtBotToolConfig<typeof InfoStatusParams> = {
  name: "info_status",
  label: "Session Status",
  description: "Query current session status: message count, streaming state, and active model.",
  parameters: InfoStatusParams,
  category: "agent",
  isReadOnly: true,
  needsPermission: false,
  async execute(_id: string, _p: InfoStatusInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};

const MemoryManageParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("window"),
      Type.Literal("add"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("archive"),
      Type.Literal("clear"),
    ],
    {
      description:
        "list: show working-memory entries; window: enumerate entries by time window (since/days) for daily/weekly summaries — paginated and NOT capped to top-N, so low-importance entries from today are reachable; add: create one entry; update: replace one entry's content by id; delete: permanently remove one entry by id; archive: soft-delete one entry by id; clear: delete ALL entries for the current agent.",
    },
  ),
  id: Type.Optional(
    Type.String({ description: "Memory entry id. Required for update/delete/archive." }),
  ),
  content: Type.Optional(
    Type.String({ description: "Memory content. Required for add/update." }),
  ),
  category: Type.Optional(
    Type.Union(
      [Type.Literal("project"), Type.Literal("reference"), Type.Literal("general")],
      {
        description:
          "Working-memory category for add (default: general). User profile/preferences belong to profile_memory, NOT here.",
      },
    ),
  ),
  importance: Type.Optional(
    Type.Number({ description: "Importance 0..1 for add (default 0.5)." }),
  ),
  days: Type.Optional(
    Type.Number({
      description:
        "window only: look back N days from now (default 1). Ignored when `since` is provided.",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description:
        "window only: inclusive ISO-8601 lower bound on created_at, e.g. \"2026-09-14T00:00:00Z\" (use for «since the last daily»). Overrides `days`.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "window only: page size, default 200 (max 1000)." }),
  ),
  offset: Type.Optional(
    Type.Number({ description: "window only: page offset for pagination, default 0." }),
  ),
});
type MemoryManageInput = Static<typeof MemoryManageParams>;

export const memoryManageToolConfig: MtBotToolConfig<typeof MemoryManageParams> = {
  name: "memory_manage",
  label: "Manage Memory",
  description:
    "Manage the current agent's working memory (project/reference/general). Add/update/delete/archive single entries or list/clear all. Use this to keep memory accurate — remove stale or wrong entries, add durable task/resource facts. Personal user profile & preferences go through profile_memory instead.",
  parameters: MemoryManageParams,
  category: "memory",
  isReadOnly: false,
  needsPermission: false,
  async execute(_id: string, _p: MemoryManageInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};
