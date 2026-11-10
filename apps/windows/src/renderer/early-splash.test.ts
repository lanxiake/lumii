/**
 * 开机画面收尾看门狗。
 *
 * 这条用例守的是一个真实事故：App 侧按「本会话已播过」跳过 SplashOverlay 时，
 * early-splash 仍照挂覆盖层，于是没有任何代码去调 complete()，画面永远盖住主界面。
 * 现在两处用的是同一个判定，且 early-splash 自己也有超时兜底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mountBootVisual = vi.fn(() => ({
  complete: vi.fn(async () => undefined),
  destroy: vi.fn(),
  getProgress: () => 0,
}))

vi.mock('./boot/boot-visual', () => ({
  BOOT_ID: 'lumii-boot',
  mountBootVisual: () => mountBootVisual(),
}))

vi.mock('./boot/boot-audio', () => ({
  createBootAudio: () => ({
    pulse: () => undefined,
    climaxPulse: () => undefined,
    gateOpen: () => undefined,
    logoLand: () => undefined,
    setStalled: () => undefined,
    finish: async () => undefined,
    stop: () => undefined,
  }),
}))

describe('early-splash 跳过判定', () => {
  beforeEach(() => {
    vi.resetModules()
    mountBootVisual.mockClear()
    document.body.innerHTML = ''
    sessionStorage.clear()
    localStorage.clear()
    // @ts-expect-error 测试桩
    window.electronAPI = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('本会话已播过时不挂载覆盖层（页面重载场景）', async () => {
    sessionStorage.setItem('lumii.splash.done', '1')
    await import('./early-splash')
    expect(mountBootVisual).not.toHaveBeenCalled()
  })

  it('设置里关闭开机动画时不挂载', async () => {
    localStorage.setItem(
      'mtbot-assistant-settings',
      JSON.stringify({ system: { showSplashOnStartup: false } }),
    )
    await import('./early-splash')
    expect(mountBootVisual).not.toHaveBeenCalled()
  })

  it('首次启动正常挂载', async () => {
    await import('./early-splash')
    expect(mountBootVisual).toHaveBeenCalledTimes(1)
  })
})
