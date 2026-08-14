/**
 * channel_list / channel_send — 渠道出站 Agent 工具 stub
 *
 * execute 由 Windows bridge（bridge-tool-registrar）覆盖，调用 ChannelOutboundRouter。
 * 设计：docs/design/2026-08-14-channel-outbound-hub-design.md §7.4
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export const CHANNEL_LIST_TOOL_NAME = "channel_list";
export const CHANNEL_SEND_TOOL_NAME = "channel_send";

const ChannelListParams = Type.Object({});
type ChannelListInput = Static<typeof ChannelListParams>;

/** 列出已连接渠道与可寻址 peers（只读） */
export const channelListToolConfig: MtBotToolConfig<typeof ChannelListParams> = {
  name: CHANNEL_LIST_TOOL_NAME,
  label: "Channel List",
  description:
    "List connected messaging channels (feishu/weixin/wecom), their pushMode, and addressable peers. " +
    "Call this BEFORE channel_send to obtain valid peer ids. Do not guess recipient ids.",
  parameters: ChannelListParams,
  category: "channel",
  isReadOnly: true,
  needsPermission: false,
  async execute(_toolCallId: string, _params: ChannelListInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "channel_list requires platform integration layer.",
          }),
        },
      ],
      details: undefined,
    };
  },
};

const ChannelSendParams = Type.Object({
  channel: Type.Union([
    Type.Literal("feishu"),
    Type.Literal("weixin"),
    Type.Literal("wecom"),
  ], { description: "Target channel id from channel_list" }),
  to: Type.String({ description: "Peer id from channel_list (required). Do not guess." }),
  text: Type.String({ description: "Plain text to send. With mediaPath, sent as a separate leading message; may be empty." }),
  mediaPath: Type.Optional(
    Type.String({
      description:
        "Absolute local path of a file to send (image/document/audio/video). " +
        "Feishu and WeChat only; WeCom hard-fails. Omit for text-only messages.",
    }),
  ),
  fileName: Type.Optional(
    Type.String({ description: "Display file name for mediaPath. Defaults to the path basename." }),
  ),
});
type ChannelSendInput = Static<typeof ChannelSendParams>;

/** 向指定 channel + peer 主动发文本或本地文件（需用户确认） */
export const channelSendToolConfig: MtBotToolConfig<typeof ChannelSendParams> = {
  name: CHANNEL_SEND_TOOL_NAME,
  label: "Channel Send",
  description:
    "Send a text and/or a local file to an explicit channel peer. Always call channel_list first. " +
    "'to' is required. Set 'mediaPath' to an absolute local path to send images/documents/audio/video. " +
    "WeChat needs a prior inbound message (cached context token). " +
    "WeCom does not support proactive push (will hard-fail). " +
    "On failure, report errorCode/message honestly — never pretend success. " +
    "For in-turn WeChat replies in the active session, prefer the legacy `message` tool.",
  parameters: ChannelSendParams,
  category: "channel",
  isReadOnly: false,
  needsPermission: true,
  async execute(_toolCallId: string, _params: ChannelSendInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "channel_send requires platform integration layer.",
          }),
        },
      ],
      details: undefined,
    };
  },
};
