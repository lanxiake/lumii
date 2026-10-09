/**
 * 各渠道 Outbound Provider 行为单测（mock LoginService / Store / MCP）。
 */
import { describe, expect, it, vi } from 'vitest'
import { FeishuChannelProvider } from './feishu-outbound-provider'
import { WeixinChannelProvider } from './weixin-outbound-provider'
import { WecomChannelProvider } from './wecom-outbound-provider'
import { QbotChannelProvider } from './qbot-outbound-provider'
import { PcwechatChannelProvider } from './pcwechat-outbound-provider'
import { WeixinReplyContextStore } from '../weixin-reply-context-store'
import type { ChannelPolicy } from '../../../shared/channel-policy'
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

/**
 * 本机微信：对面是真人，发出去收不回。所以这一组测试盯的是**失败闭合**——
 * 名单之外发不出去、工具没给出"确实发了"的确认就不许报成功。
 */
describe('PcwechatChannelProvider', () => {
  const policy = (
    peers: ChannelPolicy['peers'],
    extra: Partial<ChannelPolicy> = {},
  ): ChannelPolicy => ({ defaultMode: 'notify', peers, ...extra })

  function make(opts: { policy?: ChannelPolicy; connected?: boolean; reply?: string } = {}) {
    const callMcpTool = vi.fn(
      async () => opts.reply ?? '{"ok":true,"detail":"sent","dry_run":false}',
    )
    const onUndeliverable = vi.fn()
    const provider = new PcwechatChannelProvider({
      getPolicy: () => opts.policy ?? policy([{ id: 'wxid_loop', label: 'Loop', mode: 'auto' }]),
      mcpServer: 'wechat-local',
      isMcpConnected: () => opts.connected ?? true,
      callMcpTool,
      onUndeliverable,
    })
    return { provider, callMcpTool, onUndeliverable }
  }

  it('MCP 没连上 = 不在线：名单为空，发送直接失败且不碰工具', async () => {
    const { provider, callMcpTool } = make({ connected: false })
    expect(provider.getSnapshot().connected).toBe(false)
    expect(provider.getSnapshot().peers).toEqual([])
    const res = await provider.sendText({ to: 'wxid_loop', text: '在吗' })
    expect(res.errorCode).toBe('CHANNEL_NOT_CONNECTED')
    expect(callMcpTool).not.toHaveBeenCalled()
  })

  it('peers = 策略里非 ignore 的名单（黑名单与没配过的人都不出现）', () => {
    const { provider } = make({
      policy: policy([
        { id: 'filehelper', mode: 'ignore' },
        { id: 'wxid_loop', label: 'Loop', mode: 'auto' },
        { id: 'wxid_draft', label: '待点头的人', mode: 'draft' },
      ]),
    })
    expect(provider.getSnapshot().peers.map((p) => p.id)).toEqual(['wxid_loop', 'wxid_draft'])
  })

  it('名单里的人发得出去，且显式 dry_run=false（工具的默认值是只校验）', async () => {
    const { provider, callMcpTool } = make()
    const res = await provider.sendText({ to: 'wxid_loop', text: '在的' })
    expect(res).toEqual({ ok: true, channel: 'pcwechat', to: 'wxid_loop' })
    expect(callMcpTool).toHaveBeenCalledWith('wechat-local', 'send_text', {
      talker: 'wxid_loop',
      text: '在的',
      dry_run: false,
    })
  })

  it('名单外（含黑名单）不发：Router 之外的第二道白名单', async () => {
    const { provider, callMcpTool } = make({ policy: policy([{ id: 'filehelper', mode: 'ignore' }]) })
    for (const to of ['filehelper', 'wxid_陌生人']) {
      const res = await provider.sendText({ to, text: 'hi' })
      expect(res.errorCode, to).toBe('PEER_NOT_FOUND')
    }
    expect(callMcpTool).not.toHaveBeenCalled()
  })

  it('env_not_ready = 此刻够不着（锁屏/抢不到前台）：投进待补发队列；别的失败不投', async () => {
    const { provider, onUndeliverable } = make({
      reply: '{"ok":false,"error_code":"env_not_ready","detail":"电脑已锁屏"}',
    })
    await provider.sendText({ to: 'wxid_loop', text: '10月9号 周五' })
    expect(onUndeliverable).toHaveBeenCalledWith('wxid_loop', '10月9号 周五')

    // 内容问题（找不到会话）重试一万次也没用——不进队列，否则队列会变成噪声桶
    const { provider: badTarget, onUndeliverable: notQueued } = make({
      reply: '{"ok":false,"error_code":"target_not_found","detail":"未找到目标会话"}',
    })
    await badTarget.sendText({ to: 'wxid_loop', text: '在的' })
    expect(notQueued).not.toHaveBeenCalled()
  })

  it('target_unconfirmed = 会话切不过去：也进队列（fail-closed 没输入过字，补发不会重复发）', async () => {
    const { provider, onUndeliverable } = make({
      reply: '{"ok":false,"error_code":"target_unconfirmed","detail":"目标会话未确认（fail-closed）"}',
    })
    const res = await provider.sendText({ to: 'wxid_loop', text: '在的' })
    expect(onUndeliverable).toHaveBeenCalledWith('wxid_loop', '在的')
    // 队列归队列，这次 send 的结论仍是没送达——不能因为"排上了"就回报已发送；
    // 但要带 queued 让工具层报「排队中」而不是失败
    expect(res.ok).toBe(false)
    expect(res.queued).toBe(true)
    expect(res.message).toContain('已排队待补发')
  })

  it('没排上（内容问题 / 没接队列）就不带 queued：照实报失败', async () => {
    const { provider } = make({
      reply: '{"ok":false,"error_code":"target_not_found","detail":"未找到目标会话"}',
    })
    expect((await provider.sendText({ to: 'wxid_loop', text: '在的' })).queued).toBeUndefined()

    const bare = new PcwechatChannelProvider({
      getPolicy: () => policy([{ id: 'wxid_loop', mode: 'auto' }]),
      mcpServer: 'wechat-local',
      isMcpConnected: () => true,
      callMcpTool: async () => '{"ok":false,"error_code":"target_unconfirmed","detail":"x"}',
    })
    const res = await bare.sendText({ to: 'wxid_loop', text: '在的' })
    expect(res.ok).toBe(false)
    expect(res.queued).toBeUndefined()
  })

  it('队列本身抛异常也不改写这次发送的结论（失败的判定比排队重要）', async () => {
    const { provider, onUndeliverable } = make({
      reply: '{"ok":false,"error_code":"env_not_ready","detail":"电脑已锁屏"}',
    })
    onUndeliverable.mockImplementation(() => {
      throw new Error('db 炸了')
    })
    const res = await provider.sendText({ to: 'wxid_loop', text: '在的' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('CHANNEL_NOT_CONNECTED')
    // 没排上就绝不能对外宣称「会自动补发」
    expect(res.queued).toBeUndefined()
  })

  it('工具只做了演练（ok:true 但 dry_run 不是 false）绝不算发出去', async () => {
    const { provider } = make({ reply: '{"ok":true,"detail":"dry","dry_run":true}' })
    const res = await provider.sendText({ to: 'wxid_loop', text: '在的' })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('演练')
  })

  it('上游失败归一：窗口拿不到前台 → 未连接；send_not_confirmed → 不可重试的上游错误', async () => {
    const { provider: envFail } = make({
      reply: '{"ok":false,"error_code":"env_not_ready","detail":"微信窗口切不到前台","suggestion":"请确保微信窗口可见"}',
    })
    const r1 = await envFail.sendText({ to: 'wxid_loop', text: '在的' })
    expect(r1.errorCode).toBe('CHANNEL_NOT_CONNECTED')
    expect(r1.message).toContain('窗口')

    const { provider: unconfirmed } = make({
      reply: '{"ok":false,"error_code":"send_not_confirmed","detail":"已按回车但读库没看到新消息"}',
    })
    const r2 = await unconfirmed.sendText({ to: 'wxid_loop', text: '在的' })
    expect(r2.errorCode).toBe('UPSTREAM_ERROR')
    expect(r2.message).toContain('读库')
  })
})
