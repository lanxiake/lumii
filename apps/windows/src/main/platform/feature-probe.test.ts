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

import { isWaylandSession, collectFeatureProbeInput, getFeatureAvailability } from './feature-probe'

const SESSION_VARS = ['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'DISPLAY'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of SESSION_VARS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  detectSystemPythonSpy.mockReset()
  detectSystemPythonSpy.mockReturnValue(null)
})

afterEach(() => {
  for (const key of SESSION_VARS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
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
