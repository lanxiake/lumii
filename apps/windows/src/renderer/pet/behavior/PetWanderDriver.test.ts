/**
 * PetWanderDriver 的让位语义。
 *
 * 这一组测试是**实测事故的回归哨兵**：最初让位用的是计数器，`mousedown` 记 `drag`、
 * 点击分支记 `tap` 且只解除自己，于是 `drag` 那次永远无人解除——每点一下泄漏一个，
 * 实测把计数顶到 12，宠物永久卡在"让位"状态（走路完全停摆，但日志里没有任何报错）。
 *
 * 所以这里钉的不是"计数对不对"，而是**按 reason 记账**这个契约本身。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { AMBIENT_DEFAULTS } from '@mtbot/pet-core'
import { PetWanderDriver } from './PetWanderDriver'
import type { PetRendererProvider } from '../renderer/types'

/** 只实现驱动真正用到的那几个方法；其余用断言挡住"其实不该被调用" */
function fakeRenderer(): PetRendererProvider {
  return {
    // 默认位置在**地面线**上（视口底边，见 `PetWanderDriver.groundY()`）。
    // 随手写个 `y: 200` 会让 `resume` 走"悬在半空 → 转为坠落"那条分支——
    // 那是另一条用例的事，这里不想被它干扰。
    getPosition: () => ({ x: 100, y: window.innerHeight }),
    setPosition: vi.fn(),
    setFlip: vi.fn(),
    // `modelHeight` 不能省：驱动拿它算攀爬的缝隙与最小窗口高度，
    // 漏掉会得到 `Math.max(120, NaN)` = NaN，一路静默传播到位置里
    getLayout: () => ({ anchorX: 45, scale: 2, modelHeight: 100 }),
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

describe('PetWanderDriver — 攀附与掉落', () => {
  /**
   * 可控时钟。驱动靠自己起的 rAF 循环推进，测试里必须手动喂它。
   *
   * `MAX_FRAME_MS = 100` 会把单帧钳到 100ms，所以 `advance(n)` 就是"过 n 帧"。
   * **必须在 `driver.start()` 之前装**——start 里就注册了第一帧。
   */
  function makeClock() {
    let cb: ((t: number) => void) | null = null
    let now = 0
    vi.stubGlobal('requestAnimationFrame', (fn: (t: number) => void) => {
      cb = fn
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      cb = null
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    return {
      advance(steps: number, ms = 100) {
        for (let i = 0; i < steps; i++) {
          now += ms
          cb?.(now)
        }
      },
    }
  }

  /**
   * "宠物站在窗口左边、窗口在它上方"的场景。
   *
   * 几何（jsdom 视口 1024×768）：
   * 宠物 (500, 768) —— **y 就是视口底边**，这正是地面线的定义（见 `groundY()`），
   * 不再是"随手挑一个站得住的高度"；窗口 (500, 400) 800×368，底边正好贴着宠物的脚。
   */
  function makePerchScene() {
    const renderer = fakeRenderer()
    let pos = { x: 500, y: 768 }
    renderer.getPosition = () => ({ ...pos })
    renderer.setPosition = vi.fn((x: number, y: number) => {
      pos = { x, y }
    })
    const onActivity = vi.fn<(a: string) => void>()
    const driver = new PetWanderDriver({
      renderer,
      onActivity,
      config: AMBIENT_DEFAULTS,
      // 爬得飞快：这几条测的是"掉到哪"，不是"爬多久"
      // 留白比例用 `PERCH_DEFAULTS` 的真值（它们是实测素材来的，测试里没有理由另编一套）
      perchConfig: { attachDistance: 24, climbSpeed: 4500, wallGapRatio: 0.43, ceilingGapRatio: 0.3 },
      rand: () => 0.5,
    })
    driver.setPerchRect({ x: 500, y: 400, width: 800, height: 368 })
    driver.start()
    return {
      driver,
      onActivity,
      getPos: () => pos,
      setPos: (p: { x: number; y: number }) => {
        pos = p
      },
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('落地静止时靠近窗口边缘会吸附上去', () => {
    const clock = makeClock()
    const { driver } = makePerchScene()
    expect(driver.getPerch()).toBeNull() // start 不判吸附，要等一次 resume

    driver.suspend('pointer')
    driver.resume('pointer')
    expect(driver.getPerch()).toEqual({ kind: 'wall', side: 'left' })
    clock.advance(1)
  })

  it('爬到窗口上沿后转为沿上沿爬行', () => {
    const clock = makeClock()
    const { driver } = makePerchScene()
    driver.suspend('pointer')
    driver.resume('pointer')

    clock.advance(2)
    expect(driver.getPerch()).toEqual({ kind: 'ceiling', side: 'left' })
  })

  it('松手后落回地面线（视口底边），而不是停在半空', () => {
    const clock = makeClock()
    const { driver, onActivity, getPos } = makePerchScene()
    driver.suspend('pointer')
    driver.resume('pointer')
    clock.advance(2)
    expect(driver.getPerch()?.kind).toBe('ceiling')

    // 窗口没了 → 松手
    driver.setPerchRect(null)
    expect(onActivity).toHaveBeenLastCalledWith('fall')

    clock.advance(30)
    // 落地线必须是**视口底边**（768），不是松手时所在的天花板（430）。
    // 少了这一步，宠物会悬在窗口上沿的空中，并在那条看不见的地面线上走来走去。
    expect(getPos().y).toBe(768)
    expect(driver.getPerch()).toBeNull()
    expect(onActivity).toHaveBeenLastCalledWith('stand')
  })

  it('爬行途中被拖走，松手后掉落而不是弹回墙上', () => {
    const clock = makeClock()
    const { driver, onActivity, getPos, setPos } = makePerchScene()
    driver.suspend('pointer')
    driver.resume('pointer')
    clock.advance(2)
    expect(driver.getPerch()).not.toBeNull()

    // 用户在宠物爬着的时候把它拎到远处（水平移走，高度不变——
    // 掉高度会命中"悬空即坠落"那条分支，这里要测的是墙上核对）
    driver.suspend('pointer')
    setPos({ x: 900, y: 768 })
    driver.resume('pointer')

    // 让位期间 tick 不跑，没人发现它已经离墙很远了；不重新核对的话，
    // 恢复后的第一帧 stepPerch 会把它瞬移回墙线上
    expect(onActivity).toHaveBeenLastCalledWith('fall')
    clock.advance(30)
    expect(driver.getPerch()).toBeNull()
    expect(getPos().y).toBe(768)
  })

  it('拖到半空松手：接着往下掉，不在空气里走', () => {
    // 实测事故（2026-09-22）：`[onMouseUp] 速度不足（32 px/s），原地落下` 之后宠物
    // 就停在被举到的高度上，此后一直在那条看不见的地面线上走动，再也不下来。
    const clock = makeClock()
    const { driver, getPos, setPos } = makePerchScene()

    // 不先吸附——要走的正是"既不在墙上、也不在下落"那条分支
    driver.suspend('pointer')
    setPos({ x: 500, y: 300 }) // 拖拽直接写渲染器，绕过驱动的边界检查
    driver.resume('pointer')

    clock.advance(30)
    expect(getPos().y).toBe(768)
  })
})
