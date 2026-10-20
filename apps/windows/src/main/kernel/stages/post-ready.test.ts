import { describe, expect, it } from 'vitest'

import { startPostReadyServices, type ConflictDrivenBridge } from './post-ready'

/**
 * 冲突重试回调是「不报错、只表现为云同步卡住」的那类逻辑：
 * 注册了但从不触发，界面上什么都看不出来。所以这里钉的是回调本身。
 */

function makeLogger(): { info: string[]; warn: string[]; logger: { info(m: string): void; warn(m: string): void } } {
  const info: string[] = []
  const warn: string[] = []
  return { info, warn, logger: { info: (m) => info.push(m), warn: (m) => warn.push(m) } }
}

function makeScheduler() {
  let handler: (() => Promise<void>) | null = null
  return {
    scheduler: {
      setOnConflictPending: (h: () => Promise<void>) => {
        handler = h
      },
    },
    fire: () => handler?.(),
    registered: () => handler !== null,
  }
}

function makeBridge(overrides: Partial<ConflictDrivenBridge> = {}): ConflictDrivenBridge {
  return {
    isInitialized: true,
    executeSyncConflictGoal: async () => 'ok',
    ...overrides,
  }
}

describe('startPostReadyServices', () => {
  it('注册冲突回调；bridge 未就绪时静默跳过（不炸、不驱动）', async () => {
    const { scheduler, fire, registered } = makeScheduler()
    const { logger } = makeLogger()

    await startPostReadyServices({
      syncScheduler: scheduler,
      getBridge: () => null,
      startBrowserService: async () => true,
      logger,
    })

    expect(registered()).toBe(true)
    await expect(fire()).resolves.toBeUndefined()
  })

  it('bridge 在但没初始化完 → 不驱动冲突处理', async () => {
    const { scheduler, fire } = makeScheduler()
    const { logger } = makeLogger()
    let driven = 0

    await startPostReadyServices({
      syncScheduler: scheduler,
      getBridge: () => makeBridge({ isInitialized: false }),
      startBrowserService: async () => true,
      logger,
    })
    await fire()

    expect(driven).toBe(0)
  })

  it('bridge 就绪 → 回调驱动一轮 executeSyncConflictGoal', async () => {
    const { scheduler, fire } = makeScheduler()
    const { logger } = makeLogger()
    let driven = 0

    await startPostReadyServices({
      syncScheduler: scheduler,
      getBridge: () =>
        makeBridge({
          executeSyncConflictGoal: async () => {
            driven += 1
            return 'done'
          },
        }),
      startBrowserService: async () => true,
      logger,
    })
    await fire()

    expect(driven).toBe(1)
  })

  it('没有调度器时什么都不注册，只起浏览器服务', async () => {
    const { logger, info } = makeLogger()
    let started = 0

    await startPostReadyServices({
      syncScheduler: null,
      getBridge: () => null,
      startBrowserService: async () => {
        started += 1
        return true
      },
      logger,
    })

    expect(started).toBe(1)
    expect(info).toEqual(['浏览器控制服务已就绪'])
  })

  it('浏览器服务起不来只记 warn，不抛错（browser.* 命令不可用而已）', async () => {
    const { logger, warn, info } = makeLogger()

    await expect(
      startPostReadyServices({
        syncScheduler: null,
        getBridge: () => null,
        startBrowserService: async () => false,
        logger,
      }),
    ).resolves.toBeUndefined()

    expect(info).toEqual([])
    expect(warn).toEqual(['浏览器控制服务启动失败，browser.* 命令将不可用'])
  })
})
