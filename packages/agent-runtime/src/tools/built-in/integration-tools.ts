/**
 * integration_tools — client runtime integration capability tools
 *
 * message / nodes / memory_search / memory_read / profile_memory / system_prompt / tts_generate
 *
 * These are stub configs. Platform integration (Electron bridge) overrides execute.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const MessageParams = Type.Object(
  {
    action: Type.String({ description: "Message action (send/delete/react/...)." }),
    channel: Type.Optional(Type.String({ description: "Target channel (e.g. imessage, weixin). Do NOT use 'windows-agent-runtime'." })),
    to: Type.Optional(Type.String({ description: "Recipient identifier. NOT needed when replying within the current conversation (the active session's recipient is used automatically) — e.g. when the current chat is WeChat, just set text/mediaUrl and the message goes back to that user." })),
    text: Type.Optional(Type.String({ description: "Text content to send." })),
    mediaUrl: Type.Optional(Type.String({ description: "Absolute local file path to send as image/file (e.g. for WeChat)." })),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
type MessageInput = Static<typeof MessageParams>;

export const messageToolConfig: MtBotToolConfig<typeof MessageParams> = {
  name: "message",
  label: "Message",
  description: "Send a message back to the user in the current conversation, or to another channel/recipient. To reply to the user you are currently talking to (including WeChat), just provide text (and/or mediaUrl for files/images) — 'to' and 'channel' are optional and the active session's recipient is used automatically.",
  parameters: MessageParams,
  category: "channel",
  isReadOnly: false,
  needsPermission: false,
  async execute(_toolCallId: string, _params: MessageInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
      details: undefined,
    };
  },
};

const NodesParams = Type.Object(
  {
    action: Type.String({ description: "Nodes action: status/describe/run/notify/..." }),
    node: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
type NodesInput = Static<typeof NodesParams>;

export const nodesToolConfig: MtBotToolConfig<typeof NodesParams> = {
  name: "nodes",
  label: "Nodes",
  description: "List and control bound user devices.",
  parameters: NodesParams,
  category: "channel",
  isReadOnly: false,
  needsPermission: false,
  async execute(_toolCallId: string, _params: NodesInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
      details: undefined,
    };
  },
};

const MemorySearchParams = Type.Object({
  query: Type.String({ description: "Semantic search query for user memory." }),
  maxResults: Type.Optional(Type.Number()),
  sessionKey: Type.Optional(
    Type.String({
      description:
        "Optional conversation sessionKey to scope search to the current session's archived drawers (same as conversationId).",
    }),
  ),
});
type MemorySearchInput = Static<typeof MemorySearchParams>;

export const memorySearchToolConfig: MtBotToolConfig<typeof MemorySearchParams> = {
  name: "memory_search",
  label: "Memory Search",
  description: "Search long-term user memory and stored context.",
  parameters: MemorySearchParams,
  category: "memory",
  isReadOnly: true,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    _params: MemorySearchInput,
  ): Promise<AgentToolResult<unknown>> {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
      details: undefined,
    };
  },
};

const MemoryReadParams = Type.Object({
  drawerId: Type.String({
    description:
      "Memory drawer ID from memory_search results. Use memory_search first to find the drawer_id, then read full archived content here.",
  }),
});
type MemoryReadInput = Static<typeof MemoryReadParams>;

/** 按 drawer_id 读取记忆宫殿归档原文（含历史会话 transcript） */
export const memoryReadToolConfig: MtBotToolConfig<typeof MemoryReadParams> = {
  name: "memory_read",
  label: "Memory Read",
  description:
    "Read the full archived content of one memory drawer (incl. original conversation transcript) by drawer_id. Use memory_search first to get the drawer_id, then read the full text here.",
  parameters: MemoryReadParams,
  category: "memory",
  isReadOnly: true,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    _params: MemoryReadInput,
  ): Promise<AgentToolResult<unknown>> {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
      details: undefined,
    };
  },
};

const ProfileMemoryParams = Type.Object({
  action: Type.Union([
    Type.Literal("read_memory"),
    Type.Literal("update_memory"),
    Type.Literal("append"),
    Type.Literal("remove_section"),
    Type.Literal("get_preferences"),
  ]),
  content: Type.Optional(
    Type.String({
      description:
        "For update_memory: full new document. For append: a markdown block to add (e.g. '## 偏好\\n- ...'). Not used for remove_section.",
    }),
  ),
  section: Type.Optional(
    Type.String({
      description:
        "For remove_section: heading text of the '## ' section to delete (matched without the leading '## ').",
    }),
  ),
});
type ProfileMemoryInput = Static<typeof ProfileMemoryParams>;

export const profileMemoryToolConfig: MtBotToolConfig<typeof ProfileMemoryParams> = {
  name: "profile_memory",
  label: "Profile Memory",
  description:
    "Read/edit the user profile-memory document (stable identity & preferences). Prefer append (add one block) or remove_section (drop one '## ' section) over update_memory (full overwrite — risky, can wipe content). Do NOT save: one-off queries, weather/news, secrets (passwords, API keys), or already-recorded info.",
  parameters: ProfileMemoryParams,
  category: "memory",
  isReadOnly: false,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    _params: ProfileMemoryInput,
  ): Promise<AgentToolResult<unknown>> {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
      details: undefined,
    };
  },
};

const SystemPromptParams = Type.Object({
  action: Type.Union([Type.Literal("read"), Type.Literal("update"), Type.Literal("reset")]),
  content: Type.Optional(Type.String()),
});
type SystemPromptInput = Static<typeof SystemPromptParams>;

export const systemPromptToolConfig: MtBotToolConfig<typeof SystemPromptParams> = {
  name: "system_prompt",
  label: "System Prompt",
  description: "Read/update/reset user personalization prompt.",
  parameters: SystemPromptParams,
  category: "memory",
  isReadOnly: false,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    _params: SystemPromptInput,
  ): Promise<AgentToolResult<unknown>> {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
      details: undefined,
    };
  },
};

const TtsGenerateParams = Type.Object({
  text: Type.String({ description: "要合成为语音的文本内容" }),
});
type TtsGenerateInput = Static<typeof TtsGenerateParams>;

export const ttsGenerateToolConfig: MtBotToolConfig<typeof TtsGenerateParams> = {
  name: "tts_generate",
  label: "生成语音",
  description:
    "将文本合成为语音音频文件。合成完成后返回文件路径（filePath），可通过 message 工具的 mediaUrl 参数将语音文件发送给用户。",
  parameters: TtsGenerateParams,
  category: "channel",
  isReadOnly: false,
  needsPermission: false,
  async execute(_toolCallId: string, _params: TtsGenerateInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
      details: undefined,
    };
  },
};
