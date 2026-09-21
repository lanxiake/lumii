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

// ---------------------------------------------------------------------------
// 归一化到目标画布
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /** 目标画布尺寸（清单里的 canvas） */
  canvas: { w: number; h: number }
  /** 锚点（通常是脚底中心），角色按它落位 */
  anchor: [number, number]
  /**
   * 像素画路线：重采样改用 `nearest`（整数倍降采样保住硬边）。
   *
   * 默认 false = `lanczos3`。**这条不是口味问题**：2D 高清路线是 3~4 倍降采样，
   * 用 `nearest` 等于只取十六分之一、其余全丢，描边立刻全是锯齿。
   */
  pixelArt?: boolean
  /** 角色高度占画布高度的比例；默认 0.94（留一点顶边余量） */
  fit?: number
  /**
   * 测包围盒用的 alpha 阈值；默认 **128**（半透明以上才算）。
   *
   * 比对齐用的 16 高得多，是实测逼出来的：真实 AI 出图抠底后会在角色周围留下一圈
   * 半透明残晕（alpha 十几到一百多），沿图像边缘尤其明显。用 16 去量，包围盒会一路
   * 贴到图片边界——倍率按这个"假的最高"算出来偏小，角色比预期小一圈，
   * 而且首尾帧容易在大画布上被裁。**角色的"边界"应该是肉眼可见的地方，不是 alpha=17 的雾。**
   */
  bboxThreshold?: number
}

export interface NormalizePlacement {
  name: string
  /** 该帧的缩放倍率 */
  scale: number
  /** 缩放后整张图左上角在画布上的落位（可能为负，由调用方裁剪） */
  x: number
  y: number
  /** 缩放后的图片尺寸 */
  width: number
  height: number
  /** 原图包围盒；全透明帧为 null */
  bbox: BBox | null
}

/**
 * 计算「归一化到目标画布」的落位与缩放（纯函数）。
 *
 * **为什么必须有这一步**：直出图集的每格是模型自由取景的（人物大小、站位都不一样），
 * 而清单声明的 `canvas` 是渲染时的坐标空间。不归一化就直接拼图集，会出现两个后果：
 * 一是角色在画布里的位置与锚点对不上（脚不沾地），二是画布尺寸与素材尺寸严重不符
 * （实测 128×128 的切片配上 48×56 的清单，桌面上会变成一大坨）。
 *
 * **同一组帧共用一个缩放倍率**，不是逐帧各自撑满：
 * 逐帧撑满会把「蹲下」的帧放大到和「站直」一样高，角色看起来像在抽搐。
 *
 * **「组」= 帧尺寸相同的一组**，也就是同一批出图切出来的那些格。这条是实测逼出来的：
 * `slice` 之后，一个物体在不同批次里占的像素数**取决于那一批的网格有多密**——
 * 实测同一只猫，单格批（1254 一格）里占 1191px 高，2×2 批（627 一格）里只占 532px，
 * 因为模型都是「把角色填满格子」，而格子小了一半。
 * 早先拿**全体帧里最高的那个包围盒**算一个全局倍率，于是 2×2 那批的角色只有
 * 单格批的 45% 大——切状态时宠物会突然缩小一半。
 * 按尺寸分组之后：同批的格一样大（组内等比例，不抽搐），各组各自归一到目标高度
 * （跨批次的网格差被吸收掉）。
 */
export function computeNormalize(
  frames: readonly AlignFrame[],
  options: NormalizeOptions,
): NormalizePlacement[] {
  const fit = options.fit ?? 0.94
  const bboxThreshold = options.bboxThreshold ?? 128
  const targetH = options.canvas.h * fit

  const boxes = frames.map((f) => alphaBBox(f.data, f.width, f.height, bboxThreshold))

  // 按帧尺寸分组；组内取最高的包围盒算一个共同倍率
  const tallestBySize = new Map<string, number>()
  frames.forEach((f, i) => {
    const b = boxes[i]
    if (!b) return
    const key = `${f.width}x${f.height}`
    tallestBySize.set(key, Math.max(tallestBySize.get(key) ?? 0, b.h))
  })
  const scaleOf = (f: AlignFrame): number => {
    const tallest = tallestBySize.get(`${f.width}x${f.height}`) ?? 0
    return tallest > 0 ? targetH / tallest : 1
  }

  return frames.map((f, i) => {
    const bbox = boxes[i]
    const scale = scaleOf(f)
    const width = Math.max(1, Math.round(f.width * scale))
    const height = Math.max(1, Math.round(f.height * scale))
    if (!bbox) return { name: f.name, scale, x: 0, y: height, width, height, bbox: null }

    // 包围盒缩放后的位置：底边落在 anchor.y，水平中心落在 anchor.x
    const bboxMinY = options.anchor[1] - bbox.h * scale
    const bboxMinX = options.anchor[0] - (bbox.w * scale) / 2
    return {
      name: f.name,
      scale,
      x: Math.round(bboxMinX - bbox.minX * scale),
      y: Math.round(bboxMinY - bbox.minY * scale),
      width,
      height,
      bbox,
    }
  })
}
