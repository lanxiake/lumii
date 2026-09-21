import { describe, it, expect } from 'vitest'
import {
  PERCH_DEFAULTS,
  ceilingY,
  shouldLetGo,
  stepClimb,
  stepCrawl,
  tryAttach,
  wallX,
  type PerchRect,
} from './perch.js'

/** 一个居中的窗口：x 200..800，y 100..700（宠物窗口坐标，y 向下） */
const RECT: PerchRect = { x: 200, y: 100, width: 600, height: 600 }
/** 地面线在 1352（与真机一致的两屏比例） */
const GROUND = 1352

describe('tryAttach — 该不该吸上去', () => {
  it('走到窗口左边缘附近就吸左墙', () => {
    expect(tryAttach(200, GROUND, RECT)).toBe('left')
    expect(tryAttach(210, GROUND, RECT)).toBe('left') // 24px 判定区内
  })

  it('走到右边缘附近就吸右墙', () => {
    expect(tryAttach(800, GROUND, RECT)).toBe('right')
    expect(tryAttach(790, GROUND, RECT)).toBe('right')
  })

  it('离得远不吸（否则像被吸尘器拽走）', () => {
    expect(tryAttach(500, GROUND, RECT)).toBeNull()
  })

  it('判定区边界：正好等于 attachDistance 算吸附', () => {
    const d = PERCH_DEFAULTS.attachDistance
    expect(tryAttach(RECT.x - d, GROUND, RECT)).toBe('left')
    expect(tryAttach(RECT.x - d - 1, GROUND, RECT)).toBeNull()
  })

  it('窗口在宠物上方才算——宠物在窗口内部走时没有边可爬', () => {
    // 窗口底边 1300，宠物 1352 → 在下方，可吸
    expect(tryAttach(200, GROUND, RECT)).toBe('left')
    // 窗口底边拖到 1400（盖住了宠物所在的 y）→ 不吸
    const covering: PerchRect = { ...RECT, y: 800, height: 600 }
    expect(tryAttach(200, GROUND, covering)).toBeNull()
  })

  it('窗口太扁不吸——爬上去立刻到顶，没有意义', () => {
    expect(tryAttach(200, GROUND, { ...RECT, height: 60 })).toBeNull()
  })

  it('没有目标（null）时不吸', () => {
    expect(tryAttach(200, GROUND, null)).toBeNull()
  })

  it('宽度为 0 的退化窗口不吸', () => {
    expect(tryAttach(200, GROUND, { ...RECT, width: 0 })).toBeNull()
  })

  it('两侧都在判定区内时取更近的那侧', () => {
    // 极窄窗口：两边距离分别在 24 内
    const narrow: PerchRect = { x: 200, y: 100, width: 10, height: 600 }
    expect(tryAttach(200, GROUND, narrow)).toBe('left') // 离左 0、离右 10
    expect(tryAttach(210, GROUND, narrow)).toBe('right') // 离左 10、离右 0
  })
})

describe('wallX / ceilingY — 缝隙方向', () => {
  it('左墙的锚点在墙的**外侧**（左边）', () => {
    const x = wallX(RECT, 'left', PERCH_DEFAULTS, 128)
    expect(x).toBeLessThan(RECT.x)
  })

  it('右墙的锚点在墙的外侧（右边）', () => {
    const x = wallX(RECT, 'right', PERCH_DEFAULTS, 128)
    expect(x).toBeGreaterThan(RECT.x + RECT.width)
  })

  it('缝隙按模型高度成比例，不是固定像素', () => {
    const small = wallX(RECT, 'left', PERCH_DEFAULTS, 64)
    const big = wallX(RECT, 'left', PERCH_DEFAULTS, 128)
    expect(RECT.x - big).toBeCloseTo((RECT.x - small) * 2, 6)
  })

  it('模型高度为 0 时贴边（不产生负缝隙）', () => {
    expect(wallX(RECT, 'left', PERCH_DEFAULTS, 0)).toBe(RECT.x)
  })

  it('天花板在窗口上边缘之上', () => {
    expect(ceilingY(RECT, PERCH_DEFAULTS, 128)).toBeLessThan(RECT.y)
  })
})

describe('stepClimb — 沿墙向上', () => {
  it('按速度向上（y 减小）', () => {
    const r = stepClimb(1000, RECT, 1, PERCH_DEFAULTS, 128)
    expect(r.y).toBeCloseTo(1000 - PERCH_DEFAULTS.climbSpeed, 6)
    expect(r.reachedTop).toBe(false)
  })

  it('爬到顶就停在天花板线上，不越过头顶', () => {
    const top = ceilingY(RECT, PERCH_DEFAULTS, 128)
    const r = stepClimb(top + 1, RECT, 1, PERCH_DEFAULTS, 128)
    expect(r.y).toBe(top)
    expect(r.reachedTop).toBe(true)
  })

  it('dt 为 0 或负数时原地不动', () => {
    expect(stepClimb(1000, RECT, 0, PERCH_DEFAULTS, 128).y).toBe(1000)
    expect(stepClimb(1000, RECT, -5, PERCH_DEFAULTS, 128).y).toBe(1000)
  })

  it('爬速比走路慢（60px/s），否则显得轻飘', () => {
    expect(PERCH_DEFAULTS.climbSpeed).toBeLessThan(60)
  })
})

describe('stepCrawl — 沿窗口上边缘', () => {
  it('从左墙上来的向右爬', () => {
    const r = stepCrawl(200, RECT, 'left', 1, PERCH_DEFAULTS)
    expect(r.x).toBeCloseTo(200 + PERCH_DEFAULTS.climbSpeed, 6)
    expect(r.reachedEnd).toBe(false)
  })

  it('从右墙上来的向左爬', () => {
    const r = stepCrawl(800, RECT, 'right', 1, PERCH_DEFAULTS)
    expect(r.x).toBeCloseTo(800 - PERCH_DEFAULTS.climbSpeed, 6)
  })

  it('爬到另一角就掉下来（不折返）', () => {
    const r = stepCrawl(RECT.x + RECT.width - 1, RECT, 'left', 1, PERCH_DEFAULTS)
    expect(r.x).toBe(RECT.x + RECT.width)
    expect(r.reachedEnd).toBe(true)
  })

  it('右侧同理', () => {
    const r = stepCrawl(RECT.x + 1, RECT, 'right', 1, PERCH_DEFAULTS)
    expect(r.x).toBe(RECT.x)
    expect(r.reachedEnd).toBe(true)
  })
})

describe('shouldLetGo — 什么时候松手', () => {
  const wall = { kind: 'wall', side: 'left' } as const
  const ceiling = { kind: 'ceiling', side: 'left' } as const

  it('目标消失（窗口关了/隐藏了）就松手', () => {
    expect(shouldLetGo(wall, null, 200, 500)).toBe(true)
    expect(shouldLetGo(ceiling, null, 400, 90)).toBe(true)
  })

  it('窗口被拖走、墙面不在脚下时松手', () => {
    const moved: PerchRect = { ...RECT, x: 1500 }
    expect(shouldLetGo(wall, moved, 200, 500)).toBe(true)
  })

  it('窗口被拖走时墙上的宠物也可能只是偏移了一点——那不算松手', () => {
    const nudged: PerchRect = { ...RECT, x: RECT.x + 5 }
    expect(shouldLetGo(wall, nudged, wallX(RECT, 'left', PERCH_DEFAULTS, 128) + 5, 500)).toBe(false)
  })

  it('窗口变得太矮就松手', () => {
    expect(shouldLetGo(wall, { ...RECT, height: 50 }, 200, 500)).toBe(true)
  })

  it('没有攀附时不松手（无事发生）', () => {
    expect(shouldLetGo(null, null, 0, 0)).toBe(false)
  })
})
