/**
 * disk-space 单元测试
 *
 * `extractDriveLetter` 的语义是**字符串解析**（Windows 盘符），但实现里先过了一遍
 * `path.resolve`。在 Linux 上 `path.resolve('E:\\foo\\bar')` 会把 `E:\foo\bar`
 * 当成相对路径拼到 cwd 后，导致这个纯解析函数无法用 Windows 路径样例测试。
 * 因此按平台分别验证：Windows 上直接给 Windows 路径；POSIX 上只断言
 * 「不把 POSIX 路径误判成盘符」。两边都保留，Windows 侧的回归保护不削弱。
 */
import { describe, expect, it } from 'vitest'
import { extractDriveLetter } from './disk-space'

const isWin = process.platform === 'win32'

describe('extractDriveLetter', () => {
  if (isWin) {
    it('解析 Windows 盘符', () => {
      expect(extractDriveLetter('E:\\foo\\bar')).toBe('E')
      expect(extractDriveLetter('c:/tmp')).toBe('C')
    })

    it('盘符统一大写', () => {
      expect(extractDriveLetter('d:\\x')).toBe('D')
    })

    it('posix 绝对路径解析到当前盘', () => {
      expect(extractDriveLetter('/tmp/foo')).toMatch(/^[A-Z]$/)
    })
  } else {
    it('POSIX 绝对路径没有盘符，返回 null（非 Windows 无盘符概念）', () => {
      expect(extractDriveLetter('/tmp/foo')).toBe(null)
      expect(extractDriveLetter('/home/x')).toBe(null)
    })

    it('相对路径也返回 null，不会误判', () => {
      expect(extractDriveLetter('relative/path')).toBe(null)
      expect(extractDriveLetter('.')).toBe(null)
    })
  }

  it('空路径不崩，返回 null', () => {
    expect(extractDriveLetter('')).toBe(null)
  })
})
