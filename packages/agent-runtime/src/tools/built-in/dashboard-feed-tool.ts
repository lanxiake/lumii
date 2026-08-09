/**
 * dashboard_feed_write — 将结构化资讯/摘要写入概览页资讯卡片
 *
 * stub 实现，由平台集成层（bridge-tool-registrar.ts）覆盖 execute 落盘到 DashboardFeedSnapshot。
 * 让 Agent 在自主搜索/抓取资讯后，把结果结构化写入卡片，而不只是在对话里回复文本
 * （概览页资讯卡片需要 title/summary/source 等字段才能渲染，纯文本回复无法满足）。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const DashboardFeedItemParams = Type.Object({
  title: Type.String({ description: "条目标题" }),
  summary: Type.Optional(Type.String({ description: "一句话摘要" })),
  href: Type.Optional(Type.String({ description: "原文链接" })),
  source: Type.Optional(Type.String({ description: "来源站点/媒体名" })),
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
