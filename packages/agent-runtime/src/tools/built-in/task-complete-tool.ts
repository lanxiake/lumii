/**
 * task_complete — 任务完成通知工具
 *
 * Agent 调用此工具明确告知用户任务已完成，触发前端完成通知。
 * 只有 Agent 主动调用此工具，才视为任务真正完成。
 *
 * ⚠️ 返回里的 `terminate: true` **不是可选的**：它是这个工具「唯一完成信号」这条
 * 契约的唯一实现。少了它，工具只是往上下文里塞了段 JSON，回合照跑——模型的
 * `description` 里写着"这是唯一信号"，于是它调完一次没见回合作罢，就**再调一次**，
 * 一路空转（2026-10-12 微信代聊实测：一个回合 109 次模型往返、60 次 task_complete、
 * 1089 万 inputTokens、3 分 20 秒；2026-09 另有 28 次 task_complete / 4.5 分钟的事故）。
 * pi-agent-core 的 `shouldTerminateToolBatch` 要求这一批工具结果**全部**带
 * `terminate === true` 才收尾，所以单独调用即可终止，与别的工具同批则不会。
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
    const { summary } = params;

    console.log(`[task_complete] 任务完成: ${summary}`);

    return {
      content: [
        { type: "text", text: JSON.stringify({ status: "completed", summary: params.summary }) },
      ],
      details: undefined,
      // 让外层回合循环在这里收尾（见文件头）。缺了这一行，task_complete 就只是
      // 一条普通工具结果，模型会反复调用它直到撞上 maxTurns / StuckGuard。
      terminate: true,
    };
  },
};
