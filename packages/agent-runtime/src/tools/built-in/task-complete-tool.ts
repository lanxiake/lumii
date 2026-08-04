/**
 * task_complete — 任务完成通知工具
 *
 * Agent 调用此工具明确告知用户任务已完成，触发前端完成通知。
 * 只有 Agent 主动调用此工具，才视为任务真正完成。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../../tools/tool-adapter.js";
import type { AgentToolResult, ToolExecutionContext } from "../../types/tool.js";

const TaskCompleteParams = Type.Object({
  summary: Type.String({
    description:
      "A brief summary of what was accomplished (shown to the user as the completion message)",
  }),
});

type TaskCompleteInput = Static<typeof TaskCompleteParams>;

export const taskCompleteToolConfig: MtBotToolConfig<typeof TaskCompleteParams> = {
  name: "task_complete",
  label: "Task Complete",
  description:
    "Call this tool when you have fully completed the user's request. " +
    "Provide a brief summary of what was accomplished. " +
    "This is the ONLY way to signal task completion — do NOT just say 'done' in text.",
  parameters: TaskCompleteParams,
  category: "agent",
  isReadOnly: true,
  needsPermission: false,

  async execute(
    _toolCallId: string,
    params: TaskCompleteInput,
    _context: ToolExecutionContext,
  ): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        { type: "text", text: JSON.stringify({ status: "completed", summary: params.summary }) },
      ],
      details: undefined,
    };
  },
};
