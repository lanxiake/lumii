import { describe, expect, it, vi } from 'vitest'
import { handleUserSteer, setUserDependencies } from './user-commands'
import { DEFAULT_CODING_DEV_BACKEND_ID } from '../../coding-dev-backends-stub/contracts.js'

/**
 * `user:steer` 的实例定位回归。
 *
 * 旧实现取「第一个 state === 'running' 的实例」，完全忽略命令里的 runId——
 * 两个会话并行跑时，在 A 会话插的话会落到 B 会话的 Agent 上，且没有任何迹象。
 */
function makeBridge(instances: Array<{ id: string; state: string }>) {
  const steer = vi.fn()
  const saveMessage = vi.fn((input: { id: string }) => ({ id: input.id }))
  const forwardIpcEvent = vi.fn()
  const bridge = {
    getInstances: () => instances,
    steer,
    conversationRepo: { saveMessage },
    forwardIpcEvent,
    // 空闲唤醒路径会读它，好在普通消息里原样带回顾有模型
    getSessionPreferredModelRaw: () => undefined,
  } as never
  return { bridge, steer, saveMessage, forwardIpcEvent }
}

function setDeps(runIdToInstance: Map<string, string>, sessionToInstance: Map<string, string>) {
  // 空闲插话会走 handleUserSend 唤醒新回合，那条路第一件事就是取实例
  const getInstanceForSession = vi.fn(
    async (
      _bridge: unknown,
      _sessionKey: string,
      _agentId?: string,
    ): Promise<string | undefined> => undefined,
  )
  setUserDependencies({ runIdToInstance, sessionToInstance, getInstanceForSession } as never)
  return { getInstanceForSession }
}

describe('user:steer 目标实例定位', () => {
  it('按 runId 投递：两个会话都在跑时只落到自己的实例', () => {
    const { bridge, steer } = makeBridge([
      { id: 'inst-A', state: 'running' },
      { id: 'inst-B', state: 'running' },
    ])
    // runId 指向 A，sessionKey 指向 B：以 runId 为准（它才是这条插话真正所属的回合）
    setDeps(new Map([['run-1', 'inst-A']]), new Map([['s-B', 'inst-B']]))

    handleUserSteer(bridge, {
      type: 'user:steer',
      runId: 'run-1',
      sessionKey: 's-B',
      steerText: '改一下方向',
    })

    expect(steer).toHaveBeenCalledTimes(1)
    expect(steer).toHaveBeenCalledWith('inst-A', '改一下方向')
  })

  it('runId 映射缺失时用 sessionKey 兜底', () => {
    const { bridge, steer } = makeBridge([
      { id: 'inst-A', state: 'running' },
      { id: 'inst-B', state: 'running' },
    ])
    setDeps(new Map(), new Map([['s-B', 'inst-B']]))

    handleUserSteer(bridge, {
      type: 'user:steer',
      runId: 'run-gone',
      sessionKey: 's-B',
      steerText: '继续',
    })

    expect(steer).toHaveBeenCalledWith('inst-B', '继续')
  })

  // 控制面（CLI / 控制口）拿不到 runId（conversation list 不返回它），
  // 只能只给 sessionKey —— 这条路必须走得通，否则扩了白名单也等于没扩。
  it('完全没有 runId（控制面形态）：按 sessionKey 投递', () => {
    const { bridge, steer } = makeBridge([
      { id: 'inst-A', state: 'running' },
      { id: 'inst-B', state: 'running' },
    ])
    setDeps(new Map([['run-1', 'inst-A']]), new Map([['s-B', 'inst-B']]))

    handleUserSteer(bridge, { type: 'user:steer', sessionKey: 's-B', steerText: '接着做' })

    expect(steer).toHaveBeenCalledTimes(1)
    expect(steer).toHaveBeenCalledWith('inst-B', '接着做')
  })

  it('完全没有 runId 且 sessionKey 也定位不到：不注入，也不乱投', () => {
    const { bridge, steer } = makeBridge([{ id: 'inst-A', state: 'running' }])
    setDeps(new Map(), new Map())

    handleUserSteer(bridge, { type: 'user:steer', steerText: '喂' })

    expect(steer).not.toHaveBeenCalled()
  })

  it('目标实例不在运行中：不注入，也绝不改投另一个 running 实例（改为唤醒目标会话）', async () => {
    const { bridge, steer } = makeBridge([
      { id: 'inst-A', state: 'running' },
      { id: 'inst-B', state: 'idle' },
    ])
    const { getInstanceForSession } = setDeps(new Map([['run-1', 'inst-B']]), new Map())

    await handleUserSteer(bridge, {
      type: 'user:steer',
      runId: 'run-1',
      sessionKey: 's-B',
      steerText: '喂',
    })

    // 关键：inst-A 正在跑，但它不是这条插话的去处 —— 绝不改投
    expect(steer).not.toHaveBeenCalled()
    // 没有运行中的回合可插 → 改为按普通消息唤醒 s-B 自己
    expect(getInstanceForSession.mock.calls[0]?.[1]).toBe('s-B')
  })

  it('定位不到实例：不抛错，改为按普通消息唤醒该会话', async () => {
    const { bridge, steer } = makeBridge([{ id: 'inst-A', state: 'running' }])
    const { getInstanceForSession } = setDeps(new Map(), new Map())

    await expect(
      handleUserSteer(bridge, {
        type: 'user:steer',
        runId: 'run-x',
        sessionKey: 's-x',
        steerText: '在吗',
      }),
    ).resolves.toBeUndefined()
    expect(steer).not.toHaveBeenCalled()
    expect(getInstanceForSession.mock.calls[0]?.[1]).toBe('s-x')
  })
})

describe('user:steer 插话落库与广播', () => {
  it('带 isSteer 标记落库并广播，UI 才能把它渲染成「插话」气泡', () => {
    const { bridge, saveMessage, forwardIpcEvent } = makeBridge([
      { id: 'inst-A', state: 'running' },
    ])
    setDeps(new Map([['run-1', 'inst-A']]), new Map())

    handleUserSteer(bridge, {
      type: 'user:steer',
      runId: 'run-1',
      sessionKey: 's-A',
      steerText: '先别改后端，只动前端',
    })

    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 's-A',
        role: 'user',
        contentJson: expect.objectContaining({ text: '先别改后端，只动前端', isSteer: true }),
      }),
    )
    expect(forwardIpcEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation:message:new',
        sessionKey: 's-A',
        message: expect.objectContaining({ role: 'user', isSteer: true }),
      }),
    )
  })

  it('没有 sessionKey 时不落库（命令允许省略会话键）', () => {
    const { bridge, steer, saveMessage, forwardIpcEvent } = makeBridge([
      { id: 'inst-A', state: 'running' },
    ])
    setDeps(new Map([['run-1', 'inst-A']]), new Map())

    handleUserSteer(bridge, { type: 'user:steer', runId: 'run-1', steerText: '你好' })

    expect(steer).toHaveBeenCalledWith('inst-A', '你好')
    expect(saveMessage).not.toHaveBeenCalled()
    expect(forwardIpcEvent).not.toHaveBeenCalled()
  })

  it('落库失败不影响注入本身', () => {
    const { bridge, steer, saveMessage } = makeBridge([{ id: 'inst-A', state: 'running' }])
    saveMessage.mockImplementation(() => {
      throw new Error('db is locked')
    })
    setDeps(new Map([['run-1', 'inst-A']]), new Map())

    expect(() =>
      handleUserSteer(bridge, {
        type: 'user:steer',
        runId: 'run-1',
        sessionKey: 's-A',
        steerText: 'x',
      }),
    ).not.toThrow()
    expect(steer).toHaveBeenCalledWith('inst-A', 'x')
  })
})

/**
 * 空闲会话收到插话（2026-10-04 缺陷）。
 *
 * 旧行为：只落库一条 `isSteer` 气泡就返回 —— 模型永远看不到，气泡永远停在
 * 「插话 · 等待注入」。新行为：按普通用户消息处理，唤醒新回合真正执行。
 */
describe('user:steer 空闲会话唤醒', () => {
  it('目标空闲时按普通消息落库并开新回合（不带 isSteer、不注入）', async () => {
    const instances = [{ id: 'inst-B', state: 'idle' }]
    const steer = vi.fn()
    const saveMessage = vi.fn((input: { id: string }) => ({ id: input.id }))
    const forwardIpcEvent = vi.fn()
    const sendPrompt = vi.fn(
      async (_instanceId: string, _sessionKey: string, _prompt: string): Promise<void> => {},
    )
    const setSessionPreferredModel = vi.fn()

    const bridge = {
      getInstances: () => instances,
      steer,
      forwardIpcEvent,
      setSessionPreferredModel,
      getSessionPreferredModelRaw: () => 'Qwen3.8-Flash-Next',
      conversationRepo: {
        saveMessage,
        getConversation: () => ({ id: 's-B', title: '已有会话' }),
        countUserMessages: () => 3,
        getAgentParticipantId: () => 'assistant',
      },
    } as never

    setUserDependencies({
      runIdToInstance: new Map(),
      sessionToInstance: new Map([['s-B', 'inst-B']]),
      getInstanceForSession: vi.fn(async () => 'inst-B'),
      getIpcChannelAdapter: () => ({
        sendPrompt,
        sessionManager: { clearLock: vi.fn() },
        getContextStrategy: () => ({}),
      }),
      trackRunInstance: vi.fn(),
      getAcpBackendManager: () => ({
        getBackendWithFallback: () => DEFAULT_CODING_DEV_BACKEND_ID,
      }),
      resolveAgentIdForMemories: () => 'assistant',
    } as never)

    await handleUserSteer(bridge, {
      type: 'user:steer',
      runId: 'run-1',
      sessionKey: 's-B',
      steerText: '继续做',
    })

    // 没有运行中的回合 → 不注入
    expect(steer).not.toHaveBeenCalled()
    // 真正开了一个新回合，文本原样送达
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(sendPrompt.mock.calls[0]?.[1]).toBe('s-B')
    expect(sendPrompt.mock.calls[0]?.[2]).toBe('继续做')
    // 落库为普通用户消息：不带 isSteer（该标记的语义是「插进正在跑的回合」）
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contentJson: { type: 'text', text: '继续做' } }),
    )
    // 会话已有的模型偏好被原样带回，不能因插话被清掉
    expect(setSessionPreferredModel).toHaveBeenCalledWith('s-B', 'Qwen3.8-Flash-Next')
  })
})
