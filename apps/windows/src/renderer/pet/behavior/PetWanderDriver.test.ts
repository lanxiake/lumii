/**
 * PetWanderDriver 的让位语义。
 *
 * 这一组测试是**实测事故的回归哨兵**：最初让位用的是计数器，`mousedown` 记 `drag`、
 * 点击分支记 `tap` 且只解除自己，于是 `drag` 那次永远无人解除——每点一下泄漏一个，
 * 实测把计数顶到 12，宠物永久卡在"让位"状态（走路完全停摆，但日志里没有任何报错）。
 *
 * 所以这里钉的不是"计数对不对"，而是**按 reason 记账**这个契约本身。
 */

import { describe, it, expect, vi } from 'vitest'
import { AMBIENT_DEFAULTS } from '@mtbot/pet-core'
import { PetWanderDriver } from './PetWanderDriver'
import type { PetRendererProvider } from '../renderer/types'

/** 只实现驱动真正用到的那几个方法；其余用断言挡住"其实不该被调用" */
function fakeRenderer(): PetRendererProvider {
  return {
    getPosition: () => ({ x: 100, y: 200 }),
    setPosition: vi.fn(),
    setFlip: vi.fn(),
    getLayout: () => ({ anchorX: 45, scale: 2 }),
  } as unknown as PetRendererProvider
}

/** 随机源固定，让活动决策可预测 */
const fixedRand = () => 0.5

function makeDriver() {
  const onActivity = vi.fn<(a: string) => void>()
  const driver = new PetWanderDriver({
    renderer: fakeRenderer(),
    onActivity,
    config: AMBIENT_DEFAULTS,
    rand: fixedRand,
  })
  return { driver, onActivity }
}

describe('PetWanderDriver — 让位按 reason 记账', () => {
  it('初始不让位', () => {
    const { driver } = makeDriver()
    expect(driver.isSuspended()).toBe(false)
  })

  it('同一个 reason 重复让位只算一次（幂等）', () => {
    const { driver } = makeDriver()
    driver.suspend('pointer')
    driver.suspend('pointer')
    driver.suspend('pointer')
    expect(driver.isSuspended()).toBe(true)

    driver.resume('pointer')
    // 计数器版本在这里会残留 2 个，宠物再也不动
    expect(driver.isSuspended()).toBe(false)
  })

  it('不同 reason 叠加，必须全部解除才恢复', () => {
    const { driver } = makeDriver()
    driver.suspend('pointer')
    driver.suspend('ambient-disabled')
    expect(driver.isSuspended()).toBe(true)

    driver.resume('pointer')
    expect(driver.isSuspended()).toBe(true) // 还有一个来源

    driver.resume('ambient-disabled')
    expect(driver.isSuspended()).toBe(false)
  })

  it('解除一个从没记过的 reason 不改变状态，也不抛错', () => {
    const { driver } = makeDriver()
    driver.suspend('pointer')
    driver.resume('从未记过的名字')
    expect(driver.isSuspended()).toBe(true)
    expect(driver.isHeldBy('pointer')).toBe(true)
  })

  it('空状态下 resume 是空操作', () => {
    const { driver } = makeDriver()
    expect(() => driver.resume('pointer')).not.toThrow()
    expect(driver.isSuspended()).toBe(false)
  })

  it('isHeldBy 能区分具体来源（开关类调用方据此避免空解除）', () => {
    const { driver } = makeDriver()
    driver.suspend('pointer')
    expect(driver.isHeldBy('pointer')).toBe(true)
    expect(driver.isHeldBy('ambient-disabled')).toBe(false)
  })
})

describe('PetWanderDriver — 让位与恢复时回到站立', () => {
  it('首次让位会重置成 stand 并广播一次活动', () => {
    const { driver, onActivity } = makeDriver()
    onActivity.mockClear()
    driver.suspend('pointer')
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(onActivity).toHaveBeenCalledWith('stand')
    expect(driver.getActivity()).toBe('stand')
  })

  it('重复让位不再广播（避免每帧刷上层）', () => {
    const { driver, onActivity } = makeDriver()
    driver.suspend('pointer')
    onActivity.mockClear()
    driver.suspend('pointer')
    expect(onActivity).not.toHaveBeenCalled()
  })

  it('还有一个来源没解除时不广播恢复', () => {
    const { driver, onActivity } = makeDriver()
    driver.suspend('pointer')
    driver.suspend('ambient-disabled')
    onActivity.mockClear()

    driver.resume('pointer')
    expect(onActivity).not.toHaveBeenCalled() // 仍在让位

    driver.resume('ambient-disabled')
    expect(onActivity).toHaveBeenCalledWith('stand')
  })

  it('恢复时从渲染器重新读位置（期间可能被拖拽改过）', () => {
    const renderer = fakeRenderer()
    const getPosition = vi.fn(() => ({ x: 777, y: 333 }))
    renderer.getPosition = getPosition

    const driver = new PetWanderDriver({
      renderer,
      onActivity: vi.fn(),
      config: AMBIENT_DEFAULTS,
      rand: fixedRand,
    })
    driver.suspend('pointer')
    expect(getPosition).not.toHaveBeenCalled() // 让位本身不关心位置

    driver.resume('pointer')
    // 不重新读的话，驱动会拿被拖拽之前的老坐标继续走，表现为"松手后宠物跳回原处"
    expect(getPosition).toHaveBeenCalled()
    expect(driver.isSuspended()).toBe(false)
  })
})

describe('PetWanderDriver — 朝向', () => {
  it('初始面朝右（素材默认朝向）', () => {
    const { driver } = makeDriver()
    expect(driver.getFacing()).toBe(1)
  })
})
