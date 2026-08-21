/**
 * message 工具 execute 覆盖逻辑测试
 *
 * 二期改造：微信分支改走 ChannelOutboundRouter.send（不再用 sendWeixinMessage 回调），
 * 非微信分支不再走 Gateway send RPC（遗留代码已删除），改为硬失败提示改用 channel_list/channel_send。
 */
import { describe, expect, it, vi } from 'vitest'

const { BridgeToolRegistrar } = await import('./bridge-tool-registrar')

interface WeixinCtxValue {
  channelUserId: string
  contextToken: string
  botToken?: string
  ilinkBaseUrl?: string
}

function makeRegistrar(opts: {
  weixinCtx: WeixinCtxValue | null
  routerSend?: (params: unknown) => Promise<{ ok: boolean; errorCode?: string; message?: string }>
  router?: unknown
}) {
  const registered = new Map<string, { execute: (...args: unknown[]) => unknown }>()
  const toolRegistry = {
    register: (tool: { name: string; execute: (...args: unknown[]) => unknown }) => {
      registered.set(tool.name, tool)
    },
  }
  const routerSendMock = opts.routerSend ?? vi.fn(async () => ({ ok: true }))
  const router = opts.router !== undefined ? opts.router : { send: routerSendMock }
  const markSentViaToolMock = vi.fn()
  const deps = {
    toolRegistry,
    toolContext: {},
    config: {},
    weixinCtx: {
      getCurrent: () => opts.weixinCtx,
      markSentViaTool: markSentViaToolMock,
    },
    getChannelRouter: () => router,
    ipcChannel: { forwardIpcEvent: vi.fn() },
    getConversationRepo: () => null,
    getMemoryManager: () => null,
  } as unknown as ConstructorParameters<typeof BridgeToolRegistrar>[0]
  const registrar = new BridgeToolRegistrar(deps)
  ;(registrar as unknown as { registerIntegrationTools: () => void }).registerIntegrationTools()
  return { tool: registered.get('message')!, routerSendMock, markSentViaToolMock }
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0].text)
}

describe('message 工具 execute（channel=weixin / 隐式微信）', () => {
  it('无 channel 参数但有活跃微信会话时，隐式回微信，经 router.send 发送', async () => {
    const weixinCtx: WeixinCtxValue = { channelUserId: 'wx-user-1', contextToken: 'tok-1' }
    const routerSendMock = vi.fn(async () => ({ ok: true }))
    const { tool, markSentViaToolMock } = makeRegistrar({ weixinCtx, routerSend: routerSendMock })

    const result = await tool.execute('call-1', { text: '你好' })

    expect(routerSendMock).toHaveBeenCalledWith({
      channel: 'weixin',
      to: 'wx-user-1',
      text: '你好',
    })
    expect(markSentViaToolMock).toHaveBeenCalledTimes(1)
    expect(textOf(result)).toMatchObject({ status: 'ok' })
  })

  it('显式 channel=weixin 时也走 router.send，并附带 mediaPath', async () => {
    const weixinCtx: WeixinCtxValue = { channelUserId: 'wx-user-2', contextToken: 'tok-2' }
    const routerSendMock = vi.fn(async () => ({ ok: true }))
    const { tool } = makeRegistrar({ weixinCtx, routerSend: routerSendMock })

    await tool.execute('call-2', { channel: 'weixin', text: '发个文件', mediaUrl: 'C:\\tmp\\a.png' })

    expect(routerSendMock).toHaveBeenCalledWith({
      channel: 'weixin',
      to: 'wx-user-2',
      text: '发个文件',
      mediaPath: 'C:\\tmp\\a.png',
    })
  })

  it('channel=weixin 但无活跃会话上下文时，硬失败且不调用 router', async () => {
    const routerSendMock = vi.fn()
    const { tool, markSentViaToolMock } = makeRegistrar({ weixinCtx: null, routerSend: routerSendMock })

    const result = await tool.execute('call-3', { channel: 'weixin', text: '你好' })

    expect(routerSendMock).not.toHaveBeenCalled()
    expect(markSentViaToolMock).not.toHaveBeenCalled()
    expect(textOf(result)).toMatchObject({ status: 'error' })
  })

  it('router.send 返回失败结果时，不标记 markSentViaTool，透传 message', async () => {
    const weixinCtx: WeixinCtxValue = { channelUserId: 'wx-user-3', contextToken: 'tok-3' }
    const routerSendMock = vi.fn(async () => ({
      ok: false,
      errorCode: 'TOKEN_STALE',
      message: 'token 已失效',
    }))
    const { tool, markSentViaToolMock } = makeRegistrar({ weixinCtx, routerSend: routerSendMock })

    const result = await tool.execute('call-4', { text: '你好' })

    expect(markSentViaToolMock).not.toHaveBeenCalled()
    expect(textOf(result)).toMatchObject({ status: 'error', message: 'token 已失效' })
  })

  it('Hub 未就绪（getChannelRouter 返回 null）时硬失败，不抛异常', async () => {
    const weixinCtx: WeixinCtxValue = { channelUserId: 'wx-user-4', contextToken: 'tok-4' }
    const { tool } = makeRegistrar({ weixinCtx, router: null })

    const result = await tool.execute('call-5', { text: '你好' })

    expect(textOf(result)).toMatchObject({ status: 'error' })
  })
})

describe('message 工具 execute（非微信 / 无活跃会话）', () => {
  it('无微信上下文且未显式指定 channel 时，直接硬失败，不触发任何网关调用', async () => {
    const { tool } = makeRegistrar({ weixinCtx: null })

    const result = await tool.execute('call-6', { text: '你好', to: 'someone', channel: 'feishu' })

    expect(textOf(result)).toMatchObject({ status: 'error' })
    expect((textOf(result).message as string)).toContain('channel_list')
  })
})
