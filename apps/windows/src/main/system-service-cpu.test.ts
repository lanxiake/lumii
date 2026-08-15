/**
 * CPU 使用率差分采样（Task 4.1）
 *
 * 只校验差分逻辑本身：首次无基准、正常差分、间隔为 0、以及上下界钳制。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SystemService } from './system-service'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lumii-test' },
  shell: {},
}))

// system-service 用 `import * as os`，spyOn 拿不到同一个绑定，必须整包 mock。
// hoisted 是为了让 mock 工厂提前拿到这个可变容器。
const cpuState = vi.hoisted(() => ({ idle: 0, busy: 0 }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const cpus = () => [
    {
      model: 'test',
      speed: 1,
      times: { user: cpuState.busy, nice: 0, sys: 0, idle: cpuState.idle, irq: 0 },
    },
  ]
  return { ...actual, cpus, default: { ...actual, cpus } }
})

/** 设定下一次 os.cpus() 返回的累计 times */
function setCpu(idle: number, busy: number): void {
  cpuState.idle = idle
  cpuState.busy = busy
}

describe('SystemService CPU 差分采样', () => {
  let svc: SystemService

  beforeEach(() => {
    setCpu(0, 0)
    svc = new SystemService()
  })

  it('首次调用无基准，返回 undefined 而不是 0', () => {
    setCpu(1000, 0)
    expect(svc.getSystemInfo().cpuUsage).toBeUndefined()
  })

  it('idle 只涨一半 → 50%', () => {
    setCpu(1000, 0)
    svc.getSystemInfo()
    // total +200，其中 idle +100
    setCpu(1100, 100)
    expect(svc.getSystemInfo().cpuUsage).toBe(50)
  })

  it('idle 完全不涨 → 100%', () => {
    setCpu(1000, 0)
    svc.getSystemInfo()
    setCpu(1000, 200)
    expect(svc.getSystemInfo().cpuUsage).toBe(100)
  })

  it('全部时间都在 idle → 0%', () => {
    setCpu(1000, 0)
    svc.getSystemInfo()
    setCpu(1200, 0)
    expect(svc.getSystemInfo().cpuUsage).toBe(0)
  })

  it('两次采样 times 完全没走动 → undefined，不当成 0%', () => {
    setCpu(1000, 0)
    svc.getSystemInfo()
    setCpu(1000, 0)
    expect(svc.getSystemInfo().cpuUsage).toBeUndefined()
  })
})
