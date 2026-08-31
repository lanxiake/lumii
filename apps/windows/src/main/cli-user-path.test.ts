/**
 * 用户 CLI 目录并入 PATH 的单测
 */

import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { listUserCliBinDirs, mergePathWithCliDirs } from './cli-user-path'

describe('listUserCliBinDirs', () => {
  it('包含 uv 默认安装目录 ~/.local/bin', () => {
    expect(listUserCliBinDirs()).toContain(path.join(os.homedir(), '.local', 'bin'))
  })
})

describe('mergePathWithCliDirs', () => {
  it('把已存在且不在 PATH 里的目录前置', () => {
    const extra = 'C:\\Users\\x\\.local\\bin'
    const merged = mergePathWithCliDirs('C:\\Windows\\System32', [extra], (dir) => dir === extra)
    expect(merged.split(path.delimiter)[0]).toBe(extra)
  })

  it('不存在的目录不写入 PATH', () => {
    const extra = 'C:\\Users\\x\\.local\\bin'
    const merged = mergePathWithCliDirs('C:\\Windows\\System32', [extra], () => false)
    expect(merged).toBe('C:\\Windows\\System32')
  })

  it('已在 PATH 中的目录不重复前置', () => {
    const extra = 'C:\\Users\\x\\.local\\bin'
    const current = `${extra}${path.delimiter}C:\\Windows\\System32`
    const merged = mergePathWithCliDirs(current, [extra], () => true)
    const hits = merged.split(path.delimiter).filter((p) => p.toLowerCase() === extra.toLowerCase())
    expect(hits).toHaveLength(1)
  })
})
