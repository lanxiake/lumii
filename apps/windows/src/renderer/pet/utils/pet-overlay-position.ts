/**
 * pet-overlay-position — 气泡 / 头顶符号贴着宠物时的定位（含**边界翻转与夹紧**）
 *
 * ## 为什么需要它
 *
 * 气泡与头顶符号原先一律放在"宠物头顶上方"。宠物走到**屏幕顶部或两侧**时
 * （用户实测：「思考和会话气泡还是显示在顶部，我看不到」），头顶上方就是屏幕外——
 * 一个字也读不到。
 *
 * ## 与 `selection/floating-position.ts` 的关系
 *
 * 那边是划词浮条的翻转（全仓第一次实现）。本模块是同一套思路在宠物场景的变体，
 * 两处不同：
 *
 * 1. 锚点不是矩形，而是"脚底中心 + 头顶高度"（宠物的锚点语义见
 *    `renderer/types.ts` 的 `getPosition`：**脚底中心**）。
 * 2. 多一个**尾巴要对准宠物**的约束 —— 夹紧之后气泡不再居中于宠物，尾巴若还钉在
 *    `left: 50%` 就指向空气了。
 *
 * 纯函数：不读 `window`，视口由调用方传入，测试不依赖 jsdom 的窗口尺寸。
 */

/** 浮层与视口边缘的最小留白 */
export const OVERLAY_VIEWPORT_PAD = 8
/** 浮层与宠物之间的间距（气泡的尾巴就画在这段里） */
export const OVERLAY_GAP = 8
/** 尾巴尖端离气泡圆角的最小距离 —— 再往外就压到圆角上了 */
const TAIL_MARGIN = 18

export interface PetOverlayAnchor {
  /** 脚底中心 X */
  readonly x: number
  /** 脚底 Y */
  readonly y: number
  /** 宠物身高，用来近似"内容向上伸出多少" */
  readonly petHeight: number
  /**
   * 内容**实测**向上伸出多少（`renderer.getContentExtents()?.top`）。
   *
   * 有它就用它：姿势一换（站着 / 趴着 / 倒挂）身高差很多，用 `petHeight` 近似会让
   * 气泡贴着或嵌进宠物脑袋。缺省时（Live2D 后端没实现 `getContentExtents`）退回
   * `petHeight`。
   */
  readonly contentTop?: number
}

export interface PetOverlaySize {
  readonly width: number
  readonly height: number
}

export interface PetOverlayViewport {
  readonly width: number
  readonly height: number
}

export interface PetOverlayPlacement {
  readonly left: number
  readonly top: number
  /** 实际落在哪一侧 —— `below` 意味着发生了翻转，尾巴要画在气泡**顶边** */
  readonly placement: 'above' | 'below'
  /** 尾巴尖端相对**气泡左边缘**的偏移（夹紧后不再等于宽度的一半） */
  readonly tailX: number
}

/**
 * 夹紧。视口比浮层还小时上下界会倒挂，此时钉在起始边 ——
 * 至少让浮层的左上角可见，而不是把它整个推出视口。
 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * 算出浮层该落在哪。
 *
 * 规则：先试"头顶上方"；上方放不下就翻到脚下；两侧都放不下时取空间更大的一侧，
 * 接受溢出，最后由夹紧兜底。水平方向永远夹在视口内，尾巴跟着偏移以继续指向宠物。
 */
export function placePetOverlay(
  anchor: PetOverlayAnchor,
  size: PetOverlaySize,
  viewport: PetOverlayViewport,
): PetOverlayPlacement {
  const headY = anchor.y - (anchor.contentTop ?? anchor.petHeight)
  const need = size.height + OVERLAY_GAP
  const spaceAbove = headY - OVERLAY_VIEWPORT_PAD
  const spaceBelow = viewport.height - anchor.y - OVERLAY_VIEWPORT_PAD

  let placement: 'above' | 'below' = 'above'
  if (spaceAbove < need) {
    // 上方放不下：下方够就翻过去；两边都不够时取更大的那侧
    placement = spaceBelow >= need || spaceBelow > spaceAbove ? 'below' : 'above'
  }

  const rawTop = placement === 'above' ? headY - size.height - OVERLAY_GAP : anchor.y + OVERLAY_GAP
  const top = clamp(
    rawTop,
    OVERLAY_VIEWPORT_PAD,
    viewport.height - size.height - OVERLAY_VIEWPORT_PAD,
  )
  const left = clamp(
    anchor.x - size.width / 2,
    OVERLAY_VIEWPORT_PAD,
    viewport.width - size.width - OVERLAY_VIEWPORT_PAD,
  )
  const tailX = clamp(
    anchor.x - left,
    TAIL_MARGIN,
    Math.max(TAIL_MARGIN, size.width - TAIL_MARGIN),
  )

  return { left, top, placement, tailX }
}
