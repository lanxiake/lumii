/**
 * agent-runtime-store 辅助函数单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  findAnyPendingPermission,
  getDefaultPerSessionState,
  getPendingPermissionSnapshot,
  resetRuntimeStore,
  runtimeStore,
  type PendingPermission,
} from './agent-runtime-store'

describe('findAnyPendingPermission', () => {
  beforeEach(() => {
    resetRuntimeStore()
  })

  it('无待处理权限时返回 null', () => {
    expect(findAnyPendingPermission(runtimeStore.getState())).toBeNull()
  })

  it('应找到非当前会话中的待处理权限', () => {
    const pending: PendingPermission = {
      requestId: 'req-1',
      toolName: 'file_write',
      toolArgs: { path: 'a.md' },
      riskLevel: 'medium',
      description: 'write file',
      timeoutMs: 30_000,
      receivedAt: Date.now(),
    }
    runtimeStore.setState((prev) => {
      const sessions = new Map(prev.sessions)
      sessions.set('weixin:foo@im.wechat', {
        ...getDefaultPerSessionState(),
        pendingPermission: pending,
      })
      return { ...prev, currentSessionKey: 'local:other', sessions }
    })

    const found = findAnyPendingPermission(runtimeStore.getState())
    expect(found).toEqual({ sessionKey: 'weixin:foo@im.wechat', pending })
  })

  it('getPendingPermissionSnapshot 在无权限时返回稳定引用', () => {
    const a = getPendingPermissionSnapshot()
    const b = getPendingPermissionSnapshot()
    expect(a).toBe(b)
    expect(a.pending).toBeNull()
  })

  it('getPendingPermissionSnapshot 在权限未变时返回稳定引用', () => {
    const pending: PendingPermission = {
      requestId: 'req-2',
      toolName: 'bash',
      toolArgs: {},
      riskLevel: 'high',
      description: 'run cmd',
      timeoutMs: 30_000,
      receivedAt: Date.now(),
    }
    runtimeStore.setState((prev) => {
      const sessions = new Map(prev.sessions)
      sessions.set('local:a', { ...getDefaultPerSessionState(), pendingPermission: pending })
      return { ...prev, sessions }
    })
    const a = getPendingPermissionSnapshot()
    const b = getPendingPermissionSnapshot()
    expect(a).toBe(b)
    expect(a.pending?.requestId).toBe('req-2')
  })
})
