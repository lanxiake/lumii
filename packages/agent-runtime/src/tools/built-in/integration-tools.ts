/**
 * integration_tools — client runtime integration capability tools
 *
 * message / memory_search / memory_read / profile_memory / system_prompt / speech_generate
 *
 * These are stub configs. Platform integration (Electron bridge) overrides execute.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

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
  description: "Send a message back to the user in the current conversation (in-turn reply). To reply to the user you are currently talking to (including WeChat), just provide text (and/or mediaUrl for files/images) — 'to' and 'channel' are optional and the active session's recipient is used automatically. DEPRECATED for proactive/other-peer outbound: use channel_list + channel_send instead — this tool now hard-fails for any non-active-session target.",
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

const MemorySearchParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "What to search for in memory. Omit it when you only pass drawerId (reading one known drawer).",
    }),
  ),
  drawerId: Type.Optional(
    Type.String({
      description:
        "Read one archived drawer in FULL by its id, skipping the search. Pass just the raw hex id (16 chars, e.g. `a3f9c21b8e4d0077`) — strip the `[d:` prefix and `]` suffix if it came from a `[d:xxxx]` pointer, and drop any `d:` prefix from a previous `memory_search` result. Use this whenever a summary is not enough: details, exact wording, full process, the trade-offs at the time.",
    }),
  ),
  maxResults: Type.Optional(Type.Number()),
  sessionKey: Type.Optional(
    Type.String({
      description:
        "Optional conversation sessionKey to scope search to the current session's archived drawers (same as conversationId).",
    }),
  ),
});
type MemorySearchInput = Static<typeof MemorySearchParams>;

/**
 * 记忆工具的**唯一入口**（原 memory_search 与 memory_read 合并）。
 *
 * 合并的理由不是"少一个工具"，是消除一条被实测确认的失败路径：两个工具并存时，
 * 模型搜到替代品就不再回去读注入层给过指针的那条原文（3/3 全错），而它多搜一轮
 * 只是把同一个东西找第二遍。合并后「搜」与「读」共用一个调用面，`drawerId` 一给
 * 就是直读全文——没有"先搜再读"这个多余动作可做。
 *
 * 保留 `memory_read` 的注册（见宿主 registerIntegrationTools）：agent 定义里的
 * 工具白名单按名字放行，直接删会让所有已定义的 Agent 失去这个入口。
 */
export const memorySearchToolConfig: MtBotToolConfig<typeof MemorySearchParams> = {
  name: "memory_search",
  label: "Memory",
  description:
    "Your memory. Two ways to use it: (1) pass `query` to search working memory, the memory palace (archived transcripts), the user profile and scene memory files — results carry a `provider` field saying where each hit came from; (2) pass `drawerId` to read one archived transcript in FULL, no search needed. Anything already injected into your system prompt is left out of search results — if a search comes back empty or unrelated, the answer is probably in that injected block: rely on it (and read its `[d:xxxx]` original for detail) instead of answering from the search hits alone.",
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
      "The raw hex id only — 16 chars, e.g. `a3f9c21b8e4d0077`. If the id came from a `[d:xxxx]` pointer in your context, strip the `[d:` prefix and `]` suffix before passing it. Also accepts an id returned by memory_search.",
  }),
});
type MemoryReadInput = Static<typeof MemoryReadParams>;

/** 按 drawer_id 读取记忆宫殿归档原文（含历史会话 transcript） */
export const memoryReadToolConfig: MtBotToolConfig<typeof MemoryReadParams> = {
  name: "memory_read",
  label: "Memory Read",
  description:
    "Read the full archived content of one memory drawer (incl. original conversation transcript) by drawer_id. The id comes from either the `[d:xxxx]` pointer on an injected memory line (pass just the hex — no search needed) or a memory_search result. Use it whenever a summary lacks the detail being asked for.",
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
    "Read/edit the user profile-memory document (stable identity & preferences). Prefer append (add one block) or remove_section (drop one '## ' section) over update_memory (full overwrite — risky, can wipe content). Each entry carries system-managed metadata (an id and creation date in a trailing HTML comment) — keep it intact when you copy a line, and never invent or edit it: the system restores the correct values on write. Do NOT save: one-off queries, weather/news, secrets (passwords, API keys), or already-recorded info.",
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

const SceneMemoryParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("read"),
    Type.Literal("write"),
    Type.Literal("append"),
    Type.Literal("remove_section"),
  ]),
  scene: Type.Optional(
    Type.Union([Type.Literal("project"), Type.Literal("channel")], {
      description:
        "Scene kind. 'project' = conventions/preferences for ONE project; 'channel' = behavior preferences for ONE IM channel. Not needed for action='list'.",
    }),
  ),
  key: Type.Optional(
    Type.String({
      description:
        "Project name or path for scene='project' (e.g. 'lumii'); channel type for scene='channel' ('weixin'|'feishu'|'wecom'|'qbot'). For 'channel', omit to use the current conversation's channel.",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description:
        "For scene='project': the project's root directory. When provided, memory is stored at <path>/.lumii/memory.md (travels with the project). Omit for concept-only projects (stored under the client data dir).",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "For 'write': full new document. For 'append': a markdown block to add (e.g. '## 约定\\n- ...').",
    }),
  ),
  section: Type.Optional(
    Type.String({
      description:
        "For 'remove_section': heading text of the '## ' section to delete (matched without the leading '## ').",
    }),
  ),
});
type SceneMemoryInput = Static<typeof SceneMemoryParams>;

export const sceneMemoryToolConfig: MtBotToolConfig<typeof SceneMemoryParams> = {
  name: "scene_memory",
  label: "Scene Memory",
  description:
    "Read/edit SCENE memory: per-project conventions (scene='project') or per-IM-channel preferences (scene='channel'). Anything true for only ONE project (e.g. 'this repo uses pnpm') or ONE channel (e.g. 'keep WeChat replies short') MUST go here, NOT into profile_memory — global profile memory is injected into every conversation and scene content there becomes noise elsewhere. Project memory is stored at <project>/.lumii/memory.md when a path is known. Prefer 'append' over 'write'. Use action='list' to see all known scenes.",
  parameters: SceneMemoryParams,
  category: "memory",
  isReadOnly: false,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    _params: SceneMemoryInput,
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

const SpeechGenerateParams = Type.Object({
  text: Type.String({ description: "要合成为语音的文本内容（支持长文，如文章、有声书章节）" }),
  speaker: Type.Optional(
    Type.String({
      description:
        "固定音色 ID。**仅当用户语音引擎是 Qwen3 CustomVoice 时生效**；" +
        "Breeze / Edge / MeloTTS 等引擎会忽略它。可选值：" +
        "Vivian(女·明亮略带锋芒·中文)、Serena(女·温暖柔和·中文)、Uncle_Fu(男·沉稳低沉·中文)、" +
        "Dylan(男·清朗自然·北京话)、Eric(男·略沙哑明亮·四川话)、" +
        "Ryan(男·节奏感强·English)、Aiden(男·阳光清晰·English)、" +
        "Ono_Anna(女·轻快灵动·日本語)、Sohee(女·情感丰富·한국어)。" +
        "想要自定义音色（自然语言描述）请用 instruction，不要在这里编造 ID。",
    }),
  ),
  instruction: Type.Optional(
    Type.String({
      description:
        "自然语言音色描述（如「一位温柔自信的年轻女声，语速偏快，像体育播报」）。" +
        "**仅在 Breeze TTS 引擎下生效**，其他引擎忽略。" +
        "Breeze 没有固定音色列表——想听什么声音就用一句话描述它：" +
        "音色性别年龄、语气情绪、口音、场景感都可以写进去（Breeze 的语速也写在这里，如「语速偏慢」）。" +
        "留空则用设置页里配的默认音色。" +
        "同一描述的多次调用会自动复用同一个声音；配合 voiceName 时，描述只在首次建音色时决定声音，" +
        "之后再传不同描述表示「在这个声音上调整语气」（如「更激动一些」）。",
    }),
  ),
  voiceName: Type.Optional(
    Type.String({
      description:
        "给声音起名，跨多次调用保持同一个声音（**仅 Breeze 引擎**，其他引擎忽略）。" +
        "首次用某个名字时，这次合成的声音会被保存；之后传同一个名字就是同一个人在说话。" +
        "用于：有声书多章节、系列播客、多段配音、多角色对话（每个角色一个名字，如「旁白」「小明」）。" +
        "只能用中英文、数字、下划线、短横线，最长 48 字。已保存的名字见返回值 savedVoices。" +
        "单篇文本不需要它：一次调用内的长文本已自动保持同一声音。",
    }),
  ),
  speed: Type.Optional(
    Type.Number({
      description:
        "语速倍率，范围 0.8~1.3，默认 1.0。朗读/有声书建议 0.9~1.0，播报可 1.1。" +
        "Edge / MeloTTS / Qwen3 生效；**Breeze 不支持**（请在 instruction 里描述语速）。",
      minimum: 0.8,
      maximum: 1.3,
    }),
  ),
});
type SpeechGenerateInput = Static<typeof SpeechGenerateParams>;

export const speechGenerateToolConfig: MtBotToolConfig<typeof SpeechGenerateParams> = {
  name: "speech_generate",
  label: "生成语音",
  description:
    "将文本合成为语音音频文件（本地 TTS，适合配音、朗读文章、生成有声书）。" +
    "长文本一次传完即可，会自动分段合成并保持同一个声音、统一音量。" +
    "合成完成后返回文件路径（filePath），可通过 message 工具的 mediaUrl 参数发送给用户。\n" +
    "返回值里的 engine / voiceParam 说明当前引擎和该用的音色参数；ignoredParams 列出本次被忽略的参数。" +
    "不确定引擎时先只传 text，看返回值再决定。\n" +
    "音色参数按引擎选一个：\n" +
    "· instruction —— 自然语言描述（Breeze 引擎）。没有固定音色表，描述即所得。\n" +
    "· speaker —— 固定音色 ID（Qwen3 CustomVoice 引擎）。\n" +
    "跨多次调用保持同一声音（Breeze）：传 voiceName。系列内容、多角色对话都要用它，" +
    "否则每次调用的声音可能不同。",
  parameters: SpeechGenerateParams,
  category: "channel",
  isReadOnly: false,
  needsPermission: false,
  async execute(_toolCallId: string, _params: SpeechGenerateInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
      details: undefined,
    };
  },
};
