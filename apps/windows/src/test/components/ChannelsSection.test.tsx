/**
 * ChannelsSection：渠道设置分区的连接汇总与 peer 合并展示
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ChannelsSection } from '../../renderer/pages/SettingsPage/components/ChannelsSection'
import { rendererApi } from '../../plugins/api'
import { channelWeixinRenderer } from '../../plugins/builtin/channel-weixin/renderer'
import { channelWecomRenderer } from '../../plugins/builtin/channel-wecom/renderer'
import { channelFeishuRenderer } from '../../plugins/builtin/channel-feishu/renderer'
import { channelQbotRenderer } from '../../plugins/builtin/channel-qbot/renderer'
import { pcwechatRenderer } from '../../plugins/builtin/pcwechat/renderer'

/**
 * 构造三个渠道登录服务的最小 mock；返回值统一为 idle，便于按用例覆盖。
 */
const READY_MCP = {
  state: 'ready',
  label: 'v0.10.0',
  missingTools: [],
  outdated: false,
}

function mockChannelServices(overrides: {
  weixinStatus?: string
  weixinSession?: unknown
  channels?: unknown[]
  /** 覆盖 MCP 检测结果（默认就绪） */
  mcpStatus?: Record<string, unknown>
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
  ;(window as any).qbotService = { ...base }
  ;(window as any).channelService = {
    list: vi.fn(async () => ({ channels: overrides.channels ?? [] })),
    send: vi.fn(),
    // 本机微信卡片挂载即读策略；没配过时返回默认档（只提醒）
    getPolicy: vi.fn(async () => ({ defaultMode: 'notify', peers: [] })),
    setPolicy: vi.fn(async (_c: string, p: unknown) => p),
    // MCP 检测（只读）：默认「已连接且工具齐」= 就绪。
    // MCP 由用户自己配（与插件解耦），卡片不再有安装按钮——缺了只提示并跳设置。
    wechatMcpStatus: vi.fn(async () => overrides.mcpStatus ?? READY_MCP),
    wechatSelfcheck: vi.fn(async () => ({
      at: Date.now(),
      connected: true,
      db: { ok: true, root: 'D:/wx', source: 'ini', wxid: 'wxid_a' },
      env: { ok: true },
      actions: [],
      ok: true,
      reason: '',
    })),
  }
}

describe('ChannelsSection', () => {
  let slotDisposers: Array<() => void> = []

  beforeEach(() => {
    // 五个渠道卡片由插件注册（与真实运行同一条 setup 路径）
    slotDisposers = [
      channelWeixinRenderer.setup(rendererApi),
      channelWecomRenderer.setup(rendererApi),
      channelFeishuRenderer.setup(rendererApi),
      channelQbotRenderer.setup(rendererApi),
      pcwechatRenderer.setup(rendererApi),
    ]
    vi.restoreAllMocks()
  })

  afterEach(() => {
    for (const dispose of slotDisposers) dispose()
    slotDisposers = []
  })

  it('五个渠道均未连接时汇总显示 0 / 5', async () => {
    mockChannelServices({})
    render(<ChannelsSection />)

    expect(await screen.findByText('0 / 5 渠道已连接')).toBeInTheDocument()
    // 渠道名在页面上出现两处：上方「渠道由谁接管」路由表 + 下面各自的卡片，
    // 所以按「至少出现一次」断言，而不是 getByText 的唯一性
    for (const label of ['微信（个人）', '企业微信', '飞书', 'QQ', '本机微信']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('本机微信：卡片摘要说人话——谁、什么档、名单外怎么办', async () => {
    mockChannelServices({
      channels: [
        {
          channel: 'pcwechat',
          connected: true,
          pushMode: 'native_push',
          peers: [{ id: 'wxid_loop', label: '阿呆', canSend: true }],
        },
      ],
    })
    ;(window as any).channelService.getPolicy = vi.fn(async () => ({
      defaultMode: 'ignore',
      peers: [
        { id: 'wxid_loop', label: '阿呆', mode: 'auto', cooldownSeconds: 90 },
        { id: 'filehelper', mode: 'ignore' },
      ],
    }))
    render(<ChannelsSection />)

    expect(await screen.findByText('1 / 5 渠道已连接')).toBeInTheDocument()
    // 黑名单（ignore）不算"可代回"的人
    expect(await screen.findByText('1 人')).toBeInTheDocument()
    expect(screen.getByText('阿呆·直接代回')).toBeInTheDocument()
    expect(screen.getByText('不处理（黑名单）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '配置' })).toBeInTheDocument()
  })

  it('MCP 没配时卡片不给安装按钮，而是把人送到「设置 › MCP 服务」', async () => {
    mockChannelServices({
      mcpStatus: {
        state: 'not-configured',
        label: '未配置',
        missingTools: [],
        outdated: false,
        hint: '还没有在本机配置这个 MCP：到「设置 › MCP 服务」添加。',
      },
    })
    const onNavigate = vi.fn()
    window.addEventListener('mtbot:navigate-request', onNavigate)
    render(<ChannelsSection />)

    // MCP 与插件解耦：卡片上**没有**安装入口，只有跳转
    expect(screen.queryByRole('button', { name: '安装微信本机助手' })).toBeNull()
    const go = await screen.findByRole('button', { name: '去配置 MCP' })
    go.click()
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect((onNavigate.mock.calls[0]![0] as CustomEvent).detail).toEqual({ view: 'mcp' })
    window.removeEventListener('mtbot:navigate-request', onNavigate)
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

    expect(await screen.findByText('1 / 5 渠道已连接')).toBeInTheDocument()
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
