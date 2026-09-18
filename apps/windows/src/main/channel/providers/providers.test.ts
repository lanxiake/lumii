/**
 * 三渠道 Outbound Provider 行为单测（mock LoginService / Store）。
 */
import { describe, expect, it, vi } from 'vitest'
import { FeishuChannelProvider } from './feishu-outbound-provider'
import { WeixinChannelProvider } from './weixin-outbound-provider'
import { WecomChannelProvider } from './wecom-outbound-provider'
import { QbotChannelProvider } from './qbot-outbound-provider'
import { WeixinReplyContextStore } from '../weixin-reply-context-store'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('FeishuChannelProvider', () => {
  it('connected 时 peers 含 openId，send 调用 pushSmart(to, title)', async () => {
    const pushSmart = vi.fn(async () => ({ ok: true }))
    const login = {
      getStatus: () => 'connected' as const,
      getSessionPublic: () => ({ openId: 'ou_me' }),
      pushSmart,
    }
    const provider = new FeishuChannelProvider(login as never)
    const snap = provider.getSnapshot()
    expect(snap.peers[0]?.id).toBe('ou_me')
    const res = await provider.sendText({ to: 'ou_me', text: 'hi', title: '日报' })
    expect(res.ok).toBe(true)
    expect(pushSmart).toHaveBeenCalledWith('hi', 'ou_me', '日报')
  })

  it('sendMedia 先发随附文本再发文件', async () => {
    const pushSmart = vi.fn(async () => ({ ok: true }))
    const pushMedia = vi.fn(async () => ({ ok: true }))
    const login = {
      getStatus: () => 'connected' as const,
      getSessionPublic: () => ({ openId: 'ou_me' }),
      pushSmart,
      pushMedia,
    }
    const provider = new FeishuChannelProvider(login as never)
    const res = await provider.sendMedia({
      to: 'ou_me',
      text: '请查收',
      mediaPath: 'C:/tmp/a.png',
      fileName: 'a.png',
    })
    expect(res.ok).toBe(true)
    expect(pushSmart).toHaveBeenCalledWith('请查收', 'ou_me')
    expect(pushMedia).toHaveBeenCalledWith('C:/tmp/a.png', 'ou_me', 'a.png')
  })

  it('sendMedia 上传失败时硬失败并带上游原因', async () => {
    const login = {
      getStatus: () => 'connected' as const,
      getSessionPublic: () => ({ openId: 'ou_me' }),
      pushSmart: vi.fn(async () => ({ ok: true })),
      pushMedia: vi.fn(async () => ({ ok: false, error: '飞书图片上传失败 234001: bad file' })),
    }
    const provider = new FeishuChannelProvider(login as never)
    const res = await provider.sendMedia({ to: 'ou_me', mediaPath: 'C:/tmp/a.png', fileName: 'a.png' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('UPSTREAM_ERROR')
    expect(res.message).toContain('234001')
  })
})

describe('WeixinChannelProvider', () => {
  it('无 token 时 send 返回 NO_REPLY_CONTEXT', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-prov-'))
    const store = new WeixinReplyContextStore(path.join(tmp, 'ctx.json'))
    const login = {
      getStatus: () => 'logged_in' as const,
      sendTextReply: vi.fn(),
    }
    const provider = new WeixinChannelProvider(login as never, store)
    // 白名单需要 peer：先 upsert 空 token 不会写入；用假 peer 场景 —— store 无记录时
    // Provider 直接 NO_REPLY_CONTEXT（Router 白名单另测）
    const res = await provider.sendText({ to: 'wxid_x', text: 'hi' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('NO_REPLY_CONTEXT')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('有 token 时调用 sendTextReply', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-prov-'))
    const store = new WeixinReplyContextStore(path.join(tmp, 'ctx.json'))
    store.upsert({
      channelUserId: 'wxid_x',
      contextToken: 'tok',
      botToken: 'bot',
      updatedAt: Date.now(),
      lastNickname: '张三',
    })
    const sendTextReply = vi.fn(async () => true)
    const login = {
      getStatus: () => 'logged_in' as const,
      sendTextReply,
    }
    const provider = new WeixinChannelProvider(login as never, store)
    const snap = provider.getSnapshot()
    expect(snap.peers[0]?.canSend).toBe(true)
    const res = await provider.sendText({ to: 'wxid_x', text: 'hi' })
    expect(res.ok).toBe(true)
    expect(sendTextReply).toHaveBeenCalled()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('sendMedia 用持久化 token 调用 sendMediaReply', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-prov-'))
    const store = new WeixinReplyContextStore(path.join(tmp, 'ctx.json'))
    store.upsert({
      channelUserId: 'wxid_x',
      contextToken: 'tok',
      botToken: 'bot',
      ilinkBaseUrl: 'https://ilink.example',
      updatedAt: Date.now(),
    })
    const sendTextReply = vi.fn(async () => true)
    const sendMediaReply = vi.fn(async () => true)
    const login = { getStatus: () => 'logged_in' as const, sendTextReply, sendMediaReply }
    const provider = new WeixinChannelProvider(login as never, store)

    const res = await provider.sendMedia({
      to: 'wxid_x',
      text: '请查收',
      mediaPath: 'C:/tmp/a.pdf',
      fileName: 'a.pdf',
    })

    expect(res.ok).toBe(true)
    expect(sendTextReply).toHaveBeenCalledWith('wxid_x', '请查收', 'tok', 'bot', 'https://ilink.example')
    expect(sendMediaReply).toHaveBeenCalledWith('wxid_x', 'C:/tmp/a.pdf', 'a.pdf', 'tok', 'bot', 'https://ilink.example')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('sendMedia 无 token 时 NO_REPLY_CONTEXT 且不触发上传', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-prov-'))
    const store = new WeixinReplyContextStore(path.join(tmp, 'ctx.json'))
    const sendMediaReply = vi.fn(async () => true)
    const login = { getStatus: () => 'logged_in' as const, sendTextReply: vi.fn(), sendMediaReply }
    const provider = new WeixinChannelProvider(login as never, store)

    const res = await provider.sendMedia({ to: 'wxid_x', mediaPath: 'C:/tmp/a.pdf', fileName: 'a.pdf' })

    expect(res.errorCode).toBe('NO_REPLY_CONTEXT')
    expect(sendMediaReply).not.toHaveBeenCalled()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('WecomChannelProvider', () => {
  it('send 恒返回 UNSUPPORTED_PUSH', async () => {
    const login = { getStatus: () => 'connected' as const }
    const provider = new WecomChannelProvider(login as never)
    provider.rememberInboundPeer('u1', '同事')
    const snap = provider.getSnapshot()
    expect(snap.pushMode).toBe('reply_only')
    expect(snap.peers[0]?.canSend).toBe(false)
    const res = await provider.sendText({ to: 'u1', text: 'hi' })
    expect(res.errorCode).toBe('UNSUPPORTED_PUSH')
  })

  it('sendMedia 同样返回 UNSUPPORTED_PUSH', async () => {
    const login = { getStatus: () => 'connected' as const }
    const provider = new WecomChannelProvider(login as never)
    const res = await provider.sendMedia({ to: 'u1', mediaPath: 'C:/tmp/a.png', fileName: 'a.png' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('UNSUPPORTED_PUSH')
  })

  it('setSnapshotRestore 恢复的 peer 仍标记为不可主动发送', () => {
    const login = { getStatus: () => 'connected' as const }
    const provider = new WecomChannelProvider(login as never)
    provider.setSnapshotRestore([{ id: 'u1', label: '同事', canSend: true }])
    const snap = provider.getSnapshot()
    expect(snap.peers[0]?.id).toBe('u1')
    expect(snap.peers[0]?.canSend).toBe(false)
    expect(snap.peers[0]?.blockedReason).toBe('UNSUPPORTED')
  })
})

describe('QbotChannelProvider', () => {
  it('未连接时 peers 为空，连接后恢复的 peer 可列出', () => {
    let status = 'idle'
    const login = { getStatus: () => status as 'idle' | 'connected' }
    const provider = new QbotChannelProvider(login as never)
    provider.setSnapshotRestore([{ id: 'openid_1', label: '小明', canSend: true }])
    expect(provider.getSnapshot().peers).toHaveLength(0)
    status = 'connected'
    const snap = provider.getSnapshot()
    expect(snap.peers[0]?.id).toBe('openid_1')
    expect(snap.peers[0]?.canSend).toBe(true)
    expect(snap.peers[0]?.lastInboundAt).toBeGreaterThan(0)
  })

  it('窗口过期时 send 一律走同一路径（不在 Provider 层按时间过滤 peer）', async () => {
    const login = {
      getStatus: () => 'connected' as const,
      replyMarkdown: vi.fn(async () => false),
    }
    const provider = new QbotChannelProvider(login as never)
    provider.setSnapshotRestore([{ id: 'openid_old', canSend: true }])
    const res = await provider.sendText({ to: 'openid_old', text: 'hi' })
    expect(login.replyMarkdown).toHaveBeenCalledWith('openid_old', 'hi', 'p2p', undefined)
    expect(res.errorCode).toBe('UPSTREAM_ERROR')
  })

  it('向从未入站的 openid 发送被拒绝，不落到上游', async () => {
    const login = {
      getStatus: () => 'connected' as const,
      replyMarkdown: vi.fn(async () => true),
    }
    const provider = new QbotChannelProvider(login as never)
    const res = await provider.sendText({ to: 'openid_never_seen', text: 'hi' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('PEER_NOT_FOUND')
    expect(login.replyMarkdown).not.toHaveBeenCalled()
  })
})
