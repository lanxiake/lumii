/**
 * channel_list / channel_send — 渠道出站 Agent 工具 stub
 *
 * execute 由 Windows bridge（bridge-tool-registrar）覆盖，调用 ChannelOutboundRouter。
 * 设计：docs/design/渠道与CLI/2026-08-14-渠道出站Hub设计.md §7.4
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export const CHANNEL_LIST_TOOL_NAME = "channel_list";
export const CHANNEL_SEND_TOOL_NAME = "channel_send";

const ChannelListParams = Type.Object({});
type ChannelListInput = Static<typeof ChannelListParams>;

/** 列出已连接渠道与可寻址 peers（只读） */
export const channelListToolConfig: MtBotToolConfig<typeof ChannelListParams> = {
  name: CHANNEL_LIST_TOOL_NAME,
  label: "Channel List",
  description:
    "List connected messaging channels (feishu/weixin/qbot/wecom), their pushMode, and addressable peers. " +
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
  channel: Type.Optional(
    Type.Union([
      Type.Literal("feishu"),
      Type.Literal("weixin"),
      Type.Literal("qbot"),
      Type.Literal("wecom"),
    ], {
      description:
        "Target channel id. OMIT it to reply on the channel this turn came from " +
        "(the active conversation) — that is the right choice for 'send it to me'. " +
        "Only set it explicitly when the user names another channel.",
    }),
  ),
  to: Type.Optional(
    Type.String({
      description:
        "Peer id from channel_list. OMIT it to reply to the current conversation " +
        "(the peer you are talking to right now); in group chats omission only works " +
        "within the current group. Set it explicitly — after channel_list — to reach a " +
        "different peer. Never guess an id.",
    }),
  ),
  text: Type.String({
    description:
      "Message body. Markdown is welcome — each channel renders it in its best form " +
      "(Feishu rich card / WeCom·QQ markdown / WeChat mobile-friendly text). " +
      "With mediaPath, sent as a separate leading message; may be empty.",
  }),
  mediaPath: Type.Optional(
    Type.String({
      description:
        "Absolute local path of a file to send. Supported: Feishu (any file), WeChat " +
        "(any file, needs a fresh inbound token), QQ (images/video/voice only — the official " +
        "API has file_type=4 'file' marked 暂不开放, so documents hard-fail). " +
        "WeCom cannot send files proactively at all. Omit for text-only messages.",
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
    "Send a text and/or a local file to a channel peer. Omitting 'channel'/'to' replies to the " +
    "conversation this turn came from — do that for 'send it to me'; call channel_list first only " +
    "when you need a DIFFERENT peer or channel. " +
    "Set 'mediaPath' to an absolute local path to send a file. " +
    "For reports/long content, pass the source Markdown — don't pre-flatten it to plain text. " +
    "Capability limits (report them honestly, never silently switch channel): " +
    "WeChat needs a prior inbound message (cached context token); " +
    "QQ text is deliverable within ~5 minutes of the peer's last message (passive window), " +
    "and QQ files are limited to images/video/voice (documents are not open on the platform yet); " +
    "WeCom does not support proactive push (will hard-fail). " +
    "On failure, report errorCode/message honestly — never pretend success. " +
    "For in-turn WeChat replies in the active session, the legacy `message` tool also works.",
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
