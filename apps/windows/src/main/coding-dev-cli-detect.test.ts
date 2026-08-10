/**
 * 回归测试：where.exe 命中多个同名候选时，应按 PATH 顺序取，
 * 不能因为扩展名分数把排在后面的无关 .exe 提前（曾导致检测 opencode 时
 * 误 spawn 一个同名桌面应用）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { pickBestWindowsCliPath } from './coding-dev-cli-detect.js'

describe('pickBestWindowsCliPath', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('PATH 中排前面的 .cmd 命中，即使后面还有一个 .exe', () => {
    const candidates = [
      'D:\\develop\\node-v22.14.0-win-x64\\opencode.cmd',
      'D:\\mysoft\\OpenCode\\OpenCode.exe',
    ]
    expect(pickBestWindowsCliPath(candidates)).toBe(candidates[0])
  })

  it('排前面的候选是 bash shim（无扩展名同目录有 .cmd）时跳过，取下一个可用的', () => {
    const candidates = [
      'C:\\tool\\foo',
      'C:\\tool\\foo.cmd',
    ]
    // foo 无扩展名且同目录存在 foo.cmd -> 判定为 shim，score = -1
    expect(pickBestWindowsCliPath(candidates)).toBe(candidates[1])
  })
})
