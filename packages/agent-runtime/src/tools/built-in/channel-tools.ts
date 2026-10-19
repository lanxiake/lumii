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

/**
 * 合法出站渠道 id —— **唯一一份**。
 *
 * 下面的 JSON schema enum 由它生成，Windows 主进程的 Router 校验
 * （channel/outbound-types.ts）也从它取，避免"加了渠道但漏改一处"：
 * 那次漏改让 pcwechat 在参数校验层就被拒，压根没走到 Router 的白名单。
 */
export const OUTBOUND_CHANNEL_IDS = [
  "feishu",
  "weixin",
  "wecom",
  "qbot",
  "pcwechat",
] as const;

export type OutboundChannelId = (typeof OUTBOUND_CHANNEL_IDS)[number];

/**
 * 本机微信里「用户本人」的收件人：文件传输助手。
 * 给它发 = 主动推送给用户自己（个人微信渠道做不到的那条路）。
 */
export const PCWECHAT_SELF_PEER_ID = "filehelper";

/**
 * 各渠道写给 Agent 的身份与能力说明 —— **唯一一份**。
 *
 * `weixin` 与 `pcwechat` 都叫「微信」，但方向与能力完全不同，只给 id + pushMode 时
 * 模型分不清：把需要主动推送的通知发到个人微信（被动回复窗口外必失败），
 * 或不知道本机微信可以发给文件传输助手来通知用户本人。channel_list 的每条快照
 * 带上这里的 name/note，工具描述与提示词也按同一口径写。
 */
export const OUTBOUND_CHANNEL_PROFILES: Readonly<
  Record<OutboundChannelId, { readonly name: string; readonly note: string }>
> = {
  feishu: {
    name: "飞书",
    note: "Native push: can message any listed peer at any time; supports files.",
  },
  weixin: {
    name: "个人微信 (Lumii WeChat bot)",
    note:
      "The user chats WITH the Lumii bot from their phone. Reply-window only: it can send only to a peer " +
      "who messaged the bot recently (cached context token, stale after ~24h) and cannot push multiple " +
      "unsolicited messages or reach a conversation that has been quiet for a long time. " +
      "Not suited for proactive notifications.",
  },
  wecom: {
    name: "企业微信",
    note: "Reply-only: no proactive push at all.",
  },
  qbot: {
    name: "QQ",
    note: "Text within ~5 minutes of the peer's last message; files limited to images/video/voice.",
  },
  pcwechat: {
    name: "本机微信 (desktop WeChat on this PC)",
    note:
      "Sends AS THE USER from the WeChat client on this computer (GUI automation). Native push: can send " +
      "at any time, any number of messages, text only, and only to peers on its reply allowlist. " +
      `To proactively notify the USER THEMSELF, send to to="${PCWECHAT_SELF_PEER_ID}" (文件传输助手, File Transfer).`,
  },
};

/** 入参校验用：这个字符串是不是合法渠道 id */
export function isOutboundChannelId(value: unknown): value is OutboundChannelId {
  return (
    typeof value === "string" &&
    (OUTBOUND_CHANNEL_IDS as readonly string[]).includes(value)
  );
}

const ChannelListParams = Type.Object({});
type ChannelListInput = Static<typeof ChannelListParams>;

/** 列出已连接渠道与可寻址 peers（只读） */
export const channelListToolConfig: MtBotToolConfig<typeof ChannelListParams> = {
  name: CHANNEL_LIST_TOOL_NAME,
  label: "Channel List",
  description:
    "List connected messaging channels (feishu/weixin/wecom/qbot/pcwechat), their pushMode, and addressable peers. " +
    "Each entry carries name and note fields describing what that channel can do — read them: " +
    "weixin (个人微信, the Lumii WeChat bot) and pcwechat (本机微信, desktop WeChat on this PC) are DIFFERENT channels. " +
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
    Type.Union(
      OUTBOUND_CHANNEL_IDS.map((id) => Type.Literal(id)),
      {
        description:
          "Target channel id. OMIT it to reply on the channel this turn came from " +
          "(the active conversation) — that is the right choice for 'send it to me'. " +
          "Only set it explicitly when the user names another channel. " +
          "weixin = 个人微信 (Lumii WeChat bot, reply-window only); " +
          "pcwechat = 本机微信 (desktop WeChat on this PC, can push anytime).",
      },
    ),
  ),
  to: Type.Optional(
    Type.String({
      description:
        "Peer id from channel_list. OMIT it to reply to the current conversation " +
        "(the peer you are talking to right now); in group chats omission only works " +
        "within the current group. When you set `channel` explicitly to notify the USER " +
        "THEMSELF (e.g. \"完成后用微信/飞书通知我\"), you may also omit `to`: " +
        "feishu resolves to the user's linked account, pcwechat to 文件传输助手 — " +
        "no need to guess an id. Set it explicitly — after channel_list — to reach a " +
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
        "WeCom cannot send files proactively at all. " +
        "pcwechat (本机微信) is text-only, and only to peers on its reply allowlist. " +
        "Omit for text-only messages.",
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
    "To notify the user themself on a named channel, set only `channel` and omit `to` " +
    "(feishu → their linked account, pcwechat → 文件传输助手). " +
    "For reports/long content, pass the source Markdown — don't pre-flatten it to plain text. " +
    "Capability limits (report them honestly, never silently switch channel): " +
    "weixin (个人微信, Lumii bot) needs a recent inbound message from that peer (cached context token) and " +
    "cannot push multiple unsolicited messages or reach a long-quiet conversation; " +
    `pcwechat (本机微信, desktop WeChat on this PC) can push at any time — to notify the user themself use ` +
    `channel="pcwechat", to="${PCWECHAT_SELF_PEER_ID}" (文件传输助手); ` +
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
