/**
 * dispatchChannelTarget 单测：cron 与 outreach 共用的渠道派发。
 * 重点：飞书自动选 peer、微信/QQ 必须显式 peer、Router 缺失时飞书兜底、wecom 跳过。
 */
import { describe, expect, it, vi } from 'vitest'
import { dispatchChannelTarget } from './channel-target-dispatch'

function makeRouter(peers: Array<{ id: string; canSend: boolean }> = []) {
  const send = vi.fn(async () => ({ ok: true }))
  const list = vi.fn(async () => [
    { channel: 'feishu' as const, connected: true, pushMode: 'native_push' as const, peers },
  ])
  return { router: { list, send } as never, send, list }
}

describe('dispatchChannelTarget', () => {
  it('feishu 未指定 peer 时自动选第一个可发送 peer', async () => {
    const { router, send } = makeRouter([
      { id: 'ou_blocked', canSend: false },
      { id: 'ou_ok', canSend: true },
    ])
    await dispatchChannelTarget('feishu', '正文', '日报', { getChannelRouter: () => router })
    expect(send).toHaveBeenCalledWith({ channel: 'feishu', to: 'ou_ok', text: '正文', title: '日报' })
  })

  it('feishu:peer 显式指定时不查 list', async () => {
    const { router, send, list } = makeRouter([{ id: 'ou_ok', canSend: true }])
    await dispatchChannelTarget('feishu:ou_explicit', '正文', '日报', { getChannelRouter: () => router })
    expect(list).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith({ channel: 'feishu', to: 'ou_explicit', text: '正文', title: '日报' })
  })

  it('weixin 缺少 peerId 时跳过且不发送', async () => {
    const { router, send } = makeRouter()
    await dispatchChannelTarget('weixin', '正文', '日报', { getChannelRouter: () => router })
    expect(send).not.toHaveBeenCalled()
  })

  it('weixin:peer 走 router.send', async () => {
    const { router, send } = makeRouter()
    await dispatchChannelTarget('weixin:wxid_a', '正文', '日报', { getChannelRouter: () => router })
    expect(send).toHaveBeenCalledWith({ channel: 'weixin', to: 'wxid_a', text: '正文', title: '日报' })
  })

  it('qbot:peer 走 router.send', async () => {
    const { router, send } = makeRouter()
    await dispatchChannelTarget('qbot:user_a', '正文', '日报', { getChannelRouter: () => router })
    expect(send).toHaveBeenCalledWith({ channel: 'qbot', to: 'user_a', text: '正文', title: '日报' })
  })

  it('qbot 缺少 peerId 时跳过且不发送', async () => {
    const { router, send } = makeRouter()
    await dispatchChannelTarget('qbot', '正文', '日报', { getChannelRouter: () => router })
    expect(send).not.toHaveBeenCalled()
  })

  it('Router 不可用时飞书走兜底直发并带任务名前缀', async () => {
    const sendFeishuMessage = vi.fn(async () => ({ ok: true }))
    await dispatchChannelTarget('feishu', '正文', '日报', { sendFeishuMessage })
    expect(sendFeishuMessage).toHaveBeenCalledWith('【日报】\n正文')
  })

  it('Router 不可用且无飞书兜底时静默跳过', async () => {
    const sendFeishuMessage = vi.fn(async () => ({ ok: true }))
    await dispatchChannelTarget('qbot:user_a', '正文', '日报', { sendFeishuMessage })
    expect(sendFeishuMessage).not.toHaveBeenCalled()
  })

  it('wecom 不支持主动推送，直接跳过', async () => {
    const { router, send } = makeRouter()
    await dispatchChannelTarget('wecom:u1', '正文', '日报', { getChannelRouter: () => router })
    expect(send).not.toHaveBeenCalled()
  })

  it('未知目标忽略且不发送', async () => {
    const { router, send } = makeRouter()
    await dispatchChannelTarget('telegram', '正文', '日报', { getChannelRouter: () => router })
    expect(send).not.toHaveBeenCalled()
  })

  it('无可用 peer 的 feishu 目标跳过', async () => {
    const { router, send } = makeRouter([])
    await dispatchChannelTarget('feishu', '正文', '日报', { getChannelRouter: () => router })
    expect(send).not.toHaveBeenCalled()
  })
})
