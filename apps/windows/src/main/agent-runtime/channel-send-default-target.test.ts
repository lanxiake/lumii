/**
 * channel_send 默认路由测试：省略 channel/to 时回本轮消息来源渠道的当前会话。
 *
 * 背景：用户从 QQ 说「把文件发给我」，模型此前会挑列表里唯一有 peer 的飞书，
 * 造成「在哪个渠道说话、却发到另一个渠道」。默认值取 presence（消息来源 + 回信地址）。
 */
import { describe, expect, it, vi } from 'vitest'

const { registerChannelTools } = await import('./bridge-tool-registrar-integration')

interface Presence {
  userAtClient: boolean
  channelLabel?: string
  channelType?: string
  channelUserId?: string
  replyTo?: string
}

function makeRegistrar(opts: {
  presence?: Presence
  instanceId?: string
  routerSend?: (params: unknown) => Promise<{ ok: boolean; errorCode?: string; message?: string }>
}) {
  const registered = new Map<string, { execute: (...args: unknown[]) => unknown }>()
  const toolRegistry = {
    register: (tool: { name: string; execute: (...args: unknown[]) => unknown }) => {
      registered.set(tool.name, tool)
    },
  }
  const instanceId = opts.instanceId ?? 'inst-1'
  const routerSendMock = opts.routerSend ?? vi.fn(async () => ({ ok: true }))
  const deps = {
    toolRegistry,
    toolContext: {},
    config: {},
    getChannelRouter: () => ({ send: routerSendMock, list: vi.fn(async () => []) }),
    toolCallInstanceMap: new Map([['call-1', instanceId]]),
    instanceStates: new Map(
      opts.presence ? [[instanceId, { presence: opts.presence }]] : [],
    ),
    getCurrentToolExecutorInstanceId: () => instanceId,
  } as unknown as Parameters<typeof registerChannelTools>[0]
  registerChannelTools(deps)
  return { tool: registered.get('channel_send')!, routerSendMock }
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0].text)
}

describe('channel_send 默认回来源渠道', () => {
  it('QQ 会话里省略 channel/to → 发回 QQ 当前会话（而不是飞书）', async () => {
    const { tool, routerSendMock } = makeRegistrar({
      presence: {
        userAtClient: false,
        channelLabel: 'QQ',
        channelType: 'qbot',
        channelUserId: 'openid_me',
        replyTo: 'openid_me',
      },
    })

    const result = await tool.execute('call-1', { text: '给你', mediaPath: 'C:\\tmp\\a.md' })

    expect(routerSendMock).toHaveBeenCalledWith({
      channel: 'qbot',
      to: 'openid_me',
      text: '给你',
      mediaPath: 'C:\\tmp\\a.md',
    })
    expect(textOf(result)).toMatchObject({ ok: true })
  })

  it('QQ 群聊里回信地址是群 openid（replyTo 与 channelUserId 不同）', async () => {
    const { tool, routerSendMock } = makeRegistrar({
      presence: {
        userAtClient: false,
        channelType: 'qbot',
        channelUserId: 'member_openid',
        replyTo: 'group:group_openid',
      },
    })

    await tool.execute('call-1', { text: '群里见' })

    expect(routerSendMock).toHaveBeenCalledWith({
      channel: 'qbot',
      to: 'group:group_openid',
      text: '群里见',
    })
  })

  it('显式指定别的渠道仍以显式为准（用户明确要发飞书）', async () => {
    const { tool, routerSendMock } = makeRegistrar({
      presence: {
        userAtClient: false,
        channelType: 'qbot',
        channelUserId: 'openid_me',
        replyTo: 'openid_me',
      },
    })

    await tool.execute('call-1', { channel: 'feishu', to: 'ou_boss', text: '日报' })

    expect(routerSendMock).toHaveBeenCalledWith({
      channel: 'feishu',
      to: 'ou_boss',
      text: '日报',
    })
  })

  it('客户端会话（无 presence）省略 channel → 硬失败提示先 list，不发到任意渠道', async () => {
    const { tool, routerSendMock } = makeRegistrar({ instanceId: 'inst-none' })

    const result = await tool.execute('call-x', { text: 'hi' })

    expect(routerSendMock).not.toHaveBeenCalled()
    expect(textOf(result)).toMatchObject({ ok: false, errorCode: 'PEER_NOT_FOUND' })
  })

  it('群聊缺回信地址时省略 to → 硬失败，不猜收件人', async () => {
    const { tool, routerSendMock } = makeRegistrar({
      presence: {
        userAtClient: false,
        channelType: 'wecom',
        channelUserId: 'user_1',
        // 无 replyTo：群 chatId 缺失
      },
    })

    const result = await tool.execute('call-1', { text: 'hi' })

    expect(routerSendMock).not.toHaveBeenCalled()
    const body = textOf(result)
    expect(body.ok).toBe(false)
    expect(String(body.message)).toContain('channel_list')
  })
})
