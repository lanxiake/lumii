/**
 * forwardPermissionResolved —— 审批有结果后的解除广播
 *
 * 背景（实测，2026-09-22）：这族事件此前全仓零产出，宠物多会话记账的 waiting
 * 只能等 turn:end 兜底；自动放行时表现为「另一个会话在等你确认」的误报。
 * 现场与复跑脚本见 `verify/pet-sprite/check-foreign-attention.mjs`。
 */
import { describe, it, expect } from 'vitest'
import { forwardPermissionResolved } from './bridge-permission-ipc-forward'
import type { BridgeRendererIpcChannel } from './bridge-renderer-ipc'

function makeIpc() {
  const events: Record<string, unknown>[] = []
  const ipc = {
    forwardIpcEvent: (e: Record<string, unknown>) => {
      events.push(e)
      return true
    },
  } as unknown as BridgeRendererIpcChannel
  return { ipc, events }
}

describe('forwardPermissionResolved', () => {
  it('allow-once → granted，并透传定位字段', () => {
    const { ipc, events } = makeIpc()
    forwardPermissionResolved(ipc, {
      requestId: 'r1',
      toolName: 'bash',
      instanceId: 'inst-1',
      rootSessionKey: 'chat:a',
      decision: 'allow-once',
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'agent:permission:granted',
      requestId: 'r1',
      toolName: 'bash',
      instanceId: 'inst-1',
      rootSessionKey: 'chat:a',
    })
  })

  it('allow-always 也发 granted —— 消费方只关心"还等不等"，不关心记住与否', () => {
    const { ipc, events } = makeIpc()
    forwardPermissionResolved(ipc, { requestId: 'r2', toolName: 'file_write', decision: 'allow-always' })
    expect(events[0]?.type).toBe('agent:permission:granted')
  })

  it('deny → denied', () => {
    const { ipc, events } = makeIpc()
    forwardPermissionResolved(ipc, { requestId: 'r3', toolName: 'bash', decision: 'deny' })
    expect(events[0]?.type).toBe('agent:permission:denied')
  })

  it('缺 rootSessionKey 时不凭空捏造（路由交回消费方的兜底）', () => {
    const { ipc, events } = makeIpc()
    forwardPermissionResolved(ipc, { requestId: 'r4', toolName: 'bash', decision: 'allow-once' })
    expect(events[0]?.rootSessionKey).toBeUndefined()
  })
})
