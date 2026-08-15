/**
 * 渠道出站 Hub 核心类型
 *
 * 设计文档：docs/design/2026-08-14-channel-outbound-hub-design.md
 */

/** Agent / cron 使用的渠道标识（一期） */
export type OutboundChannelId = 'feishu' | 'weixin' | 'wecom'

/** 出站能力模式：真 Push / 缓存 token 伪 Push / 仅被动回复 */
export type ChannelPushMode = 'native_push' | 'cached_reply' | 'reply_only'

/** 稳定错误码（硬失败，禁止 silent success） */
export type ChannelSendErrorCode =
  | 'CHANNEL_NOT_CONNECTED'
  | 'HUB_NOT_READY'
  | 'PEER_NOT_FOUND'
  | 'NO_REPLY_CONTEXT'
  | 'TOKEN_STALE'
  | 'UNSUPPORTED_PUSH'
  | 'UNSUPPORTED_MEDIA'
  | 'MEDIA_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'

/** 渠道内可寻址收件人 */
export interface ChannelPeer {
  /** 渠道内稳定 ID：飞书 open_id、微信 channelUserId */
  id: string
  /** 展示名（可选） */
  label?: string
  /** 是否具备出站条件 */
  canSend: boolean
  /** 不能发送时的原因码 */
  blockedReason?: 'NO_REPLY_CONTEXT' | 'TOKEN_STALE' | 'UNSUPPORTED'
  lastInboundAt?: number
}

/** channel_list 单渠道快照 */
export interface ChannelSnapshot {
  channel: OutboundChannelId
  connected: boolean
  pushMode: ChannelPushMode
  peers: ChannelPeer[]
  /** 预留多账号；一期单账号场景下始终为空，Router/Provider 均不读取 */
  accountId?: string
}

/** channel_send / Router.send 入参 */
export interface ChannelSendParams {
  channel: OutboundChannelId
  /** 必填收件人 */
  to: string
  text: string
  /** 富媒体本地绝对路径；给出时走 Provider.sendMedia */
  mediaPath?: string
  /** 展示文件名，缺省时从 mediaPath 取 basename */
  fileName?: string
  /** 预留多账号；一期单账号场景下不生效，Router 不做任何路由判断 */
  accountId?: string
}

/** Provider.sendMedia 入参 */
export interface ChannelSendMediaParams {
  to: string
  /** 已由 Router 校验存在的本地绝对路径 */
  mediaPath: string
  fileName: string
  /** 可选随附文本，各渠道自行决定是否单独先发一条 */
  text?: string
}

/** 出站结果：失败必须 ok:false + errorCode */
export interface ChannelSendResult {
  ok: boolean
  errorCode?: ChannelSendErrorCode
  /** 中文可操作说明 */
  message?: string
  channel?: OutboundChannelId
  to?: string
}

/** 微信伪 Push 持久化记录 */
export interface WeixinReplyContextRecord {
  channelUserId: string
  contextToken: string
  botToken?: string
  ilinkBaseUrl?: string
  updatedAt: number
  lastNickname?: string
}

/** 各渠道出站 Provider 接口 */
export interface IChannelOutboundProvider {
  readonly channel: OutboundChannelId
  /** 聚合连接态 + peers + 能力 */
  getSnapshot(): ChannelSnapshot | Promise<ChannelSnapshot>
  /** 向指定 peer 发文本；不支持时返回 UNSUPPORTED_PUSH */
  sendText(params: { to: string; text: string }): Promise<ChannelSendResult>
  /** 向指定 peer 发富媒体；未实现的渠道由 Router 兜底为 UNSUPPORTED_MEDIA */
  sendMedia?(params: ChannelSendMediaParams): Promise<ChannelSendResult>
}

export const CHANNEL_LIST_TOOL = 'channel_list'
export const CHANNEL_SEND_TOOL = 'channel_send'

/** 微信 token 超过此时长 → list 标 TOKEN_STALE（仍允许 send 尝试一次） */
export const TOKEN_STALE_MS = 24 * 60 * 60 * 1000
