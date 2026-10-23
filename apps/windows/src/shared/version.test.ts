import { describe, expect, it } from 'vitest'

import { compareVersions, isNewerVersion } from './version'

describe('compareVersions / isNewerVersion', () => {
  it('按数字比较而不是字符串', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.2', '1.2.3')).toBeLessThan(0)
  })

  it('正式版高于预发布版', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0)
  })

  it('缺任一侧版本时不判断为可更新', () => {
    expect(isNewerVersion(undefined, '0.10.0')).toBe(false)
    expect(isNewerVersion('0.10.0', undefined)).toBe(false)
    expect(isNewerVersion('0.10.0', '0.10.0')).toBe(false)
    expect(isNewerVersion('0.11.0', '0.10.0')).toBe(true)
    // 本地比内置新（用户手装）不提示“更新”，避免降级
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false)
  })
})
