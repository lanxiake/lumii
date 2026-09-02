/**
 * auto-approve-prefs 单元测试
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_APPROVE_STORAGE_KEY,
  readAutoApproveEnabled,
  syncAutoApproveToMainProcess,
} from './auto-approve-prefs'

describe('readAutoApproveEnabled', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('localStorage 无值时默认开启', () => {
    expect(readAutoApproveEnabled()).toBe(true)
  })

  it('localStorage 为 true 时返回 true', () => {
    localStorage.setItem(AUTO_APPROVE_STORAGE_KEY, 'true')
    expect(readAutoApproveEnabled()).toBe(true)
  })

  it('localStorage 为 false 时返回 false', () => {
    localStorage.setItem(AUTO_APPROVE_STORAGE_KEY, 'false')
    expect(readAutoApproveEnabled()).toBe(false)
  })
})

describe('syncAutoApproveToMainProcess', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('将当前偏好同步到主进程', () => {
    localStorage.setItem(AUTO_APPROVE_STORAGE_KEY, 'false')
    const sendCommand = vi.fn().mockResolvedValue(undefined)
    syncAutoApproveToMainProcess(sendCommand)
    expect(sendCommand).toHaveBeenCalledWith({
      type: 'user:auto-approve:set',
      enabled: false,
    })
  })

  it('sendCommand 缺失时不抛错', () => {
    expect(() => syncAutoApproveToMainProcess(undefined)).not.toThrow()
  })
})
