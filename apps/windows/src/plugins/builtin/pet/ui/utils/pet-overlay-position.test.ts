/**
 * pet-overlay-position 的单测。
 *
 * 判据围绕用户实测报的那一条：「宠物在屏幕两边和屏幕顶部的时候……
 * 思考和会话气泡还是显示在顶部，我看不到」。所以每个边缘都要有一条。
 */
import { describe, it, expect } from 'vitest'
import {
  placePetOverlay,
  OVERLAY_GAP,
  OVERLAY_VIEWPORT_PAD,
  type PetOverlayAnchor,
  type PetOverlaySize,
  type PetOverlayViewport,
} from './pet-overlay-position'

const VIEWPORT: PetOverlayViewport = { width: 1920, height: 1080 }
const BUBBLE: PetOverlaySize = { width: 320, height: 80 }
/** 平地（脚踩屏幕底、身高 200）——最普通的情形 */
const GROUND: PetOverlayAnchor = { x: 960, y: 1000, petHeight: 200 }

describe('placePetOverlay — 正常情形', () => {
  it('平地：落在头顶上方，水平居中，尾巴在正中', () => {
    const p = placePetOverlay(GROUND, BUBBLE, VIEWPORT)
    expect(p.placement).toBe('above')
    expect(p.top).toBe(1000 - 200 - BUBBLE.height - OVERLAY_GAP)
    expect(p.left).toBe(960 - BUBBLE.width / 2)
    expect(p.tailX).toBe(BUBBLE.width / 2)
  })

  it('contentTop 优先于 petHeight（姿势换了身高，气泡不该嵌进脑袋）', () => {
    const laying: PetOverlayAnchor = { ...GROUND, contentTop: 120 }
    const p = placePetOverlay(laying, BUBBLE, VIEWPORT)
    // 头顶算在 1000-120=880，而不是 1000-200=800
    expect(p.top).toBe(880 - BUBBLE.height - OVERLAY_GAP)
  })
})

describe('placePetOverlay — 屏幕顶部：必须翻到脚下', () => {
  it('爬天花板（y≈0）时翻到下方，且落在视口内', () => {
    const p = placePetOverlay({ x: 960, y: 60, petHeight: 200 }, BUBBLE, VIEWPORT)
    expect(p.placement).toBe('below')
    expect(p.top).toBe(60 + OVERLAY_GAP)
    expect(p.top).toBeGreaterThanOrEqual(OVERLAY_VIEWPORT_PAD)
  })

  it('倒挂在天花板上（内容上伸量为负的姿势）同样翻到下方', () => {
    const p = placePetOverlay({ x: 960, y: 40, petHeight: 200, contentTop: -20 }, BUBBLE, VIEWPORT)
    expect(p.placement).toBe('below')
  })

  it('刚好放得下时不翻（阈值边界）', () => {
    // 头顶在 y=96，上方空间 96-8=88 = need(80+8) —— 正好够
    const p = placePetOverlay({ x: 960, y: 296, petHeight: 200 }, BUBBLE, VIEWPORT)
    expect(p.placement).toBe('above')
    expect(p.top).toBe(OVERLAY_VIEWPORT_PAD)
  })
})

describe('placePetOverlay — 屏幕两侧：夹紧 + 尾巴跟着挪', () => {
  it('贴左墙：气泡夹在视口内，尾巴右移仍指向宠物', () => {
    const p = placePetOverlay({ x: 30, y: 1000, petHeight: 200 }, BUBBLE, VIEWPORT)
    expect(p.left).toBe(OVERLAY_VIEWPORT_PAD)
    expect(p.tailX).toBe(30 - OVERLAY_VIEWPORT_PAD)
    expect(p.tailX).toBeLessThan(BUBBLE.width / 2)
    expect(p.tailX).toBeGreaterThanOrEqual(18)
  })

  it('贴右墙：气泡夹在视口内，尾巴左移仍指向宠物', () => {
    const p = placePetOverlay({ x: 1900, y: 1000, petHeight: 200 }, BUBBLE, VIEWPORT)
    expect(p.left).toBe(VIEWPORT.width - BUBBLE.width - OVERLAY_VIEWPORT_PAD)
    expect(p.tailX).toBeGreaterThan(BUBBLE.width / 2)
    expect(p.tailX).toBeLessThanOrEqual(BUBBLE.width - 18)
  })

  it('角落（贴顶 + 贴左）同时触发翻转与夹紧', () => {
    const p = placePetOverlay({ x: 20, y: 50, petHeight: 200 }, BUBBLE, VIEWPORT)
    expect(p.placement).toBe('below')
    expect(p.left).toBe(OVERLAY_VIEWPORT_PAD)
    // 理想偏移是 20-8=12，但被 TAIL_MARGIN(18) 抬了一下——尾巴不能压到圆角上。
    // 代价是尾巴与宠物差 6px，比"尾巴戳出气泡外"轻得多。
    expect(p.tailX).toBe(18)
  })

  it('尾巴永远留在气泡内部（不会跑到圆角外面）', () => {
    for (const x of [0, 5, 30, 960, 1900, 1920]) {
      const p = placePetOverlay({ x, y: 1000, petHeight: 200 }, BUBBLE, VIEWPORT)
      expect(p.tailX).toBeGreaterThanOrEqual(18)
      expect(p.tailX).toBeLessThanOrEqual(BUBBLE.width - 18)
    }
  })
})

describe('placePetOverlay — 退无可退时不崩', () => {
  it('两侧都放不下时取空间更大的一侧', () => {
    const tall: PetOverlaySize = { width: 320, height: 292 }
    // 头顶 250（上方 242）、脚下到屏幕底 42 —— 都不够，上方更大
    const p = placePetOverlay({ x: 960, y: 450, petHeight: 200 }, tall, {
      width: 1920,
      height: 500,
    })
    expect(p.placement).toBe('above')
  })

  it('视口比浮层还小时钉在起始边，而不是被推到屏幕外', () => {
    // 视口比气泡本身还矮（60 < 80）→ 上界倒挂 → 钉在下界
    const p = placePetOverlay(GROUND, BUBBLE, { width: 200, height: 60 })
    expect(p.left).toBe(OVERLAY_VIEWPORT_PAD)
    expect(p.top).toBe(OVERLAY_VIEWPORT_PAD)
    expect(Number.isFinite(p.tailX)).toBe(true)
  })

  it('极端锚点（宠物被拖出屏幕，实测到过 y=-21589）不产出 NaN', () => {
    const p = placePetOverlay({ x: -500, y: -21589, petHeight: 200 }, BUBBLE, VIEWPORT)
    expect(Number.isFinite(p.left)).toBe(true)
    expect(Number.isFinite(p.top)).toBe(true)
    expect(Number.isFinite(p.tailX)).toBe(true)
    expect(p.left).toBeGreaterThanOrEqual(OVERLAY_VIEWPORT_PAD)
    expect(p.top).toBeGreaterThanOrEqual(OVERLAY_VIEWPORT_PAD)
  })
})
