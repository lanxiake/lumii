/**
 * send_message 工具 — 给「正在跑的任务」追加指令
 *
 * 语义（2026-09-13 拍板）：不是委派通道，而是对已在运行的专家/子任务补要求、纠偏、传话。
 * 委派仍走 spawn_agent；目标实例完成后即回收，此时应重新委托而不是重复调用本工具。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../../tools/tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const SendMessageParams = Type.Object({
  to: Type.String({
    description:
      'Running agent to append to: agent name, agent ID, or a sub-agent instance id from spawn_agent. "*" broadcasts to all agents.',
  }),
  message: Type.String({ description: "Instruction or message to append to that running task" }),
  summary: Type.Optional(
    Type.String({ description: "A 5-10 word summary shown as a preview in the UI" }),
  ),
});

type SendMessageInput = Static<typeof SendMessageParams>;

/**
 * send_message 工具配置
 *
 * stub 实现，由平台集成层提供实际 MessageBus 发送逻辑。
 */
export const sendMessageToolConfig: MtBotToolConfig<typeof SendMessageParams> = {
  name: "send_message",
  label: "Send Message",
  description:
    "Append an instruction to a task that is already running (a delegated sub-agent). " +
    "Use it to refine, correct or add requirements mid-flight instead of spawning the same task again. " +
    "Not a delegation channel.",
  parameters: SendMessageParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,

  async execute(_toolCallId: string, params: SendMessageInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message:
              `send_message is a stub. Platform integration layer should override this. ` +
              `Requested: to=${params.to}, message=${params.message.slice(0, 200)}`,
          }),
        },
      ],
      details: undefined,
    };
  },
};
