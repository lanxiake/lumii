/**
 * 双投递：桌面先答时按 requestId 作废渠道挂起。
 */

import { describe, expect, it } from 'vitest'
import { ChannelInteractionStore } from './channel-interaction-store'
import type { ChannelSession, IChannelAdapter } from './types'

describe('ChannelInteractionStore.clearByRequestId', () => {
  it('命中 requestId 时删除并返回 sessionKey', () => {
    const store = new ChannelInteractionStore()
    const adapter = { sendTextReply: async () => {} } as unknown as IChannelAdapter
    const session = { sessionKey: 'feishu:u1' } as unknown as ChannelSession
    store.set('feishu:u1', {
      interaction: { kind: 'ask', requestId: 'req-1', questions: [] },
      adapter,
      session,
    })
    expect(store.clearByRequestId('req-1')).toBe('feishu:u1')
    expect(store.get('feishu:u1')).toBeUndefined()
  })

  it('未命中时返回 undefined 且不改其它挂起', () => {
    const store = new ChannelInteractionStore()
    const adapter = { sendTextReply: async () => {} } as unknown as IChannelAdapter
    const session = { sessionKey: 'feishu:u1' } as unknown as ChannelSession
    store.set('feishu:u1', {
      interaction: { kind: 'permission', requestId: 'req-keep', toolName: 'bash' },
      adapter,
      session,
    })
    expect(store.clearByRequestId('other')).toBeUndefined()
    expect(store.get('feishu:u1')?.interaction.requestId).toBe('req-keep')
  })
})
