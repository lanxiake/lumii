/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false, getVersion: () => '0.0.0', on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Notification: vi.fn(),
  shell: {},
}))

import { AgentRuntimeBridge } from './bridge'

/**
 * 以假 this 调用原型方法：只验证「新建才广播」这一条契约，不构造整个 bridge。
 */
function callEnsure(created: boolean) {
  const fake = {
    conversationManager: { ensureConversationExists: vi.fn(() => created) },
    forwardIpcEvent: vi.fn(() => true),
  }
  const result = AgentRuntimeBridge.prototype.ensureConversationExists.call(
    fake as unknown as AgentRuntimeBridge,
    'cron:job-1',
    '定时任务 · 巡检',
    'cron',
  )
  return { result, fake }
}

describe('AgentRuntimeBridge.ensureConversationExists', () => {
  it('新建会话时广播 conversation:created，侧栏据此重拉列表', () => {
    const { result, fake } = callEnsure(true)
    expect(result).toBe(true)
    expect(fake.conversationManager.ensureConversationExists).toHaveBeenCalledWith(
      'cron:job-1',
      '定时任务 · 巡检',
      'cron',
      undefined,
    )
    expect(fake.forwardIpcEvent).toHaveBeenCalledTimes(1)
    expect(fake.forwardIpcEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation:created',
        sessionKey: 'cron:job-1',
        title: '定时任务 · 巡检',
      }),
    )
  })

  it('会话已存在时不广播，避免每轮定时任务都触发侧栏重拉', () => {
    const { result, fake } = callEnsure(false)
    expect(result).toBe(false)
    expect(fake.forwardIpcEvent).not.toHaveBeenCalled()
  })
})
