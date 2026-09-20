/**
 * align — 按共同地线对齐一组帧（pet-asset）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §3.2 / §7
 *
 * 为什么必须要有这一步：直出图集的**角色一致性**由单次生成天然保证（实测调色板重合 93.3%），
 * 但**取景与尺度不统一**——每格里角色的大小与站位都是模型自由发挥的。不逐格对齐就直接拼图集，
 * 角色会逐帧上下跳、左右飘。
 *
 * 对齐基准取 **alpha 包围盒的底边**（地线）：角色站在地面上，脚底才是稳定参照。
 * 用包围盒中心对齐会让「抬手」的帧整体下沉、'跳跃' 的帧整体上浮，看起来像在抽搐。
 *
 * P-1 验证点 A3 用同一套做法实测对齐误差 0px。
 */

import { alphaBBox, type BBox } from './cutout.js'

/** 一帧的原始像素 */
export interface AlignFrame {
  name: string
  data: Buffer
  width: number
  height: number
}

export type AlignBaseline = 'bottom' | 'top' | 'center'

export interface AlignOptions {
  /** 垂直对齐基准；默认 bottom（地线） */
  baseline?: AlignBaseline
  /** 水平对齐依据：'center'（默认，按包围盒水平中心）| 'none' */
  horizontal?: 'center' | 'none'
  /** alpha 阈值，低于它视为透明 */
  threshold?: number
}

/** 一帧对齐后的落位：把整张图放到 (x, y) */
export interface AlignPlacement {
  name: string
  /** 原图左上角在公共画布中的位置 */
  x: number
  y: number
  width: number
  height: number
  /** 该帧自身的 alpha 包围盒；全透明帧为 null */
  bbox: BBox | null
}

export interface AlignResult {
  /** 公共画布尺寸（能装下所有帧） */
  canvas: { w: number; h: number }
  placements: AlignPlacement[]
  /** 参与了地线计算的帧数（全透明帧不参与） */
  alignedCount: number
}

/**
 * 计算对齐落位（纯函数）。
 *
 * **全透明的帧不参与基准计算**：它们的包围盒为空，若把它们算进"最大底边"，
 * 一个坏格子就能把所有帧整体顶偏。它们仍会被放（摆在画布左上），只是不影响基准。
 */
export function computeAlignPlacements(
  frames: readonly AlignFrame[],
  options: AlignOptions = {},
): AlignResult {
  const baseline = options.baseline ?? 'bottom'
  const horizontal = options.horizontal ?? 'center'
  const threshold = options.threshold ?? 16

  const withBox = frames.map((f) => ({ frame: f, bbox: alphaBBox(f.data, f.width, f.height, threshold) }))
  const usable = withBox.filter((x) => x.bbox !== null)

  // 基准：所有有效帧里最靠下的底边 / 最靠上的顶边 / 最高的中心。
  //
  // **基准本身不取整**，只在算每个帧的位移时取整。若先把基准 round 掉，
  // 一组中心一致（同为 x.5）的帧会各自位移 1px，画布平白宽 1 像素——
  // 实测拿 48 格的图集跑出来就是 49 宽。
  let baseY = 0
  let baseCenterX = 0
  if (usable.length > 0) {
    if (baseline === 'bottom') {
      baseY = Math.max(...usable.map((x) => x.bbox!.maxY))
    } else if (baseline === 'top') {
      baseY = Math.min(...usable.map((x) => x.bbox!.minY))
    } else {
      baseY = usable.reduce((a, x) => a + (x.bbox!.minY + x.bbox!.maxY) / 2, 0) / usable.length
    }
    baseCenterX =
      usable.reduce((a, x) => a + (x.bbox!.minX + x.bbox!.maxX) / 2, 0) / usable.length
  }

  // 落位：直接解「包围盒该落在画布上的哪」，再反推整张图左上角的位置。
  //
  // 注意**不能**写成 `p.y = bbox.minY + dy`（dy = baseY − bbox.maxY）——那等于把
  // 算出来的位移又抵消掉，四个帧会原样叠放、对齐完全没生效。实测被单测抓过一次。
  // 正确关系：画布上的包围盒底边 = p.y + bbox.maxY，令它等于 baseY 即得下式。
  const placements: AlignPlacement[] = withBox.map(({ frame, bbox }) => {
    if (!bbox) return { name: frame.name, x: 0, y: 0, width: frame.width, height: frame.height, bbox: null }

    const centerX = (bbox.minX + bbox.maxX) / 2
    const x = horizontal === 'center' ? Math.round(baseCenterX - centerX) : 0

    let y: number
    if (baseline === 'bottom') y = baseY - bbox.maxY
    else if (baseline === 'top') y = baseY - bbox.minY
    else y = Math.round(baseY - (bbox.minY + bbox.maxY) / 2)

    return {
      name: frame.name,
      x,
      y,
      width: frame.width,
      height: frame.height,
      bbox,
    }
  })

  // 公共画布：所有落位后的实际占用范围（可能为负，统一平移到 0 起）
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  for (const p of placements) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + p.width)
    maxY = Math.max(maxY, p.y + p.height)
  }
  const shiftX = -minX
  const shiftY = -minY
  for (const p of placements) {
    p.x += shiftX
    p.y += shiftY
  }

  return {
    canvas: { w: maxX - minX, h: maxY - minY },
    placements,
    alignedCount: usable.length,
  }
}
