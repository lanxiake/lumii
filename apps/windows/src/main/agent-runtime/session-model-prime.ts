import { channelOwnershipFromKey, type ChannelOwnership } from '../channel/channel-identity.js'

/** 会跟全局/UI 模型走的渠道归属（不含代聊 pcwechat、系统会话） */
const MESSAGING_CHANNEL_OWNERSHIPS: ReadonlySet<ChannelOwnership> = new Set([
  'feishu',
  'weixin',
  'wecom',
  'qbot',
])

/**
 * 是否为飞书/微信等渠道会话键（前缀归属）。
 * 这类会话不应被历史 DB preferredModel 压过当前 UI 选择。
 */
export function isMessagingChannelSessionKey(sessionKey: string): boolean {
  return MESSAGING_CHANNEL_OWNERSHIPS.has(channelOwnershipFromKey(sessionKey))
}

export type PrimeModelSource = 'ui' | 'db' | 'live' | 'none'

/**
 * 解析 prime 时的有效模型：桌面会话保留 DB 粘性；渠道会话优先 UI，其次 live chat。
 */
export function resolvePrimeEffectiveModel(input: {
  sessionKey: string
  modelRef: string | undefined
  savedPreferred: string | undefined
  liveChatModelId: string | undefined
}): { effective: string | undefined; source: PrimeModelSource } {
  const ui = input.modelRef?.trim() || undefined
  const saved = input.savedPreferred?.trim() || undefined
  const live = input.liveChatModelId?.trim() || undefined

  if (isMessagingChannelSessionKey(input.sessionKey)) {
    if (ui) return { effective: ui, source: 'ui' }
    if (live) return { effective: live, source: 'live' }
    // 渠道且无 UI/live：才退回 DB（避免完全空）
    if (saved) return { effective: saved, source: 'db' }
    return { effective: undefined, source: 'none' }
  }

  // 桌面会话：DB 会话粘性优先
  if (saved) return { effective: saved, source: 'db' }
  if (ui) return { effective: ui, source: 'ui' }
  if (live) return { effective: live, source: 'live' }
  return { effective: undefined, source: 'none' }
}
