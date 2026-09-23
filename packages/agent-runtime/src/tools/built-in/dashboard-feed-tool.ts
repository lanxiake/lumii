/**
 * dashboard_feed_write / dashboard_feed_read — 概览页资讯卡片的写入与回读
 *
 * stub 实现，由平台集成层（bridge-tool-registrar.ts）覆盖 execute 落盘到 DashboardFeedSnapshot。
 * 让 Agent 在自主搜索/抓取资讯后，把结果结构化写入卡片，而不只是在对话里回复文本
 * （概览页资讯卡片需要 title/summary/source 等字段才能渲染，纯文本回复无法满足）。
 *
 * 回读（read）是策展类 Agent 的去重前提：卡片是**累积**的，写之前得先知道
 * 上面已经有什么，否则每轮都会把同一事件的同一篇稿子再推一次。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

const DashboardFeedItemParams = Type.Object({
  title: Type.String({ description: "条目标题" }),
  summary: Type.Optional(Type.String({ description: "一句话摘要" })),
  href: Type.Optional(Type.String({ description: "原文链接" })),
  source: Type.Optional(
    Type.String({
      description:
        "来源站点/媒体名。格式：`媒体名` 或 `媒体名·栏目/转载源`，" +
        "分隔符统一用 `·`（不要用 `/`、`|` 或空格混写）——" +
        "同一家媒体的不同写法会散成不同的统计键，让「这家最近被推了几条」这类问题答不准。",
    }),
  ),
});

const DashboardFeedWriteParams = Type.Object({
  title: Type.String({ description: "Feed 标题，如「最近资讯」" }),
  summary: Type.Optional(Type.String({ description: "整体综述，不超过 120 字" })),
  items: Type.Array(DashboardFeedItemParams, {
    description: "资讯条目列表，建议 10-20 条",
  }),
});

type DashboardFeedWriteInput = Static<typeof DashboardFeedWriteParams>;

export const dashboardFeedWriteToolConfig: MtBotToolConfig<typeof DashboardFeedWriteParams> = {
  name: "dashboard_feed_write",
  label: "Write Dashboard Feed",
  description:
    "Write structured news/summary items to the dashboard's news feed card. " +
    "Call this after searching/fetching news content to persist a structured result " +
    "(title, summary, source, link per item) — a plain text reply in the chat will NOT show up on the dashboard card.",
  parameters: DashboardFeedWriteParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,
  async execute(_toolCallId: string, _params: DashboardFeedWriteInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "dashboard_feed_write requires platform integration layer.",
          }),
        },
      ],
      details: undefined,
    };
  },
};

const DashboardFeedReadParams = Type.Object({
  limit: Type.Optional(
    Type.Number({
      description: "最多回读多少条（默认 30，上限 100）。卡片是累积的，条数按时间倒序取最近的。",
    }),
  ),
});

type DashboardFeedReadInput = Static<typeof DashboardFeedReadParams>;

export const dashboardFeedReadToolConfig: MtBotToolConfig<typeof DashboardFeedReadParams> = {
  name: "dashboard_feed_read",
  label: "Read Dashboard Feed",
  description:
    "Read the items currently on the dashboard's news feed card (most recent first). " +
    "The card accumulates across runs, so call this BEFORE writing to avoid pushing the same story twice.",
  parameters: DashboardFeedReadParams,
  category: "agent",
  isReadOnly: true,
  needsPermission: false,
  async execute(_toolCallId: string, _params: DashboardFeedReadInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "dashboard_feed_read requires platform integration layer.",
          }),
        },
      ],
      details: undefined,
    };
  },
};
