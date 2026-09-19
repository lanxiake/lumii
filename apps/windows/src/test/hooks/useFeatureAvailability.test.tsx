/**
 * useFeatureAvailability 的行为规格（设计 §7 / D4）。
 *
 * 重点是**降级取向**：拿不到矩阵时按「全部可用」而不是「全部禁用」。
 * 这条值得测——反过来的话，main 侧一有 IPC 故障，整个界面就被禁用了，
 * 代价远大于「某个入口点了才发现不支持」（后者还有 main 侧兜底报错）。
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFeatureAvailability } from '../../renderer/hooks/business/useFeatureAvailability'

type GetFeature = ReturnType<typeof vi.fn>

function stubApi(impl: GetFeature): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    app: { getFeatureAvailability: impl },
  }
}

const LINUX_SNAPSHOT = {
  features: {
    petMode: { available: false, reason: 'platform-unsupported' as const },
    screenRecord: { available: false, reason: 'platform-unsupported' as const },
    systemAudioCapture: { available: false, reason: 'platform-unsupported' as const },
    pythonSkills: { available: true },
    codingCliAutoInstall: { available: false, reason: 'platform-unsupported' as const },
    localTts: { available: false, reason: 'platform-unsupported' as const },
    voiceCloning: { available: false, reason: 'platform-unsupported' as const },
  },
  messages: {
    petMode: { 'platform-unsupported': 'Linux 版暂不支持宠物模式，后续将以精灵图形态回归。' },
    pythonSkills: { 'missing-runtime': '需要 Python 3。请先安装：sudo apt install python3' },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useFeatureAvailability', () => {
  it('取到矩阵后按快照判定可用性', async () => {
    stubApi(vi.fn().mockResolvedValue(LINUX_SNAPSHOT))

    const { result } = renderHook(() => useFeatureAvailability())

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.isAvailable('petMode')).toBe(false)
    expect(result.current.isAvailable('pythonSkills')).toBe(true)
  })

  it('不可用时给出文案（D4：禁止静默失败）', async () => {
    stubApi(vi.fn().mockResolvedValue(LINUX_SNAPSHOT))

    const { result } = renderHook(() => useFeatureAvailability())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.blockMessage('petMode')).toContain('宠物模式')
  })

  it('可用时文案为 null（避免 UI 拿到自相矛盾的状态）', async () => {
    stubApi(vi.fn().mockResolvedValue(LINUX_SNAPSHOT))

    const { result } = renderHook(() => useFeatureAvailability())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.blockMessage('pythonSkills')).toBeNull()
  })

  it('暴露 blockReason 便于按原因分支（如「缺运行时」给安装引导）', async () => {
    stubApi(vi.fn().mockResolvedValue(LINUX_SNAPSHOT))

    const { result } = renderHook(() => useFeatureAvailability())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.blockReason('petMode')).toBe('platform-unsupported')
    expect(result.current.blockReason('pythonSkills')).toBeUndefined()
  })

  it('未就绪时按「可用」处理（不闪一下禁用态）', () => {
    stubApi(vi.fn(() => new Promise(() => {}))) // 永不 resolve

    const { result } = renderHook(() => useFeatureAvailability())

    expect(result.current.ready).toBe(false)
    expect(result.current.isAvailable('petMode')).toBe(true)
    expect(result.current.blockMessage('petMode')).toBeNull()
  })

  /**
   * 回归（T4 冒烟查出）：`isAvailable` 在就绪前返回 true 是**有意的**，
   * 但调用方若拿它单独当 `useEffect` 的判据，首次渲染就会把 IPC 发出去——
   * Linux 上 `pet:*` 的 handler 根本没注册，控制台刷 `No handler registered`。
   *
   * 所以 `ready` 必须可观察、且就绪前为 false，调用方靠它把副作用挡在门外。
   * 这条锁的是契约本身，不是某个组件的实现。
   */
  it('`ready` 在矩阵取回前为 false（调用方据此挡住副作用）', async () => {
    let resolveApi: ((v: unknown) => void) | undefined
    stubApi(
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveApi = resolve
          }),
      ),
    )

    const { result } = renderHook(() => useFeatureAvailability())
    expect(result.current.ready).toBe(false)

    resolveApi?.(LINUX_SNAPSHOT)
    await waitFor(() => expect(result.current.ready).toBe(true))

    // 就绪后按快照判定，与 ready=false 时的乐观值不同
    expect(result.current.isAvailable('petMode')).toBe(false)
  })

  it('IPC 失败时按「全部可用」降级，而不是禁用整个界面', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubApi(vi.fn().mockRejectedValue(new Error('IPC 挂了')))

    const { result } = renderHook(() => useFeatureAvailability())

    await waitFor(() => expect(result.current.ready).toBe(true))
    // 关键：失败后依然报「可用」——把界面禁用掉的代价远大于此
    expect(result.current.isAvailable('petMode')).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('文案缺失时回落到通用说明，而不是 undefined', async () => {
    stubApi(
      vi.fn().mockResolvedValue({
        features: { screenRecord: { available: false, reason: 'wayland-session' } },
        messages: {}, // 没登记 wayland-session 的文案
      }),
    )

    const { result } = renderHook(() => useFeatureAvailability())
    await waitFor(() => expect(result.current.ready).toBe(true))

    expect(result.current.blockMessage('screenRecord')).toBe('当前环境不支持该功能。')
  })

  it('快照里没有的功能按可用处理（矩阵演进时向前兼容）', async () => {
    stubApi(
      vi.fn().mockResolvedValue({
        features: { petMode: { available: false, reason: 'platform-unsupported' } },
        messages: {},
      }),
    )

    const { result } = renderHook(() => useFeatureAvailability())
    await waitFor(() => expect(result.current.ready).toBe(true))

    // voiceCloning 不在快照里——不该因此被禁用
    expect(result.current.isAvailable('voiceCloning')).toBe(true)
  })
})
