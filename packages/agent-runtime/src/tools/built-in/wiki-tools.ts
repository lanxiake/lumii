/**
 * wiki_* — Wiki 知识库 Agent 工具（stub 配置）
 *
 * wiki_overview / wiki_search / wiki_read / wiki_capture
 * 平台集成（Electron bridge，见 apps/windows/src/main/agent-runtime/bridge-wiki-tools.ts）覆盖 execute。
 *
 * 设计：docs/design/Wiki知识库/2026-08-25-Wiki知识库设计P0P1P2.md §3.9
 * 形态参照 memorySearchToolConfig / memoryReadToolConfig（integration-tools.ts）。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

const stubExecute = async (): Promise<AgentToolResult<unknown>> => ({
  content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
  details: undefined,
});

const WikiOverviewParams = Type.Object({});

/** 让 Agent 先建立地图：没有它只能盲目搜索，搜不到就误报"没有资料" */
export const wikiOverviewToolConfig: MtBotToolConfig<typeof WikiOverviewParams> = {
  name: "wiki_overview",
  label: "Wiki Overview",
  description:
    "Get an overview of the Wiki knowledge base: page count per top-level category and recent page titles. Call this FIRST before wiki_search to understand what's available, rather than guessing keywords blindly.",
  parameters: WikiOverviewParams,
  category: "memory",
  isReadOnly: true,
  needsPermission: false,
  execute: stubExecute,
};

const WikiSearchParams = Type.Object({
  query: Type.String({ description: "Search keyword(s), supports Chinese and mixed Chinese/English." }),
  limit: Type.Optional(Type.Number({ description: "Max results, default 10." })),
});
type WikiSearchInput = Static<typeof WikiSearchParams>;

/** 返回匹配段落全文而非短 snippet：一次调用拿到足够上下文，避免多轮"搜列表→逐个读页"往返 */
export const wikiSearchToolConfig: MtBotToolConfig<typeof WikiSearchParams> = {
  name: "wiki_search",
  label: "Wiki Search",
  description:
    "Full-text search the Wiki knowledge base (FTS5 + BM25). Returns matching page paths, titles, and full-text content excerpts — enough context in one call without needing a follow-up wiki_read.",
  parameters: WikiSearchParams,
  category: "memory",
  isReadOnly: true,
  needsPermission: false,
  execute: async (_id: string, _p: WikiSearchInput): Promise<AgentToolResult<unknown>> => stubExecute(),
};

const WikiReadParams = Type.Object({
  path: Type.String({
    description:
      "Wiki page path (e.g. sources/architecture-doc) or the exact sourcePath returned by wiki_search.",
  }),
});
type WikiReadInput = Static<typeof WikiReadParams>;

export const wikiReadToolConfig: MtBotToolConfig<typeof WikiReadParams> = {
  name: "wiki_read",
  label: "Wiki Read",
  description:
    "Read the full content of a Wiki page or source by its path. Accepts both compiled Wiki page paths and the sourcePath returned by wiki_search. Use wiki_search or wiki_overview first to find the path.",
  parameters: WikiReadParams,
  category: "memory",
  isReadOnly: true,
  needsPermission: false,
  execute: async (_id: string, _p: WikiReadInput): Promise<AgentToolResult<unknown>> => stubExecute(),
};
