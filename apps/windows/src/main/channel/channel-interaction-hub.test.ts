/**
 * ChannelInteractionHub · 主动出站（pushText）
 *
 * 转交完成汇报是**异步**产出（几分钟到几十分钟后），此时用户那条入站消息早已处理完；
 * 渠道用户的唯一出口就是这个按会话保存的回复上下文，否则结果只落在库里、渠道侧毫无响应。
 *
 * - 收到过入站消息（trackSession 刷新过）→ 交给 adapter.sendTextReply
 * - 无回复上下文（应用重启 / 该会话从未收过消息）→ false，调用方兜底
 * - 推送抛错 → false（异步汇报不应把异常抛回调用链）
 */

import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeBridge } from '../agent-runtime/bridge'
import { ChannelInteractionHub } from './channel-interaction-hub'
import type { ChannelSession, IChannelAdapter } from './types'

function makeHub(): { hub: ChannelInteractionHub; bridge: Record<string, unknown> } {
  const bridge = {
    setChannelInteractionNotifier: vi.fn(),
    setChannelTextPusher: vi.fn(),
  }
  const hub = new ChannelInteractionHub(bridge as unknown as AgentRuntimeBridge)
  return { hub, bridge }
}

function makeAdapter(sendTextReply = vi.fn(async () => {})): IChannelAdapter {
  return { sendTextReply } as unknown as IChannelAdapter
}

const QQ_SESSION = {
  sessionKey: 'qbot:u-1',
  channelType: 'qbot',
  channelUserId: 'u-1',
  instanceId: null,
  replyContext: { chatId: 'chat-1', msgId: 'msg-1' },
} as unknown as ChannelSession

describe('ChannelInteractionHub · pushText（异步结果出渠道）', () => {
  it('构造时把出站实现注册给 bridge（异步汇报的唯一通道）', () => {
    const { bridge } = makeHub()
    expect(bridge.setChannelTextPusher).toHaveBeenCalledWith(expect.any(Function))
  })

  it('会话有回复上下文时推到渠道', async () => {
    const { hub } = makeHub()
    const adapter = makeAdapter()
    hub.trackSession(adapter, QQ_SESSION)

    await expect(hub.pushText('qbot:u-1', '✅ 转交完成：修分页')).resolves.toBe(true)
    expect(adapter.sendTextReply).toHaveBeenCalledWith(QQ_SESSION, '✅ 转交完成：修分页')
  })

  it('无回复上下文（应用重启 / 从未收过消息）→ false，不抛错', async () => {
    const { hub } = makeHub()

    await expect(hub.pushText('qbot:u-1', 'x')).resolves.toBe(false)
  })

  it('推送失败 → false（汇报链不因此中断）', async () => {
    const { hub } = makeHub()
    hub.trackSession(
      makeAdapter(vi.fn(async () => Promise.reject(new Error('bot offline')))),
      QQ_SESSION,
    )

    await expect(hub.pushText('qbot:u-1', 'x')).resolves.toBe(false)
  })

  it('每轮入站消息刷新路由：换会话后旧键不再可用，新键可用', async () => {
    const { hub } = makeHub()
    const adapter = makeAdapter()
    hub.trackSession(adapter, { ...QQ_SESSION, sessionKey: 'qbot:u-2' } as unknown as ChannelSession)

    await expect(hub.pushText('qbot:u-1', 'x')).resolves.toBe(false)
    await expect(hub.pushText('qbot:u-2', 'y')).resolves.toBe(true)
  })
})
