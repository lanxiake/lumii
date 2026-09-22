/**
 * floating-position.ts - 浮动层定位（含边界翻转）
 *
 * 全仓此前只有「夹紧」没有「翻转」（Tooltip / ContextMenu 都是），浮条在视口
 * 底部必须翻到选区上方，所以单独抽一个纯函数出来：不读 window，视口由调用方传入，
 * 测试可以不依赖 jsdom 的窗口尺寸。
 */

import type { SnapshotRect } from './snapshot'

export type FloatingPlacement = 'top' | 'bottom'

/** 锚点与浮层之间的间距；与 Tooltip 的 GAP 保持一致 */
export const GAP = 8
/** 浮层与视口边缘的最小留白；与 Tooltip 的 VIEWPORT_PAD 保持一致 */
export const VIEWPORT_PAD = 8

export interface FloatingSize {
  readonly width: number
  readonly height: number
}

export interface FloatingViewport {
  readonly width: number
  readonly height: number
}

export interface FloatingPosition {
  readonly top: number
  readonly left: number
  /** 实际落在哪一侧；与调用方传的 preferred 不同即发生了翻转 */
  readonly placement: FloatingPlacement
}

/**
 * 夹紧。视口比浮层还小时上下界会倒挂，此时钉在起始边 ——
 * 至少让浮层的左边/上边可见，而不是把它整个推出视口。
 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * 算出浮层应落的位置。锚点用「末行矩形」（快照的 anchorRect）而不是联合框：
 * 多行选区的联合框上沿在第一行，浮条贴上去会离指针很远。
 *
 * 规则：先按 preferred 试，放不下就翻到对侧；两侧都放不下时取空间更大的一侧，
 * 接受溢出，最后由夹紧兜底。
 */
export function placeFloating(
  anchor: SnapshotRect,
  size: FloatingSize,
  preferred: FloatingPlacement,
  viewport: FloatingViewport,
): FloatingPosition {
  const spaceAbove = anchor.top - VIEWPORT_PAD
  const spaceBelow = viewport.height - (anchor.top + anchor.height) - VIEWPORT_PAD
  const need = size.height + GAP

  const fitsAbove = spaceAbove >= need
  const fitsBelow = spaceBelow >= need

  let placement: FloatingPlacement = preferred
  if (!fitsAbove && !fitsBelow) {
    // 两侧都放不下：取空间更大的一侧，溢出交给夹紧
    placement = spaceAbove >= spaceBelow ? 'top' : 'bottom'
  } else if (preferred === 'top' && !fitsAbove) {
    placement = 'bottom'
  } else if (preferred === 'bottom' && !fitsBelow) {
    placement = 'top'
  }

  const rawTop =
    placement === 'top' ? anchor.top - size.height - GAP : anchor.top + anchor.height + GAP

  return {
    top: clamp(rawTop, VIEWPORT_PAD, viewport.height - size.height - VIEWPORT_PAD),
    left: clamp(
      anchor.left + anchor.width / 2 - size.width / 2,
      VIEWPORT_PAD,
      viewport.width - size.width - VIEWPORT_PAD,
    ),
    placement,
  }
}
