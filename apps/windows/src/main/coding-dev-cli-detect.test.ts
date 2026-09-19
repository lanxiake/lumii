/**
 * 回归测试：
 *
 * 1. where.exe 命中多个同名候选时，应按 PATH 顺序取，不能因为扩展名分数把排在
 *    后面的无关 .exe 提前（曾导致检测 opencode 时误 spawn 一个同名桌面应用）。
 * 2. 元数据出口的平台差异：Windows 专属的 PowerShell 安装命令不能在 Linux 上
 *    原样展示（见 `listLocalAcpToolsMetadata 的平台差异`）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { pickBestWindowsCliPath, listLocalAcpToolsMetadata } from './coding-dev-cli-detect.js'

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

/**
 * 元数据出口按平台调整安装提示。
 *
 * 背景：`LOCAL_ACP_TOOL_META` 里的 `installCommand` 是 Windows 专属的
 * （`irm ... | iex`）。Linux 上该命令跑不通，而渲染层会把它原样展示、还会拼进
 * 「让 AI 安装」的提示词，所以**出口处必须换掉**，同时不能动摇
 * `automatic` 判据所依赖的原始配方（那条判据正是「Linux 不自动安装」的依据）。
 */
describe('listLocalAcpToolsMetadata 的平台差异', () => {
  const ORIGINAL_PLATFORM = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  })

  it('Linux 上不给出 PowerShell 安装命令，改为指向官方文档', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    const metadatas = listLocalAcpToolsMetadata()
    expect(metadatas.length).toBeGreaterThan(0)
    for (const m of metadatas) {
      expect(m.installCommand).not.toMatch(/irm |\.ps1|iex/i)
      expect(m.installCommand).toContain(m.installUrl)
    }
    // 原始配方不能被就地改掉：`automatic` 判据依赖 powershellCommand 是否存在
    expect(listLocalAcpToolsMetadata().find((m) => m.id === 'claude')?.installHint)
      .toContain('当前平台')
  })

  it('Windows 上原样返回（安装命令保持 PowerShell 脚本）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    const claude = listLocalAcpToolsMetadata().find((m) => m.id === 'claude')
    expect(claude?.installCommand).toMatch(/install\.ps1/)
    expect(claude?.installHint).not.toContain('当前平台')
  })
})
