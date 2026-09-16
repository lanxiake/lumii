/**
 * maintenance_report_write / maintenance_report_read — 维护体检报告的落库与回读
 *
 * stub 实现，由平台集成层（bridge-maintenance-tools.ts）覆盖 execute 落到
 * `maintenance_reports` 表。让「灵栖维护」的巡检产出有结构化载体，而不是散在
 * 会话正文里——否则用户看不出上次体检是什么时候、发现了什么、这次还在不在。
 *
 * 回读（read）的意义在于**接续**：报告里带着每期都报的稳定 key，
 * 维护据此能回答「上次那批问题处理了吗」，而不是每期从零开始。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const FindingParams = Type.Object({
  key: Type.String({
    description:
      "跨期稳定的问题标识，形如 '<资产>:<问题>'（如 memory:duplicate、wiki:orphan-page）。" +
      "同一类问题每期必须用同一个 key——系统靠它判断「上期有、这期没了 = 已解决」。" +
      "不要用标题当 key，标题每期措辞都会变。",
  }),
  severity: Type.Union(
    [Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
    { description: "严重度：high 有数据损坏风险 / medium 影响使用 / low 可择期处理" },
  ),
  title: Type.String({ description: "问题一句话（给用户看的措辞）" }),
  evidence: Type.Optional(Type.String({ description: "判断依据：数据 / 文件 / 行号" })),
  suggestion: Type.Optional(Type.String({ description: "建议动作" })),
});

const MaintenanceReportWriteParams = Type.Object({
  scope: Type.Union(
    [
      Type.Literal("full"),
      Type.Literal("memory"),
      Type.Literal("wiki"),
      Type.Literal("guides"),
      Type.Literal("settings"),
      Type.Literal("workspace"),
    ],
    { description: "本次体检覆盖的资产；一轮走完全部用 full" },
  ),
  summary: Type.String({
    description: "一句话结论，直接显示在概览页卡片上（如「记忆 228 条，发现 2 处重复」）",
  }),
  findings: Type.Array(FindingParams, {
    description: "发现的问题，按严重度从高到低；没有问题时传空数组",
  }),
  checked: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "查过且**没有**问题的项（如「工作记忆：228 条，未发现重复」）。" +
        "只报问题不报查过什么，用户无法判断是没查还是真没事。",
    }),
  ),
});

type MaintenanceReportWriteInput = Static<typeof MaintenanceReportWriteParams>;

export const maintenanceReportWriteToolConfig: MtBotToolConfig<typeof MaintenanceReportWriteParams> = {
  name: "maintenance_report_write",
  label: "Write Maintenance Report",
  description:
    "Persist a maintenance check-up report so it shows up on the dashboard card and can be compared " +
    "with the previous one. Call this at the END of every check-up (including read-only ones) — " +
    "a plain text reply in the chat will NOT be visible on the dashboard.",
  parameters: MaintenanceReportWriteParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    _params: MaintenanceReportWriteInput,
  ): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "maintenance_report_write requires platform integration layer.",
          }),
        },
      ],
      details: undefined,
    };
  },
};

const MaintenanceReportReadParams = Type.Object({
  limit: Type.Optional(
    Type.Number({ description: "回读最近几期（默认 2，上限 10）。至少取 2 期才能看出问题是否已解决。" }),
  ),
});

type MaintenanceReportReadInput = Static<typeof MaintenanceReportReadParams>;

export const maintenanceReportReadToolConfig: MtBotToolConfig<typeof MaintenanceReportReadParams> = {
  name: "maintenance_report_read",
  label: "Read Maintenance Reports",
  description:
    "Read previous check-up reports (most recent first). Use it to see what was already found and " +
    "whether it is still there, instead of reporting the same thing from scratch every time.",
  parameters: MaintenanceReportReadParams,
  category: "agent",
  isReadOnly: true,
  needsPermission: false,
  async execute(
    _toolCallId: string,
    _params: MaintenanceReportReadInput,
  ): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "maintenance_report_read requires platform integration layer.",
          }),
        },
      ],
      details: undefined,
    };
  },
};
