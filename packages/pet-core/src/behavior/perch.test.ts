import { describe, it, expect } from 'vitest'
import {
  PERCH_DEFAULTS,
  ceilingY,
  clampToViewport,
  screenWallX,
  shouldLetGo,
  stepClimb,
  stepCrawl,
  tryAttach,
  tryAttachScreen,
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

  it('天花板锚点在窗口上沿**之下**——宠物是倒挂的', () => {
    // 这里原本断言 `toBeLessThan(RECT.y)`，把"宠物贴在上沿之上"当成了正确行为。
    // 素材的 CRAWL 行在切图时已垂直翻转成"内容贴帧底"，锚点即内容底边，
    // 自然落在上沿**下方**；按旧假设摆的话宠物会飘到窗口外面去
    // （实测抓到过 `松手（爬到尽头）@(1980, 208)`，而上沿是 250）。
    const y = ceilingY(RECT, PERCH_DEFAULTS, 128)
    expect(y).toBeGreaterThan(RECT.y)
    expect(y - RECT.y).toBeCloseTo(128 * PERCH_DEFAULTS.ceilingGapRatio, 6)
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

describe('屏幕边缘 — 宠物在视口**内侧**贴边', () => {
  const VP = { width: 2560, height: 1400 }

  it('走到左边缘就吸上去', () => {
    expect(tryAttachScreen(10, GROUND, VP)).toBe('left')
  })

  it('走到右边缘就吸上去', () => {
    expect(tryAttachScreen(VP.width - 10, GROUND, VP)).toBe('right')
  })

  it('在屏幕中间不吸', () => {
    expect(tryAttachScreen(1280, GROUND, VP)).toBeNull()
  })

  it('**不必**贴到屏幕边：走到墙线附近就吸（自主走动够不到边缘）', () => {
    // 实测事故（2026-09-22）：走路的可达下限是 `walkBoundsOf` 的 `anchorX × scale`
    // （那只猫 114px——它要保证**内容**不出屏），而判定原先要 `petX ≤ 24`。
    // 两个区间**没有交集**，于是宠物自己永远走不到吸附区，只有拖拽与"从天花板掉下来"
    // （掉落不受走路边界约束）才吸得上。用户的原话是「可以在屏幕边缘运行」。
    const modelHeight = 281.6 // 128 画布 × 2.2 缩放
    const line = screenWallX(VP, 'left', PERCH_DEFAULTS, modelHeight) // ≈ 121
    expect(tryAttachScreen(line + 19, GROUND, VP, PERCH_DEFAULTS, 120, modelHeight)).toBe('left')
    // 再远一点就不该吸——判据仍然有界，不是"只要靠左就吸"
    expect(tryAttachScreen(line + 40, GROUND, VP, PERCH_DEFAULTS, 120, modelHeight)).toBeNull()
  })

  it('拖到屏幕边上照样吸——离墙线那条**没有**取代离边缘那条', () => {
    const modelHeight = 281.6
    // x=10 离墙线 111px，远超 attachDistance；全靠"离屏幕边"这条
    expect(tryAttachScreen(10, GROUND, VP, PERCH_DEFAULTS, 120, modelHeight)).toBe('left')
    expect(tryAttachScreen(VP.width - 10, GROUND, VP, PERCH_DEFAULTS, 120, modelHeight)).toBe(
      'right',
    )
  })

  it('右侧同理：走到可达上限就吸', () => {
    const modelHeight = 281.6
    const line = screenWallX(VP, 'right', PERCH_DEFAULTS, modelHeight) // ≈ 2439
    expect(tryAttachScreen(line - 19, GROUND, VP, PERCH_DEFAULTS, 120, modelHeight)).toBe('right')
  })

  it('省略 modelHeight 时墙线退化为屏幕边缘本身（与旧行为一致）', () => {
    expect(tryAttachScreen(10, GROUND, VP)).toBe('left')
    expect(tryAttachScreen(100, GROUND, VP)).toBeNull()
  })

  it('锚点落在**内侧**——与窗口那条公式方向相反', () => {
    // 窗口：宠物在窗口外侧，锚点往边外挪（∓）
    // 屏幕：宠物在屏幕内侧，锚点往边里挪（±）—— 搞反了宠物会跑到屏幕外
    const gap = 128 * PERCH_DEFAULTS.wallGapRatio
    expect(screenWallX(VP, 'left', PERCH_DEFAULTS, 128)).toBeCloseTo(gap, 6)
    expect(screenWallX(VP, 'right', PERCH_DEFAULTS, 128)).toBeCloseTo(VP.width - gap, 6)
  })

  it('视口太矮时没有天花板可爬', () => {
    expect(tryAttachScreen(10, 100, { width: 2560, height: 50 })).toBeNull()
  })

  it('纵向在视口外时不判（拖拽途中的中间态）', () => {
    expect(tryAttachScreen(10, -500, VP)).toBeNull()
  })
})

describe('clampToViewport — 主窗口贴着屏幕边时把宠物夹回来', () => {
  const VP = { width: 2560, height: 1400 }

  it('贴左缘的窗口算出负锚点时夹到 0', () => {
    // 窗口 x=0 时 wallX 给 -108，不夹的话宠物爬到看不见的地方去
    expect(clampToViewport(-108, 500, VP).x).toBe(0)
  })

  it('右缘同理', () => {
    expect(clampToViewport(9999, 500, VP).x).toBe(VP.width)
  })

  it('已经在视口内时原样返回', () => {
    expect(clampToViewport(500, 300, VP)).toEqual({ x: 500, y: 300 })
  })
})
