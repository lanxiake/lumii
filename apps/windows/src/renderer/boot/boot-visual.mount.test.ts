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
    vi.useRealTimers()
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

  it('同一阶段超时后进入卡住态：data-stall 与阶段文案', () => {
    vi.useFakeTimers()
    let now = 1_000
    let fire: ((p: { phase: string; index: number; total: number }) => void) | null = null
    const stalls: boolean[] = []
    const handle = mountBootVisual({
      now: () => now,
      stallMs: 6_000,
      subscribe: (cb) => {
        fire = cb
        return () => {
          fire = null
        }
      },
      onStall: (stalled) => stalls.push(stalled),
    })

    fire!({ phase: 'S7-services', index: 6, total: 11 })
    expect(document.getElementById(BOOT_ID)?.dataset.stall).not.toBe('1')

    now = 1_000 + 6_000
    vi.advanceTimersByTime(300)
    expect(document.getElementById(BOOT_ID)?.dataset.stall).toBe('1')
    expect(document.querySelector('#bk-phase-text')?.textContent).toContain('仍在：启动本地服务')
    expect(document.querySelector('#bk-phase-text')?.textContent).toContain('已等待')
    expect(document.querySelector('#bk-t-sync')?.textContent).toBe('HOLD')
    expect(stalls).toContain(true)

    handle.destroy()
  })

  it('新阶段到达后退出卡住态', () => {
    vi.useFakeTimers()
    let now = 0
    let fire: ((p: { phase: string; index: number; total: number }) => void) | null = null
    const stalls: boolean[] = []
    const handle = mountBootVisual({
      now: () => now,
      stallMs: 6_000,
      subscribe: (cb) => {
        fire = cb
        return () => {
          fire = null
        }
      },
      onStall: (stalled) => stalls.push(stalled),
    })

    fire!({ phase: 'S7-services', index: 6, total: 11 })
    now = 7_000
    vi.advanceTimersByTime(300)
    expect(document.getElementById(BOOT_ID)?.dataset.stall).toBe('1')

    now = 7_500
    fire!({ phase: 'S7.1-seed-skills', index: 7, total: 11 })
    vi.advanceTimersByTime(50)
    expect(document.getElementById(BOOT_ID)?.dataset.stall).not.toBe('1')
    expect(document.querySelector('#bk-phase-text')?.textContent).toBe('同步内置技能')
    expect(stalls).toEqual(expect.arrayContaining([true, false]))

    handle.destroy()
  })

  it('无真实阶段进入卡住态时文案为等待启动信号', () => {
    vi.useFakeTimers()
    let now = 0
    const handle = mountBootVisual({
      now: () => now,
      stallMs: 6_000,
    })

    now = 6_000
    vi.advanceTimersByTime(300)
    expect(document.getElementById(BOOT_ID)?.dataset.stall).toBe('1')
    expect(document.querySelector('#bk-phase-text')?.textContent).toContain('等待启动信号')

    handle.destroy()
  })

  it('后段阶段进入 cognition 幕', () => {
    let fire: ((p: { phase: string; index: number; total: number }) => void) | null = null
    const handle = mountBootVisual({
      subscribe: (cb) => {
        fire = cb
        return () => {
          fire = null
        }
      },
    })

    fire!({ phase: 'S7.4-agent-runtime', index: 9, total: 11 })
    expect(document.getElementById(BOOT_ID)?.dataset.act).toBe('cognition')
    expect(document.querySelector('#bk-act-name')?.textContent).toBe('COGNITION')

    handle.destroy()
  })

  it('complete 触发门户裂开与高潮回调', async () => {
    vi.useFakeTimers()
    const climaxes: string[] = []
    const handle = mountBootVisual({
      onClimax: (kind) => climaxes.push(kind),
    })

    const done = handle.complete()
    await vi.advanceTimersByTimeAsync(400)
    expect(document.querySelector('#lumii-boot .gate-seam')?.classList.contains('open')).toBe(true)
    expect(document.querySelector('#lumii-boot .shock')?.classList.contains('fire')).toBe(true)
    expect(climaxes).toContain('gate-seam')

    await vi.advanceTimersByTimeAsync(5_000)
    await done
    expect(climaxes).toEqual(expect.arrayContaining(['gate-seam', 'logo-land']))
    expect(document.getElementById(BOOT_ID)).toBeNull()
  })
})
