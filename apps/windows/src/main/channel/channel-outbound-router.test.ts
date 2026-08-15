/**
 * ChannelOutboundRouter 单测：list / send 硬失败路径（mock Provider）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelRegistry } from './channel-registry'
import { ChannelOutboundRouter } from './channel-outbound-router'
import type { ChannelSnapshot, IChannelOutboundProvider } from './outbound-types'

function makeProvider(
  snapshot: ChannelSnapshot,
  sendImpl?: IChannelOutboundProvider['sendText'],
  sendMediaImpl?: IChannelOutboundProvider['sendMedia'],
): IChannelOutboundProvider {
  return {
    channel: snapshot.channel,
    getSnapshot: () => snapshot,
    sendText: sendImpl ?? (async () => ({ ok: true, channel: snapshot.channel })),
    ...(sendMediaImpl ? { sendMedia: sendMediaImpl } : {}),
  }
}

/** 连接可用的飞书快照，peer 固定 ou_known */
const FEISHU_READY: ChannelSnapshot = {
  channel: 'feishu',
  connected: true,
  pushMode: 'native_push',
  peers: [{ id: 'ou_known', canSend: true }],
}

/** 落一个真实临时文件，供 mediaPath 存在性校验使用 */
function makeTempFile(): string {
  const file = path.join(os.tmpdir(), `lumii-media-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  fs.writeFileSync(file, 'lumii')
  return file
}

describe('ChannelOutboundRouter', () => {
  it('list 飞书 connected 时 peers 含 openId', async () => {
    const registry = new ChannelRegistry()
    registry.register(
      makeProvider({
        channel: 'feishu',
        connected: true,
        pushMode: 'native_push',
        peers: [{ id: 'ou_xxx', label: '我', canSend: true }],
      }),
    )
    const router = new ChannelOutboundRouter(registry)
    const list = await router.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.peers[0]!.id).toBe('ou_xxx')
  })

  it('list 微信无 token 时 peers 空或 canSend false', async () => {
    const registry = new ChannelRegistry()
    registry.register(
      makeProvider({
        channel: 'weixin',
        connected: true,
        pushMode: 'cached_reply',
        peers: [{ id: 'wxid_a', canSend: false, blockedReason: 'NO_REPLY_CONTEXT' }],
      }),
    )
    const router = new ChannelOutboundRouter(registry)
    const snap = (await router.list())[0]!
    expect(snap.peers.every((p) => !p.canSend)).toBe(true)
  })

  it('send 缺 to → PEER_NOT_FOUND', async () => {
    const registry = new ChannelRegistry()
    registry.register(
      makeProvider({
        channel: 'feishu',
        connected: true,
        pushMode: 'native_push',
        peers: [{ id: 'ou_xxx', canSend: true }],
      }),
    )
    const router = new ChannelOutboundRouter(registry)
    const res = await router.send({ channel: 'feishu', to: '', text: 'hi' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('PEER_NOT_FOUND')
  })

  it('send 企微 → UNSUPPORTED_PUSH', async () => {
    const registry = new ChannelRegistry()
    registry.register(
      makeProvider(
        {
          channel: 'wecom',
          connected: true,
          pushMode: 'reply_only',
          peers: [{ id: 'u1', canSend: false, blockedReason: 'UNSUPPORTED' }],
        },
        async () => ({
          ok: false,
          errorCode: 'UNSUPPORTED_PUSH',
          message: '企业微信当前仅支持会话内被动回复，不支持主动推送',
        }),
      ),
    )
    const router = new ChannelOutboundRouter(registry)
    const res = await router.send({ channel: 'wecom', to: 'u1', text: 'hi' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('UNSUPPORTED_PUSH')
  })

  it('send 微信有 peer 但无 context → NO_REPLY_CONTEXT', async () => {
    const registry = new ChannelRegistry()
    registry.register(
      makeProvider(
        {
          channel: 'weixin',
          connected: true,
          pushMode: 'cached_reply',
          peers: [{ id: 'wxid_x', canSend: false, blockedReason: 'NO_REPLY_CONTEXT' }],
        },
        async () => ({
          ok: false,
          errorCode: 'NO_REPLY_CONTEXT',
          message: '请先让该用户给 Bot 发一条消息',
        }),
      ),
    )
    const router = new ChannelOutboundRouter(registry)
    const res = await router.send({ channel: 'weixin', to: 'wxid_x', text: 'hi' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('NO_REPLY_CONTEXT')
  })

  it('send 未连接 → CHANNEL_NOT_CONNECTED', async () => {
    const registry = new ChannelRegistry()
    registry.register(
      makeProvider({
        channel: 'feishu',
        connected: false,
        pushMode: 'native_push',
        peers: [],
      }),
    )
    const router = new ChannelOutboundRouter(registry)
    const res = await router.send({ channel: 'feishu', to: 'ou_xxx', text: 'hi' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('CHANNEL_NOT_CONNECTED')
  })

  it('send 未知 peer → PEER_NOT_FOUND', async () => {
    const send = vi.fn(async () => ({ ok: true as const, channel: 'feishu' as const }))
    const registry = new ChannelRegistry()
    registry.register(
      makeProvider(
        {
          channel: 'feishu',
          connected: true,
          pushMode: 'native_push',
          peers: [{ id: 'ou_known', canSend: true }],
        },
        send,
      ),
    )
    const router = new ChannelOutboundRouter(registry)
    const res = await router.send({ channel: 'feishu', to: 'ou_unknown', text: 'hi' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('PEER_NOT_FOUND')
    expect(send).not.toHaveBeenCalled()
  })

  it('send 带 mediaPath 时走 sendMedia 且补齐 fileName', async () => {
    const file = makeTempFile()
    const sendMedia = vi.fn(async () => ({ ok: true as const, channel: 'feishu' as const }))
    const sendText = vi.fn(async () => ({ ok: true as const, channel: 'feishu' as const }))
    const registry = new ChannelRegistry()
    registry.register(makeProvider(FEISHU_READY, sendText, sendMedia))
    const router = new ChannelOutboundRouter(registry)

    const res = await router.send({ channel: 'feishu', to: 'ou_known', text: '请查收', mediaPath: file })

    expect(res.ok).toBe(true)
    expect(sendText).not.toHaveBeenCalled()
    expect(sendMedia).toHaveBeenCalledWith({
      to: 'ou_known',
      text: '请查收',
      mediaPath: file,
      fileName: path.basename(file),
    })
    fs.unlinkSync(file)
  })

  it('send 的 mediaPath 不存在 → MEDIA_NOT_FOUND', async () => {
    const sendMedia = vi.fn(async () => ({ ok: true as const, channel: 'feishu' as const }))
    const registry = new ChannelRegistry()
    registry.register(makeProvider(FEISHU_READY, undefined, sendMedia))
    const router = new ChannelOutboundRouter(registry)

    const res = await router.send({
      channel: 'feishu',
      to: 'ou_known',
      text: '',
      mediaPath: path.join(os.tmpdir(), 'lumii-not-exist-xyz.png'),
    })

    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('MEDIA_NOT_FOUND')
    expect(sendMedia).not.toHaveBeenCalled()
  })

  it('send 的 mediaPath 非绝对路径 → MEDIA_NOT_FOUND', async () => {
    const registry = new ChannelRegistry()
    registry.register(makeProvider(FEISHU_READY, undefined, async () => ({ ok: true, channel: 'feishu' })))
    const router = new ChannelOutboundRouter(registry)

    const res = await router.send({ channel: 'feishu', to: 'ou_known', text: '', mediaPath: 'outputs/a.png' })

    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('MEDIA_NOT_FOUND')
  })

  it('Provider 未实现 sendMedia → UNSUPPORTED_MEDIA', async () => {
    const file = makeTempFile()
    const registry = new ChannelRegistry()
    registry.register(makeProvider(FEISHU_READY))
    const router = new ChannelOutboundRouter(registry)

    const res = await router.send({ channel: 'feishu', to: 'ou_known', text: '', mediaPath: file })

    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('UNSUPPORTED_MEDIA')
    fs.unlinkSync(file)
  })
})
