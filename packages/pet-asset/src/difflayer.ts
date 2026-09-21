/**
 * difflayer — 用差分把「表情层」从出图里取出来
 *
 * 设计依据：docs/plans/客户端UI/2026-09-21-宠物精灵图生成线优化实施计划.md §三
 *
 * ## 要解决的问题
 *
 * P0-b 选的是「方案 C：只把面部拆成图层」（见设计 §5.2）。但要**生成**一个这样的模型，
 * 身体帧与面部帧来自**两次不同的出图**，把眼睛贴回身体画布上得知道它该贴在哪。
 * SKILL.md 原来的做法是让模型出「头部特写」，那更是另一套取景——位置只能靠人估。
 *
 * ## 做法
 *
 * 让表情批出**同机位全身、除眼睛外完全一致**的图集（把身体批的基准帧当参考图，
 * 靠「参考图会压过文字提示」这条实测性质把机位压住——那条性质在链式生成里是缺陷，
 * 在这里恰好是我们要的），然后**逐格与基准帧做像素差**：
 *
 * - 差异区域就是眼睛。**不需要知道眼睛在哪、不需要估位置，自对齐。**
 * - 差异**铺满整格** ⇒ 机位没压住，对齐失败——这就是判据（`bboxAreaRatio`）。
 *
 * ## 与 `normalize` 的分工
 *
 * 差分必须在**同一坐标空间**里做，所以调用方要先把基准帧与表情帧都过一遍
 * `cutout → slice → normalize`（同一 canvas / anchor），再来调这里。
 * 这里只做「两张同尺寸 RGBA 相减」这一件事。
 */

import type { BBox } from './cutout.js'

/** 判「这个像素变了」的通道差阈值（0–255） */
export const DIFF_THRESHOLD = 32

/**
 * 差异区域的**包围盒面积占整图比例**的上限。
 *
 * 眼睛在一个 144×168 的桌宠画布上占不到 10%。差异一旦铺到大半个画布，
 * 说明两次出图的机位/体型没对齐——这时切出来的「眼睛层」其实是一整只猫，
 * 叠到身体上会把身体盖掉。**这条是差分取层能不能成立的判据**。
 */
export const MAX_DIFF_AREA_RATIO = 0.5

export interface DiffLayerOptions {
  /** 通道差阈值，默认 `DIFF_THRESHOLD` */
  threshold?: number
  /** 差异区域向外扩张的像素数（留一圈，免得把抗锯齿边切掉），默认 2 */
  dilate?: number
}

export interface DiffLayerResult {
  /** 抠出来的图层（RGBA，同尺寸）：差异区域内是表情图的像素，其余全透明 */
  data: Buffer
  /** 差异区域的包围盒（未扩张）；全无差异时为 null */
  bbox: BBox | null
  /** 发生过变化的像素数 */
  changed: number
  /** 变化像素占整图比例 */
  changedRatio: number
  /** 包围盒面积占整图比例；`null` 表示无差异 */
  bboxAreaRatio: number | null
  /** 包围盒内变化像素的密度（越高越说明差异是「一块」而不是「散落全身」） */
  density: number
  /** 判据：差异是否足够集中、可以当作一个图层 */
  usable: boolean
}

/**
 * 把「表情帧相对基准帧的变化」抠成一个图层。
 *
 * @param frame 表情帧（RGBA，与 base 同尺寸）
 * @param base  基准帧（RGBA，同一坐标空间）
 */
export function extractDiffLayer(
  frame: Buffer,
  base: Buffer,
  width: number,
  height: number,
  options: DiffLayerOptions = {},
): DiffLayerResult {
  const threshold = options.threshold ?? DIFF_THRESHOLD
  const dilate = Math.max(0, options.dilate ?? 2)
  const n = width * height
  if (frame.length < n * 4 || base.length < n * 4) {
    throw new Error(
      `差分输入尺寸不符：期望 ${n * 4} 字节（${width}×${height} RGBA），` +
        `实际 frame=${frame.length} base=${base.length}`,
    )
  }

  const changedMask = new Uint8Array(n)
  let changed = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let i = 0; i < n; i++) {
    const p = i * 4
    const d = Math.max(
      Math.abs(frame[p]! - base[p]!),
      Math.abs(frame[p + 1]! - base[p + 1]!),
      Math.abs(frame[p + 2]! - base[p + 2]!),
    )
    // 只比 RGB：alpha 在抠底后本来就两边都是 0（背景），比它没有信息量
    if (d <= threshold) continue
    changedMask[i] = 1
    changed++
    const x = i % width
    const y = (i - x) / width
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  if (changed === 0) {
    return {
      data: Buffer.alloc(n * 4),
      bbox: null,
      changed: 0,
      changedRatio: 0,
      bboxAreaRatio: null,
      density: 0,
      usable: false,
    }
  }

  const bbox: BBox = { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 }
  const bboxAreaRatio = (bbox.w * bbox.h) / n
  const density = changed / (bbox.w * bbox.h)

  /*
   * 扩张**掩膜**，不是包围盒矩形。
   *
   * 按矩形输出会把基准帧的整块头一并写成不透明——身体播到别的帧（`Idle` 有四帧）时，
   * 那块区域就会「冻」在基准帧的样子上，看起来像头被贴了一张图。
   * 只把变化区域的邻域写出去，才既盖住基准帧眼睛的抗锯齿边、又不多占一个像素。
   */
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!changedMask[i]) continue
    const x = i % width
    const y = (i - x) / width
    const xa = Math.max(0, x - dilate)
    const xb = Math.min(width - 1, x + dilate)
    const ya = Math.max(0, y - dilate)
    const yb = Math.min(height - 1, y + dilate)
    for (let yy = ya; yy <= yb; yy++) {
      for (let xx = xa; xx <= xb; xx++) mask[yy * width + xx] = 1
    }
  }

  const data = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    const p = i * 4
    data[p] = frame[p]!
    data[p + 1] = frame[p + 1]!
    data[p + 2] = frame[p + 2]!
    data[p + 3] = 255
  }

  return {
    data,
    bbox,
    changed,
    changedRatio: changed / n,
    bboxAreaRatio,
    density,
    usable: bboxAreaRatio <= MAX_DIFF_AREA_RATIO,
  }
}
