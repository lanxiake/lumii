/**
 * send_message 工具 — Agent 间消息通信
 *
 * 向指定 Agent 或广播发送消息。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../../tools/tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const SendMessageParams = Type.Object({
  to: Type.String({
    description: 'Recipient: agent name, agent ID, or "*" for broadcast to all agents',
  }),
  message: Type.String({ description: "Message content to send" }),
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
  description: "Send a message to another agent teammate",
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
