/**
 * ChannelInteractionHub
 *
 * 一、主动出站（pushText）
 * 转交完成汇报是**异步**产出（几分钟到几十分钟后），此时用户那条入站消息早已处理完；
 * 渠道用户的唯一出口就是这个按会话保存的回复上下文，否则结果只落在库里、渠道侧毫无响应。
 *
 * 二、入站插队裁决（tryHandleChannelOutOfBand，10-S5 补测）
 * 它是「这条文本归谁」的唯一裁决点：斜杠命令 > 挂起审批/提问 > 接续答复 > /stop > 普通消息。
 * 裁决错了的表现是：命令被当成答复吞掉、答复被当成新需求、打断排在长任务后面永不生效。
 */

import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeBridge } from '../agent-runtime/bridge'
import { ChannelInteractionHub, tryHandleChannelOutOfBand } from './channel-interaction-hub'
import type { ChannelSession, IChannelAdapter } from './types'

interface HubBridge {
  setChannelInteractionNotifier: ReturnType<typeof vi.fn>
  setChannelTextPusher: ReturnType<typeof vi.fn>
  abortSession: ReturnType<typeof vi.fn>
  resolvePermission: ReturnType<typeof vi.fn>
  resolveAskUserQuestion: ReturnType<typeof vi.fn>
  /** 构造 hub 时注册进来的通知器，测试里直接调用以造出「挂起项」 */
  notifier: ((req: unknown) => boolean) | null
}

function makeHub(): { hub: ChannelInteractionHub; bridge: HubBridge } {
  const bridge: HubBridge = {
    setChannelInteractionNotifier: vi.fn((fn: (req: unknown) => boolean) => {
      bridge.notifier = fn
    }),
    setChannelTextPusher: vi.fn(),
    abortSession: vi.fn(() => 1),
    resolvePermission: vi.fn(),
    resolveAskUserQuestion: vi.fn(),
    notifier: null,
  }
  const hub = new ChannelInteractionHub(bridge as unknown as AgentRuntimeBridge)
  return { hub, bridge }
}

function makeAdapter(
  sendTextReply = vi.fn(async (_session: unknown, _text: string) => {}),
): IChannelAdapter {
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

describe('tryHandleChannelOutOfBand（入站裁决，10-S5 补测）', () => {
  /** 造一个「审批挂起」的会话：hub 的挂起项由 bridge 通知器写入 */
  function withPendingPermission() {
    const { hub, bridge } = makeHub()
    const adapter = makeAdapter()
    hub.trackSession(adapter, QQ_SESSION)
    bridge.notifier?.({
      kind: 'permission',
      requestId: 'r1',
      sessionKey: QQ_SESSION.sessionKey,
      toolName: 'file_edit',
      description: '改写配置文件',
    })
    return { hub, bridge, adapter }
  }

  const call = (
    params: Parameters<typeof tryHandleChannelOutOfBand>[0],
  ): boolean => tryHandleChannelOutOfBand(params)

  const base = (hub: ChannelInteractionHub, bridge: HubBridge, adapter: IChannelAdapter) => ({
    hub,
    bridge: bridge as unknown as AgentRuntimeBridge,
    adapter,
    session: QQ_SESSION,
    sessionManager: { clearLock: vi.fn() },
    onError: vi.fn(),
  })

  it('无任何挂起项 → false，消息照常入队', () => {
    const { hub, bridge } = makeHub()
    const a = makeAdapter()
    const continuity = { tryConsumeReply: vi.fn(() => false), clear: vi.fn() }

    expect(call({ ...base(hub, bridge, a), text: '帮我看看这个 bug', continuity })).toBe(false)
    // 挂起与否只有接续模块自己知道（提示存在它内部），所以照问不误、由它答 false
    expect(continuity.tryConsumeReply).toHaveBeenCalledTimes(1)
    expect(bridge.abortSession).not.toHaveBeenCalled()
  })

  it('斜杠命令：不被任何挂起项吞掉，并作废挂起交互与接续提示', () => {
    const { hub, bridge, adapter } = withPendingPermission()
    const continuity = { tryConsumeReply: vi.fn(() => true), clear: vi.fn() }
    hub.trackSession(adapter, QQ_SESSION)

    expect(call({ ...base(hub, bridge, adapter), text: '/resume', continuity })).toBe(false)

    expect(hub.hasPending(QQ_SESSION.sessionKey)).toBe(false)
    expect(continuity.clear).toHaveBeenCalledWith('qbot', 'u-1')
    expect(continuity.tryConsumeReply).not.toHaveBeenCalled()
  })

  it('挂起审批 + 有效答复 → 消费掉并回填决定', () => {
    const { hub, bridge, adapter } = withPendingPermission()
    const continuity = { tryConsumeReply: vi.fn(() => true), clear: vi.fn() }

    expect(call({ ...base(hub, bridge, adapter), text: '1', continuity })).toBe(true)

    expect(bridge.resolvePermission).toHaveBeenCalledWith('r1', 'allow-once')
    expect(hub.hasPending(QQ_SESSION.sessionKey)).toBe(false)
    expect(continuity.tryConsumeReply).not.toHaveBeenCalled()
  })

  it('挂起审批 + 看不懂的答复 → 仍消费（重新提示，不当成新需求发给 Agent）', () => {
    const { hub, bridge, adapter } = withPendingPermission()
    const continuity = { tryConsumeReply: vi.fn(() => true), clear: vi.fn() }

    expect(call({ ...base(hub, bridge, adapter), text: '你看着办', continuity })).toBe(true)

    expect(bridge.resolvePermission).not.toHaveBeenCalled()
    // 挂起项仍在，等一个能看懂的答复
    expect(hub.hasPending(QQ_SESSION.sessionKey)).toBe(true)
  })

  it('接续答复（无交互挂起）→ 交给接续状态机，按其结果决定是否消费', () => {
    const { hub, bridge } = makeHub()
    const adapter = makeAdapter()
    hub.trackSession(adapter, QQ_SESSION)
    const continuity = { tryConsumeReply: vi.fn(() => true), clear: vi.fn() }

    expect(call({ ...base(hub, bridge, adapter), text: '接续', continuity })).toBe(true)
    expect(continuity.tryConsumeReply).toHaveBeenCalledWith(adapter, QQ_SESSION, '接续')

    continuity.tryConsumeReply.mockReturnValue(false)
    expect(call({ ...base(hub, bridge, adapter), text: '帮我查下天气', continuity })).toBe(false)
  })

  it('/stop → 打断运行中的任务并清掉挂起项', () => {
    const { hub, bridge, adapter } = withPendingPermission()
    const continuity = { tryConsumeReply: vi.fn(() => true), clear: vi.fn() }

    expect(call({ ...base(hub, bridge, adapter), text: '/stop', continuity })).toBe(true)

    expect(bridge.abortSession).toHaveBeenCalledWith(QQ_SESSION.sessionKey)
    expect(hub.hasPending(QQ_SESSION.sessionKey)).toBe(false)
    expect(continuity.clear).toHaveBeenCalledWith('qbot', 'u-1')
  })

  it('/stop 且没有运行中的任务 → 同样消费，文案如实说明', () => {
    const { hub, bridge } = makeHub()
    const sent: string[] = []
    const a = makeAdapter(vi.fn(async (_s, text: string) => void sent.push(text)))
    hub.trackSession(a, QQ_SESSION)
    bridge.abortSession.mockReturnValue(0)

    expect(call({ ...base(hub, bridge, a), text: '/abort' })).toBe(true)
    expect(sent.join('')).toContain('当前没有正在运行的任务')
  })

  it('空文本不参与裁决（附件消息等场景）', () => {
    const { hub, bridge } = makeHub()
    const a = makeAdapter()
    expect(call({ ...base(hub, bridge, a), text: '' })).toBe(false)
  })
})
