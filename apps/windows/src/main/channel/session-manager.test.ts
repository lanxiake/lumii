/**
 * resolveReplyTo —— channel_send 省略 to 时的默认收件人。
 *
 * 单聊 = channelUserId；群聊 = 群 chatId（QQ 加 `group:` 前缀，与 peer id 形状一致）。
 */
import { describe, expect, it } from 'vitest'
import { resolveReplyTo } from './session-manager'
import type { ChannelSession } from './types'

function session(overrides: Partial<ChannelSession>): ChannelSession {
  return {
    sessionKey: 'k',
    channelType: 'qbot',
    channelUserId: 'user-1',
    instanceId: null,
    ...overrides,
  }
}

describe('resolveReplyTo', () => {
  it('单聊回 channelUserId', () => {
    expect(resolveReplyTo(session({ replyContext: { chatType: 'p2p' } }))).toBe('user-1')
  })

  it('QQ 群聊回 group:{chatId}（与 QbotChannelProvider 的 peer id 形状一致）', () => {
    expect(
      resolveReplyTo(
        session({ replyContext: { chatType: 'group', chatId: 'group_openid_1' } }),
      ),
    ).toBe('group:group_openid_1')
  })

  it('企微群聊回群 chatId（不加前缀）', () => {
    expect(
      resolveReplyTo(
        session({
          channelType: 'wecom',
          channelUserId: 'user-1',
          replyContext: { chatType: 'group', chatId: 'wr_group_1' },
        }),
      ),
    ).toBe('wr_group_1')
  })

  it('群聊缺 chatId 时返回 undefined（不回退成发言人，避免私聊误投）', () => {
    expect(resolveReplyTo(session({ replyContext: { chatType: 'group' } }))).toBeUndefined()
  })

  it('客户端会话没有可回信地址', () => {
    expect(resolveReplyTo(session({ channelType: 'ipc' }))).toBeUndefined()
  })
})
