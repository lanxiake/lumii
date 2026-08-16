/**
 * BridgeLifecycle 失效与销毁的回归保护
 *
 * 背景：Provider 配置变更 / MCP 工具变更会让所有实例失效。若对**正在运行**的实例
 * 直接 destroy，pi-agent-core 的循环会检测到 destroyed 后静默退出，工具结果再也
 * 回不到模型且不抛异常，同时事件订阅被解绑，渲染侧 isStreaming 永远停在 true —— 
 * 表现为对话永久卡死（Agent 用 app_act 点「保存全部」时可稳定复现）。
 */

import { describe, expect, it, vi } from 'vitest'
import { createRunContext } from './event-converter'
import { createInstanceState, InstanceStateStore } from './bridge-instance-state'
import { BridgeLifecycle, type BridgeLifecycleDeps } from './bridge-lifecycle'

const INSTANCE_ID = 'instance-1'
const SESSION_KEY = 'conversation-1'

/** 搭一套最小可用的 BridgeLifecycle 依赖，只保留本用例关心的部分 */
function createLifecycle(instanceState: 'idle' | 'running') {
  const instanceStates = new InstanceStateStore()
  instanceStates.set(
    INSTANCE_ID,
    createInstanceState(createRunContext(SESSION_KEY, INSTANCE_ID, SESSION_KEY), {
      definitionId: 'agent',
      runningStartedAt: null,
      completedTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
  )

  const registryDestroy = vi.fn()
  const forwardIpcEvent = vi.fn()
  const instance = { id: INSTANCE_ID, definitionId: 'agent', state: instanceState }
  let alive = true

  const deps = {
    agentRegistry: {
      get: (id: string) => (alive && id === INSTANCE_ID ? instance : undefined),
      getAll: () => (alive ? [instance] : []),
      getParentId: () => undefined,
      destroy: (id: string) => {
        alive = false
        registryDestroy(id)
      },
    },
    instanceStates,
    instanceToConversation: new Map([[INSTANCE_ID, SESSION_KEY]]),
    instanceToRootSessionKey: new Map([[INSTANCE_ID, SESSION_KEY]]),
    getConversationRepo: () => null,
    messageBus: { unregister: vi.fn() },
    permissionController: { clearAll: vi.fn() },
    askUserQuestionController: { clearAll: vi.fn() },
    ipcChannel: { forwardIpcEvent },
    getCronScheduler: () => undefined,
    getDefinitionStore: () => null,
    toolStartTimeMap: new Map(),
    toolCallInstanceMap: new Map(),
    nodeStreamCallbacks: new Map(),
    setLastActiveConvId: vi.fn(),
    finalizeShutdown: vi.fn(),
    createInstance: vi.fn(),
    prompt: vi.fn(),
    getFeatureFlags: () => ({}),
  } as unknown as BridgeLifecycleDeps

  return { lifecycle: new BridgeLifecycle(deps), registryDestroy, forwardIpcEvent }
}

describe('BridgeLifecycle.invalidate', () => {
  it('空闲实例立即销毁', () => {
    const { lifecycle, registryDestroy } = createLifecycle('idle')

    expect(lifecycle.invalidate(INSTANCE_ID)).toBe('destroyed')
    expect(registryDestroy).toHaveBeenCalledWith(INSTANCE_ID)
    expect(lifecycle.isPendingInvalidation(INSTANCE_ID)).toBe(false)
  })

  it('运行中实例只做标记，不得当场销毁', () => {
    const { lifecycle, registryDestroy } = createLifecycle('running')

    expect(lifecycle.invalidate(INSTANCE_ID)).toBe('deferred')
    expect(registryDestroy).not.toHaveBeenCalled()
    expect(lifecycle.isPendingInvalidation(INSTANCE_ID)).toBe(true)
  })

  it('本轮结束后消费标记才真正销毁，且只销毁一次', () => {
    const { lifecycle, registryDestroy } = createLifecycle('running')
    lifecycle.invalidate(INSTANCE_ID)

    expect(lifecycle.consumePendingInvalidation(INSTANCE_ID)).toBe(true)
    expect(registryDestroy).toHaveBeenCalledWith(INSTANCE_ID)

    registryDestroy.mockClear()
    expect(lifecycle.consumePendingInvalidation(INSTANCE_ID)).toBe(false)
    expect(registryDestroy).not.toHaveBeenCalled()
  })

  it('未标记的实例消费时不做任何事', () => {
    const { lifecycle, registryDestroy } = createLifecycle('running')

    expect(lifecycle.consumePendingInvalidation(INSTANCE_ID)).toBe(false)
    expect(registryDestroy).not.toHaveBeenCalled()
  })
})

describe('BridgeLifecycle.destroy 的运行中兜底', () => {
  it('销毁运行中实例时补发 agent:error，避免渲染侧永久转圈', () => {
    const { lifecycle, forwardIpcEvent } = createLifecycle('running')

    lifecycle.destroy(INSTANCE_ID)

    const errorEvent = forwardIpcEvent.mock.calls
      .map(([event]) => event as { type: string; sessionKey?: string; errorCode?: string })
      .find((event) => event.type === 'agent:error')
    expect(errorEvent).toBeDefined()
    expect(errorEvent?.sessionKey).toBe(SESSION_KEY)
    expect(errorEvent?.errorCode).toBe('INSTANCE_DESTROYED')
  })

  it('销毁空闲实例不发 agent:error', () => {
    const { lifecycle, forwardIpcEvent } = createLifecycle('idle')

    lifecycle.destroy(INSTANCE_ID)

    const types = forwardIpcEvent.mock.calls.map(([event]) => (event as { type: string }).type)
    expect(types).not.toContain('agent:error')
  })
})
