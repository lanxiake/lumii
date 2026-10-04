/**
 * resolveReplyTo —— channel_send 省略 to 时的默认收件人。
 *
 * 单聊 = channelUserId；群聊 = 群 chatId（QQ 加 `group:` 前缀，与 peer id 形状一致）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveReplyTo, SessionManager, type PromptParams } from './session-manager'
import type { ChannelSession } from './types'

function session(overrides: Partial<ChannelSession>): ChannelSession {
  return {
    sessionKey: 'k',
    channelType: 'qbot',
    channelUserId: 'user-1',
    instanceId: null,
    ...overrides,
  }
}

describe('resolveReplyTo', () => {
  it('单聊回 channelUserId', () => {
    expect(resolveReplyTo(session({ replyContext: { chatType: 'p2p' } }))).toBe('user-1')
  })

  it('QQ 群聊回 group:{chatId}（与 QbotChannelProvider 的 peer id 形状一致）', () => {
    expect(
      resolveReplyTo(
        session({ replyContext: { chatType: 'group', chatId: 'group_openid_1' } }),
      ),
    ).toBe('group:group_openid_1')
  })

  it('企微群聊回群 chatId（不加前缀）', () => {
    expect(
      resolveReplyTo(
        session({
          channelType: 'wecom',
          channelUserId: 'user-1',
          replyContext: { chatType: 'group', chatId: 'wr_group_1' },
        }),
      ),
    ).toBe('wr_group_1')
  })

  it('群聊缺 chatId 时返回 undefined（不回退成发言人，避免私聊误投）', () => {
    expect(resolveReplyTo(session({ replyContext: { chatType: 'group' } }))).toBeUndefined()
  })

  it('客户端会话没有可回信地址', () => {
    expect(resolveReplyTo(session({ channelType: 'ipc' }))).toBeUndefined()
  })
})

/**
 * 会话锁兜底：prompt() 用 Promise 链串行化同一 sessionKey 的消息，链上任何一环
 * 永不 resolve，该会话就永久哑掉（2026-10-04「你好」被卡死的快照堵住即如此）。
 * 看门狗必须在硬界后释放锁，让后续消息能继续。
 */
const STALL_RELEASE_MS = 30 * 60_000

function makeParams(sessionKey: string): PromptParams {
  return {
    instanceId: 'inst-1',
    sessionKey,
    message: '你好',
    strategy: {
      beforePrompt: vi.fn(async () => {}),
      afterPrompt: vi.fn(async () => {}),
    } as never,
    adapter: {} as never,
    session: { channelType: 'ipc', channelUserId: 'u-1' } as never,
  }
}

/** bridge.prompt 永不 resolve，模拟卡死的回合 */
function makeStuckBridge() {
  return {
    setInstancePresence: vi.fn(),
    prompt: vi.fn(() => new Promise<void>(() => {})),
  }
}

describe('SessionManager 会话锁兜底', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('锁卡死超过硬界后被强制释放，后续消息不再被永久堵住', async () => {
    vi.useFakeTimers()
    const bridge = makeStuckBridge()
    const sm = new SessionManager(bridge as never)

    void sm.prompt(makeParams('s-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.prompt).toHaveBeenCalledTimes(1)

    // 卡死不动，推进到硬界之后
    await vi.advanceTimersByTimeAsync(STALL_RELEASE_MS + 1)

    // 锁被释放 → 第二条消息应能真正开始
    void sm.prompt(makeParams('s-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.prompt).toHaveBeenCalledTimes(2)
  })

  it('不同 sessionKey 互不阻塞', async () => {
    vi.useFakeTimers()
    const bridge = makeStuckBridge()
    const sm = new SessionManager(bridge as never)

    void sm.prompt(makeParams('s-1'))
    void sm.prompt(makeParams('s-2'))
    await vi.advanceTimersByTimeAsync(0)

    expect(bridge.prompt).toHaveBeenCalledTimes(2)
  })

  it('卡死计时按「当前回合开始」而非「首次入队」——长排队不会误伤后一轮', async () => {
    vi.useFakeTimers()
    const resolvers: Array<() => void> = []
    const bridge = {
      setInstancePresence: vi.fn(),
      prompt: vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve))),
    }
    const sm = new SessionManager(bridge as never)

    // 第 1 轮跑了很久（20 分钟）才完成
    void sm.prompt(makeParams('s-1'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20 * 60_000)

    // 第 2 轮在此刻入队（前面还有第 1 轮没结束）
    void sm.prompt(makeParams('s-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.prompt).toHaveBeenCalledTimes(1)

    // 第 1 轮完成 → 第 2 轮开始
    resolvers[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.prompt).toHaveBeenCalledTimes(2)

    // 此刻距「首次入队」已 20 分钟；再推进 15 分钟就到首次入队后的 35 分钟。
    // 若按首次入队计时，第 2 轮会被误判卡死并强制释放；按回合开始计时则不应释放。
    await vi.advanceTimersByTimeAsync(15 * 60_000)

    // 锁应仍被第 2 轮持有 → 第 3 条消息只能排队，不会并行启动
    void sm.prompt(makeParams('s-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(bridge.prompt).toHaveBeenCalledTimes(2)

    resolvers[1]!()
  })
})
