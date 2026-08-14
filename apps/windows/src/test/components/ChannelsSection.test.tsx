/**
 * ChannelsSection：渠道设置分区的连接汇总与 peer 合并展示
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ChannelsSection } from '../../renderer/pages/SettingsPage/components/ChannelsSection'

/**
 * 构造三个渠道登录服务的最小 mock；返回值统一为 idle，便于按用例覆盖。
 */
function mockChannelServices(overrides: {
  weixinStatus?: string
  weixinSession?: unknown
  channels?: unknown[]
}) {
  const noopSubscribe = () => () => undefined
  const base = {
    startLogin: vi.fn(),
    logout: vi.fn(),
    getStatus: vi.fn(async () => 'idle'),
    getSession: vi.fn(async () => null),
    onStatusChange: noopSubscribe,
    onQrcode: noopSubscribe,
    onError: noopSubscribe,
  }

  ;(window as any).weixinService = {
    ...base,
    getStatus: vi.fn(async () => overrides.weixinStatus ?? 'idle'),
    getSession: vi.fn(async () => overrides.weixinSession ?? null),
  }
  ;(window as any).wecomService = { ...base }
  ;(window as any).feishuService = { ...base }
  ;(window as any).channelService = {
    list: vi.fn(async () => ({ channels: overrides.channels ?? [] })),
    send: vi.fn(),
  }
}

describe('ChannelsSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('三个渠道均未连接时汇总显示 0 / 3', async () => {
    mockChannelServices({})
    render(<ChannelsSection />)

    expect(await screen.findByText('0 / 3 渠道已连接')).toBeInTheDocument()
    expect(screen.getByText('微信（个人）')).toBeInTheDocument()
    expect(screen.getByText('企业微信')).toBeInTheDocument()
    expect(screen.getByText('飞书')).toBeInTheDocument()
  })

  it('微信已连接时展示 meta 与可发送对象芯片', async () => {
    mockChannelServices({
      weixinStatus: 'logged_in',
      weixinSession: { userId: 'wxid_self', botToken: 't', loginAt: Date.now() - 3600 * 1000 },
      channels: [
        {
          channel: 'weixin',
          connected: true,
          pushMode: 'cached_reply',
          peers: [{ id: 'wxid_a1b2c3', label: '小明', canSend: true }],
        },
      ],
    })
    render(<ChannelsSection />)

    expect(await screen.findByText('1 / 3 渠道已连接')).toBeInTheDocument()
    expect(screen.getByText('可发送对象 · 1')).toBeInTheDocument()
    expect(screen.getByText('小明')).toBeInTheDocument()
    expect(screen.getByText('wxid_a1b2c3')).toBeInTheDocument()
    expect(screen.getByText('主动发送（依赖 24h 内会话）')).toBeInTheDocument()
  })

  it('已连接但无 peer 时给出引导文案', async () => {
    mockChannelServices({
      weixinStatus: 'logged_in',
      weixinSession: { userId: 'wxid_self', botToken: 't', loginAt: Date.now() },
      channels: [{ channel: 'weixin', connected: true, pushMode: 'cached_reply', peers: [] }],
    })
    render(<ChannelsSection />)

    expect(
      await screen.findByText('暂无记录，等对方给 Bot 发一条消息后出现在这里')
    ).toBeInTheDocument()
  })
})
