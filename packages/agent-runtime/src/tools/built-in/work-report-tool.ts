/**
 * work_report_read — 读取工作日报/每周复盘产出（只读）
 *
 * 供早间简报、每周复盘等预置定时任务直接取「进行中 / 明天优先 / 本周产出」等结构化结论。
 * stub 实现，由平台集成层（bridge-tool-registrar-cron.ts）覆盖 execute，
 * 读 local_cron_runs 里 seed-daily-report / seed-weekly-review 最近 N 条 summary。
 *
 * 为什么要有这个工具：工作日报的产物落在 local_cron_runs.summary + wiki_sources 里，
 * 而 memory_search 只搜 user-memory.md、wiki_search 按 bigram 检索资料层，
 * 二者都取不到「昨天日报的进行中/明天优先」，导致早间简报拿不到真实数据。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const WorkReportReadParams = Type.Object({
  kind: Type.Optional(
    Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("all")], {
      description: "读取哪种报告：daily=工作日报（默认），weekly=每周复盘，all=两者都要",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "最近几条（默认 3，上限 10）" }),
  ),
  days: Type.Optional(
    Type.Number({ description: "只看最近 N 天内产出的报告（默认不限）" }),
  ),
});

type WorkReportReadInput = Static<typeof WorkReportReadParams>;

export const workReportReadToolConfig: MtBotToolConfig<typeof WorkReportReadParams> = {
  name: "work_report_read",
  label: "Read Work Reports",
  description:
    "Read the user's recent work reports (daily work reports / weekly reviews) to get their " +
    "real 'in progress' and 'next priority' items. Use this to build morning briefings or weekly " +
    "reviews from actual data instead of guessing. Returns structured report summaries with timestamps.",
  parameters: WorkReportReadParams,
  category: "agent",
  isReadOnly: true,
  needsPermission: false,
  async execute(_toolCallId: string, _params: WorkReportReadInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "work_report_read requires platform integration layer.",
          }),
        },
      ],
      details: undefined,
    };
  },
};
