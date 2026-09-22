/**
 * @vitest-environment node
 */
/**
 * feature-probe 的规格。
 *
 * 重点是 `isWaylandSession` 的三种情况——只判断 `WAYLAND_DISPLAY` 会把
 * 「X11 会话里的 XWayland 客户端」误判成 Wayland（它其实可以正常录屏），
 * 也会漏掉「Wayland 会话里 `WAYLAND_DISPLAY` 为空」的情况。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { detectSystemPythonSpy } = vi.hoisted(() => ({
  detectSystemPythonSpy: vi.fn(() => null as string | null),
}))

vi.mock('../python-env', () => ({
  detectSystemPython: () => detectSystemPythonSpy(),
}))

import {
  isWaylandSession,
  isHeadlessSession,
  hasHeadlessFlag,
  collectFeatureProbeInput,
  getFeatureAvailability,
} from './feature-probe'

const SESSION_VARS = ['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'DISPLAY'] as const
const saved: Record<string, string | undefined> = {}
const savedArgv = [...process.argv]

beforeEach(() => {
  for (const key of SESSION_VARS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.argv = [...savedArgv]
  detectSystemPythonSpy.mockReset()
  detectSystemPythonSpy.mockReturnValue(null)
})

afterEach(() => {
  for (const key of SESSION_VARS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  process.argv = [...savedArgv]
})

describe('isWaylandSession', () => {
  it('XDG_SESSION_TYPE=wayland → true', () => {
    process.env.XDG_SESSION_TYPE = 'wayland'

    expect(isWaylandSession()).toBe(true)
  })

  it('XDG_SESSION_TYPE=x11 → false，即使 WAYLAND_DISPLAY 有值', () => {
    // X11 会话里跑 XWayland 客户端时，WAYLAND_DISPLAY 仍可能被继承下来，
    // 但它不是 Wayland 会话，录屏走 X11 完全可行——误判会让功能被错误屏蔽。
    process.env.XDG_SESSION_TYPE = 'x11'
    process.env.WAYLAND_DISPLAY = 'wayland-0'

    expect(isWaylandSession()).toBe(false)
  })

  it('XDG_SESSION_TYPE 缺失时退回看 WAYLAND_DISPLAY', () => {
    process.env.WAYLAND_DISPLAY = 'wayland-0'

    expect(isWaylandSession()).toBe(true)
  })

  it('都不设置 → false', () => {
    expect(isWaylandSession()).toBe(false)
  })

  it('大小写不敏感（环境变量值可能是 Wayland）', () => {
    process.env.XDG_SESSION_TYPE = 'Wayland'

    expect(isWaylandSession()).toBe(true)
  })

  it('Wayland 会话里 WAYLAND_DISPLAY 为空也算（以 SESSION_TYPE 为准）', () => {
    process.env.XDG_SESSION_TYPE = 'wayland'
    process.env.DISPLAY = ':0'

    expect(isWaylandSession()).toBe(true)
  })
})

describe('isHeadlessSession / hasHeadlessFlag', () => {
  const linuxOnly = process.platform === 'linux'

  it('没有 DISPLAY/WAYLAND_DISPLAY 时按无头算（tty / CI / systemd 拉起）', () => {
    if (!linuxOnly) return

    expect(isHeadlessSession()).toBe(true)
  })

  it('有 DISPLAY 且没带 --headless → 不是无头', () => {
    if (!linuxOnly) return
    process.env.DISPLAY = ':0'

    expect(isHeadlessSession()).toBe(false)
  })

  it('显式 --headless 启动时，即使有 DISPLAY 也算无头', () => {
    // 关键一条：`--headless` 会让 index.ts 跳过录屏/桌宠的初始化，
    // 矩阵若还按「有 DISPLAY 就可用」报，用户点进去只会静默失败（违反 D4）。
    if (!linuxOnly) return
    process.env.DISPLAY = ':0'
    process.argv = [...savedArgv, '--headless']

    expect(isHeadlessSession()).toBe(true)
  })

  it('非 Linux 平台恒为 false（Windows/macOS 没有这个维度）', () => {
    process.env.DISPLAY = ':0'
    process.argv = [...savedArgv, '--headless']

    if (!linuxOnly) expect(isHeadlessSession()).toBe(false)
    else expect(isHeadlessSession()).toBe(true)
  })

  it('能力矩阵跟着 --headless 联动（录屏与桌宠都报不可用）', () => {
    if (!linuxOnly) return
    process.env.DISPLAY = ':0'
    process.argv = [...savedArgv, '--headless']

    const features = getFeatureAvailability()

    expect(features.screenRecord.available).toBe(false)
    expect(features.screenRecord.reason).toBe('headless')
    expect(features.petMode.reason).toBe('headless')
    // 与之无关的功能不受影响
    expect(features.systemAudioCapture.reason).toBe('platform-unsupported')
  })

  it('只认完整的 --headless 参数（--headless-worker 不算）', () => {
    process.argv = [...savedArgv, '--headless-worker']

    expect(hasHeadlessFlag()).toBe(false)
  })
})

describe('collectFeatureProbeInput', () => {
  it('带上当前平台', () => {
    expect(collectFeatureProbeInput().platform).toBe(process.platform)
  })

  it('探测结果反映 Python 是否存在', () => {
    detectSystemPythonSpy.mockReturnValue('/usr/bin/python3')
    expect(collectFeatureProbeInput().hasSystemPython).toBe(true)

    detectSystemPythonSpy.mockReturnValue(null)
    expect(collectFeatureProbeInput().hasSystemPython).toBe(false)
  })

  it('headless 只在 Linux 上判断（Windows/macOS 没有这个维度）', () => {
    // 本机是 Linux 且测试进程没有 DISPLAY/WAYLAND_DISPLAY → headless 为 true。
    // 这条断言的是「判定逻辑存在且按平台分叉」，具体取值随 CI 环境而变。
    const input = collectFeatureProbeInput()

    if (process.platform !== 'linux') {
      expect(input.headless).toBe(false)
    } else {
      expect(typeof input.headless).toBe('boolean')
    }
  })
})

describe('getFeatureAvailability', () => {
  it('组合探测结果与矩阵，产出完整判定', () => {
    detectSystemPythonSpy.mockReturnValue('/usr/bin/python3')
    const result = getFeatureAvailability()

    expect(result.petMode).toBeDefined()
    expect(result.screenRecord).toBeDefined()
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(7)
  })

  it('每次调用都重新探测 Python（用户装完后不该要求重启应用）', () => {
    getFeatureAvailability()
    getFeatureAvailability()

    expect(detectSystemPythonSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
