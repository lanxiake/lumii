/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { persistAndNotifyIncomingUserMessage } from './persist-incoming-user-message'

describe('persistAndNotifyIncomingUserMessage', () => {
  it('落库返回的 id 必须原样交给 notify，避免 UI 占位 id 与 DB id 分裂', () => {
    const saveMessage = vi.fn(() => ({ id: 'db-msg-abc' }))
    const notify = vi.fn()

    const id = persistAndNotifyIncomingUserMessage(
      { saveMessage },
      notify,
      'feishu:ou_test',
      '你好飞书',
    )

    expect(id).toBe('db-msg-abc')
    expect(saveMessage).toHaveBeenCalledWith({
      conversationId: 'feishu:ou_test',
      role: 'user',
      contentJson: { type: 'text', text: '你好飞书' },
    })
    expect(notify).toHaveBeenCalledWith('feishu:ou_test', '你好飞书', 'db-msg-abc')
    // 契约：先落库再推送（否则 notify 自造 incoming-* 时两侧已分裂）
    expect(saveMessage.mock.invocationCallOrder[0]).toBeLessThan(notify.mock.invocationCallOrder[0]!)
  })
})
