/**
 * channelService IPC 转发单测：覆盖 Hub 未就绪、参数校验、list/send 同源转发。
 */
import { describe, expect, it, vi } from 'vitest'
import { handleChannelList, handleChannelSend } from './channel-service-ipc'

describe('handleChannelList', () => {
  it('Hub 未就绪时返回空 channels', async () => {
    await expect(handleChannelList(null)).resolves.toEqual({ channels: [] })
    await expect(handleChannelList(undefined)).resolves.toEqual({ channels: [] })
  })

  it('转发 router.list 结果', async () => {
    const channels = [
      { channel: 'feishu' as const, connected: true, pushMode: 'native_push' as const, peers: [] },
    ]
    const list = vi.fn(async () => channels)
    const result = await handleChannelList({ router: { list, send: vi.fn() } as never })
    expect(list).toHaveBeenCalledOnce()
    expect(result).toEqual({ channels })
  })
})

describe('handleChannelSend', () => {
  it('Hub 未就绪返回 HUB_NOT_READY', async () => {
    const result = await handleChannelSend(null, { channel: 'feishu', to: 'ou_1', text: 'hi' })
    expect(result).toMatchObject({ ok: false, errorCode: 'HUB_NOT_READY' })
  })

  it('非法 channel 硬失败，不调用 router.send', async () => {
    const send = vi.fn()
    const result = await handleChannelSend(
      { router: { list: vi.fn(), send } as never },
      { channel: 'telegram', to: 'x', text: 'hi' },
    )
    expect(send).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, errorCode: 'PEER_NOT_FOUND' })
  })

  it('合法参数转发 router.send（含可选 mediaPath）', async () => {
    const send = vi.fn(async () => ({ ok: true as const, channel: 'weixin' as const, to: 'wxid_1' }))
    const result = await handleChannelSend(
      { router: { list: vi.fn(), send } as never },
      { channel: 'weixin', to: 'wxid_1', text: 'hello', mediaPath: 'C:/a.png', fileName: 'a.png' },
    )
    expect(send).toHaveBeenCalledWith({
      channel: 'weixin',
      to: 'wxid_1',
      text: 'hello',
      mediaPath: 'C:/a.png',
      fileName: 'a.png',
    })
    expect(result).toEqual({ ok: true, channel: 'weixin', to: 'wxid_1' })
  })
})
