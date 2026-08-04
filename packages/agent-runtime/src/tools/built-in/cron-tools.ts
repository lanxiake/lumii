/**
 * cron_tools — 定时任务工具集
 *
 * cron_create / cron_list / cron_delete
 *
 * stub 实现，由平台集成层（bridge.ts）注入 gateway callGateway 后覆盖 execute。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

// ─── cron_create ─────────────────────────────────────────────────────────────

const CronCreateParams = Type.Object({
  name: Type.String({ description: "Human-readable name for this scheduled task" }),
  taskText: Type.String({
    description: "Message or instruction to execute when the schedule triggers",
  }),
  scheduleType: Type.Union([Type.Literal("cron"), Type.Literal("every"), Type.Literal("at")], {
    description:
      "'cron' = cron expression (e.g. '0 9 * * 1-5'), " +
      "'every' = repeat interval in ms as plain integer string (e.g. '300000' for 5 min), " +
      "'at' = one-time schedule, use template expression or plain timestamp ms",
  }),
  scheduleExpr: Type.String({
    description:
      "Schedule expression matching scheduleType.\n" +
      "• cron: standard cron expr, e.g. '0 9 * * 1-5'\n" +
      "• every: plain integer ms string, e.g. '300000'\n" +
      "• at (one-time): PREFERRED — use template expression so the time is evaluated at call time:\n" +
      "  - N ms from now:      `${Date.now() + N}`          e.g. `${Date.now() + 120000}` for 2 min\n" +
      "  - N minutes from now: `${Date.now() + N * 60 * 1000}`  e.g. `${Date.now() + 2 * 60 * 1000}`\n" +
      "  - plain timestamp ms: '1775557371099'  (only if you have a verified absolute timestamp)\n" +
      "  NEVER use Math.floor() or other wrappers — they break the parser.",
  }),
  description: Type.Optional(Type.String({ description: "Optional task description" })),
  agentId: Type.Optional(
    Type.String({ description: "Agent ID to run the task (defaults to current agent)" }),
  ),
});

type CronCreateInput = Static<typeof CronCreateParams>;

export const cronCreateToolConfig: MtBotToolConfig<typeof CronCreateParams> = {
  name: "cron_create",
  label: "Create Scheduled Task",
  description:
    "Create a scheduled task that triggers at specified times or intervals. " +
    "Supports cron expression, repeat interval (every N ms), and one-time (at timestamp) schedules. " +
    "The task runs asynchronously and will invoke the specified agent with taskText.",
  parameters: CronCreateParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,
  async execute(_toolCallId: string, _params: CronCreateInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "cron_create requires platform integration layer.",
          }),
        },
      ],
      details: undefined,
    };
  },
};

// ─── cron_list ───────────────────────────────────────────────────────────────

const CronListParams = Type.Object({
  includeDisabled: Type.Optional(
    Type.Boolean({ description: "Include disabled tasks in the list (default: true)" }),
  ),
});

type CronListInput = Static<typeof CronListParams>;

export const cronListToolConfig: MtBotToolConfig<typeof CronListParams> = {
  name: "cron_list",
  label: "List Scheduled Tasks",
  description: "List all scheduled tasks for the current user, including status and next run time.",
  parameters: CronListParams,
  category: "agent",
  isReadOnly: true,
  needsPermission: false,
  async execute(_toolCallId: string, _params: CronListInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "not_implemented" }),
        },
      ],
      details: undefined,
    };
  },
};

// ─── cron_delete ─────────────────────────────────────────────────────────────

const CronDeleteParams = Type.Object({
  id: Type.String({ description: "ID of the scheduled task to delete" }),
});

type CronDeleteInput = Static<typeof CronDeleteParams>;

export const cronDeleteToolConfig: MtBotToolConfig<typeof CronDeleteParams> = {
  name: "cron_delete",
  label: "Delete Scheduled Task",
  description: "Delete a scheduled task by its ID.",
  parameters: CronDeleteParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,
  async execute(_toolCallId: string, _params: CronDeleteInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "not_implemented" }),
        },
      ],
      details: undefined,
    };
  },
};
