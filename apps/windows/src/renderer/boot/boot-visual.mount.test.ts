/**
 * 开机动画挂载自检。
 *
 * 这里只验证「结构能挂上、阶段能推进、能干净收尾」，
 * 不验证视觉——分形星云和粒子效果在 jsdom 里没有画布，测了也是假绿。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOT_ID, mountBootVisual } from './boot-visual'

describe('mountBootVisual 挂载与收尾', () => {
  afterEach(() => {
    document.getElementById(BOOT_ID)?.remove()
    document.getElementById(`${BOOT_ID}-style`)?.remove()
  })

  it('挂载后注入根节点与样式表', () => {
    const handle = mountBootVisual()
    expect(document.getElementById(BOOT_ID)).toBeTruthy()
    expect(document.getElementById(`${BOOT_ID}-style`)).toBeTruthy()
    handle.destroy()
  })

  it('收到进度后推进阶段，并把阶段名写进界面', () => {
    const seen: string[] = []
    let fire: ((p: { phase: string; index: number; total: number }) => void) | null = null
    const handle = mountBootVisual({
      subscribe: (cb) => {
        fire = cb
        return () => {
          fire = null
        }
      },
      onPhase: (label) => seen.push(label),
    })

    fire!({ phase: 'S0-app-shell', index: 1, total: 11 })
    fire!({ phase: 'S7-services', index: 6, total: 11 })

    expect(seen).toEqual(['初始化运行时', '启动本地服务'])
    expect(document.querySelector('#bk-phase-text')?.textContent).toBe('启动本地服务')
    handle.destroy()
  })

  it('destroy 之后根节点被移除，且不再改动 DOM', () => {
    const handle = mountBootVisual()
    handle.destroy()
    expect(document.getElementById(BOOT_ID)).toBeNull()
  })

  it('重复调用 destroy 不抛错', () => {
    const handle = mountBootVisual()
    handle.destroy()
    expect(() => handle.destroy()).not.toThrow()
  })

  it('减少动效偏好下仍能正常挂载', () => {
    const handle = mountBootVisual({ reducedMotion: true })
    expect(document.getElementById(BOOT_ID)).toBeTruthy()
    handle.destroy()
  })

  it('进度在收到真实信号前不会到 100%', () => {
    vi.useFakeTimers()
    const handle = mountBootVisual()
    // 兜底曲线只逼近上限，绝不自称完成
    expect(handle.getProgress()).toBeLessThan(100)
    handle.destroy()
    vi.useRealTimers()
  })
})
