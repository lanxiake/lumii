/**
 * disk-space 单元测试
 */
import { describe, expect, it } from 'vitest'
import { extractDriveLetter } from './disk-space'

describe('extractDriveLetter', () => {
  it('解析 Windows 盘符', () => {
    expect(extractDriveLetter('E:\\foo\\bar')).toBe('E')
    expect(extractDriveLetter('c:/tmp')).toBe('C')
  })

  it('posix 绝对路径：Windows 解析到当前盘，其它平台无盘符', () => {
    if (process.platform === 'win32') {
      expect(extractDriveLetter('/tmp/foo')).toMatch(/^[A-Z]$/)
    } else {
      expect(extractDriveLetter('/tmp/foo')).toBe(null)
    }
  })
})
