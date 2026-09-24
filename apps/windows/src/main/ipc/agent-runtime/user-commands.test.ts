import { describe, expect, it, vi } from 'vitest'
import { handleUserSteer, setUserDependencies } from './user-commands'

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
  } as never
  return { bridge, steer, saveMessage, forwardIpcEvent }
}

function setDeps(runIdToInstance: Map<string, string>, sessionToInstance: Map<string, string>) {
  setUserDependencies({ runIdToInstance, sessionToInstance } as never)
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

  it('目标实例不在运行中：不注入，也绝不改投另一个 running 实例', () => {
    const { bridge, steer } = makeBridge([
      { id: 'inst-A', state: 'running' },
      { id: 'inst-B', state: 'idle' },
    ])
    setDeps(new Map([['run-1', 'inst-B']]), new Map())

    handleUserSteer(bridge, {
      type: 'user:steer',
      runId: 'run-1',
      sessionKey: 's-B',
      steerText: '喂',
    })

    // 关键：inst-A 正在跑，但它不是这条插话的去处
    expect(steer).not.toHaveBeenCalled()
  })

  it('定位不到实例时静默不注入（不抛错，落库照常）', () => {
    const { bridge, steer, saveMessage } = makeBridge([{ id: 'inst-A', state: 'running' }])
    setDeps(new Map(), new Map())

    expect(() =>
      handleUserSteer(bridge, {
        type: 'user:steer',
        runId: 'run-x',
        sessionKey: 's-x',
        steerText: '在吗',
      }),
    ).not.toThrow()
    expect(steer).not.toHaveBeenCalled()
    expect(saveMessage).toHaveBeenCalled()
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
