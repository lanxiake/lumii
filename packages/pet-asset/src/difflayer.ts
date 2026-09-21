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
 * 叠到身体上会把身体盖掉。
 */
export const MAX_DIFF_AREA_RATIO = 0.5

/**
 * 差异的**紧致度**下限——按连通域各算各的，再按面积加权平均。
 *
 * 不能拿「总像素 ÷ 整体包围盒面积」当密度：**两只眼睛天然分开**，
 * 中间那段空隙会把密度拉到 0.1 以下，于是一张抠得干干净净的表情图被判成「散落一圈」。
 * 实测就撞上了这个：`eye_shut` 的两个连通域各 21×20、紧致度 0.67，整体算却只有 0.47。
 * 各算各的之后，孤立噪点（细长、稀疏）与眼睛（成块）才分得开。
 */
export const MIN_DIFF_DENSITY = 0.3

/**
 * 连通域过滤的面积下限（占画布比例）。
 *
 * **这条是整套差分取层能不能用的关键。** 两次**独立**的生成不可能逐像素一致——
 * 抗锯齿不可复现，于是描边周围会散落几百个孤立的小差异点。实测一次真实的对照：
 * 959 个变化像素分成 **275 个连通域**，其中只有 **2 个**是有意义的（288px 与 277px、
 * 各 21×20、位于 x=37/76 同一高度——就是两只眼睛，紧致度 0.69），
 * 其余 273 个都 ≤18px，合计 352px 全是噪点。
 *
 * 不过滤的话包围盒会被噪点撑到 71% 画布、密度掉到 0.05，看着像「完全没对齐」，
 * 而实际上眼睛被抠得干干净净。
 *
 * 取**画布比例**而不是固定像素数：像素画布（48×56）上的眼睛只有 3×3=9 像素，
 * 固定 20 会把真信号一起滤掉。0.0008 在 144×168 上约为 19px、在 48×56 上约为 6px。
 */
export const MIN_COMPONENT_AREA_RATIO = 0.0008
/** 面积下限的绝对底线，免得小画布上比例算出 0 */
const MIN_COMPONENT_AREA_FLOOR = 6

/** 由画布尺寸算连通域面积下限 */
export function minComponentArea(pixels: number): number {
  return Math.max(MIN_COMPONENT_AREA_FLOOR, Math.round(pixels * MIN_COMPONENT_AREA_RATIO))
}

/**
 * 差分前搜索平移补偿的默认半径（像素）。
 *
 * `normalize` 是按**包围盒**对齐的（共同倍率 + 底边落锚点 + 水平居中），
 * 那是给渲染用的粗对齐：包围盒只要差一个像素，整条描边就会亮起来。
 * 差分要的是**像素级**对齐，所以在真正的比较之前先在这个半径内搜一遍最小差异的平移。
 * 7px 足够覆盖包围盒对齐的残差（实测残差约 1px），又不会大到把远处的另一只角色对上。
 */
export const DEFAULT_ALIGN_SEARCH = 7

export interface DiffLayerOptions {
  /** 通道差阈值，默认 `DIFF_THRESHOLD` */
  threshold?: number
  /** 差异区域向外扩张的像素数（留一圈，免得把抗锯齿边切掉），默认 2 */
  dilate?: number
  /** 平移补偿搜索半径，默认 `DEFAULT_ALIGN_SEARCH`；0 = 不搜索 */
  searchRadius?: number
  /** 连通域面积下限，默认按画布比例算（见 `minComponentArea`）；0 = 不过滤 */
  minComponentArea?: number
}

export interface DiffLayerResult {
  /** 抠出来的图层（RGBA，同尺寸）：差异区域内是表情图的像素，其余全透明 */
  data: Buffer
  /** 差异区域的包围盒（未扩张，已滤掉小连通域）；全无差异时为 null */
  bbox: BBox | null
  /** 过滤后剩下的变化像素数 */
  changed: number
  /** 过滤前原始的变化像素数（与 `changed` 之差就是被当成噪点丢掉的部分） */
  rawChanged: number
  /** 被连通域过滤丢掉的像素数 */
  droppedPixels: number
  /** 被丢掉的连通域个数 */
  droppedComponents: number
  /** 保留的连通域个数 */
  componentCount: number
  /** 变化像素占整图比例 */
  changedRatio: number
  /** 包围盒面积占整图比例；`null` 表示无差异 */
  bboxAreaRatio: number | null
  /** 包围盒内变化像素的密度 */
  density: number
  /** 补偿掉的平移：表情帧相对基准帧的偏移（像素） */
  offset: { dx: number; dy: number }
  /** 补偿前后各自的平均通道差，用来判断补偿是否真的起了作用 */
  meanDiffBefore: number
  meanDiffAfter: number
  /** 判据：差异是否足够集中、可以当作一个图层 */
  usable: boolean
}

/**
 * 按连通域面积过滤掩膜（原地改写 mask），返回保留/丢弃的统计。
 *
 * 4 连通：描边周围的抗锯齿噪点是孤立点或极短的细线，4 连通下一断就分成小域；
 * 眼睛是一整块，怎么连都还是一块。
 */
function filterSmallComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
): { kept: number; dropped: number; droppedCount: number; keptCount: number; keptBBoxArea: number } {
  const n = width * height
  const seen = new Uint8Array(n)
  const stack: number[] = []
  const component: number[] = []
  let kept = 0
  let dropped = 0
  let droppedCount = 0
  let keptCount = 0
  let keptBBoxArea = 0

  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue
    component.length = 0
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    while (stack.length > 0) {
      const i = stack.pop()!
      component.push(i)
      const x = i % width
      const y = (i - x) / width
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (x > 0 && mask[i - 1] && !seen[i - 1]) {
        seen[i - 1] = 1
        stack.push(i - 1)
      }
      if (x < width - 1 && mask[i + 1] && !seen[i + 1]) {
        seen[i + 1] = 1
        stack.push(i + 1)
      }
      if (i >= width && mask[i - width] && !seen[i - width]) {
        seen[i - width] = 1
        stack.push(i - width)
      }
      if (i < n - width && mask[i + width] && !seen[i + width]) {
        seen[i + width] = 1
        stack.push(i + width)
      }
    }
    if (component.length >= minArea) {
      kept += component.length
      keptBBoxArea += (maxX - minX + 1) * (maxY - minY + 1)
      keptCount++
    } else {
      for (const i of component) mask[i] = 0
      dropped += component.length
      droppedCount++
    }
  }
  return { kept, dropped, droppedCount, keptCount, keptBBoxArea }
}

/**
 * 在 ±radius 内搜一个平移 `s`，使「把 frame 平移 s 之后」与 base 的平均通道差最小。
 *
 * **逐像素全量算，不降采样。** 试过每 2 像素采一个点，结果是错的：网格一固定，
 * 候选平移一个像素就把特征与采样行的相对位置整个换掉，
 * 于是「恰好把眼睛的采样行错开」的那个错候选反而代价更低（实测选出了 (-1,1)）。
 * 采样要想无偏，网格必须跟着内容走，而内容正是我们要找的东西——是个死循环。
 * 画布尺寸很小（144×168），225 个候选 × 24k 像素只有几百万次运算，不值得省。
 */
function searchAlignOffset(
  frame: Buffer,
  base: Buffer,
  width: number,
  height: number,
  radius: number,
): { dx: number; dy: number; before: number; after: number } {
  const cost = (dx: number, dy: number): number => {
    let sum = 0
    let n = 0
    for (let y = 0; y < height; y++) {
      const fy = y + dy
      if (fy < 0 || fy >= height) continue
      for (let x = 0; x < width; x++) {
        const fx = x + dx
        if (fx < 0 || fx >= width) continue
        const a = (fy * width + fx) * 4
        const b = (y * width + x) * 4
        sum +=
          (Math.abs(frame[a]! - base[b]!) +
            Math.abs(frame[a + 1]! - base[b + 1]!) +
            Math.abs(frame[a + 2]! - base[b + 2]!)) /
          3
        n++
      }
    }
    return n > 0 ? sum / n : Number.POSITIVE_INFINITY
  }

  let bestDx = 0
  let bestDy = 0
  let bestCost = cost(0, 0)
  const atZero = bestCost
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue
      const c = cost(dx, dy)
      if (c < bestCost) {
        bestCost = c
        bestDx = dx
        bestDy = dy
      }
    }
  }
  return { dx: bestDx, dy: bestDy, before: atZero, after: bestCost }
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
  const radius = Math.max(0, options.searchRadius ?? DEFAULT_ALIGN_SEARCH)
  const n = width * height
  if (frame.length < n * 4 || base.length < n * 4) {
    throw new Error(
      `差分输入尺寸不符：期望 ${n * 4} 字节（${width}×${height} RGBA），` +
        `实际 frame=${frame.length} base=${base.length}`,
    )
  }

  const align = radius > 0
    ? searchAlignOffset(frame, base, width, height, radius)
    : { dx: 0, dy: 0, before: 0, after: 0 }
  const { dx, dy } = align

  const mask = new Uint8Array(n)
  let rawChanged = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 平移后 frame 取不到的位置按「无变化」处理（补零会造出一整条假差异）
      const fx = x + dx
      const fy = y + dy
      if (fx < 0 || fx >= width || fy < 0 || fy >= height) continue
      const fp = (fy * width + fx) * 4
      const bp = (y * width + x) * 4
      // 只比 RGB：alpha 在抠底后两边本来就都是 0（背景），比它没有信息量
      const d = Math.max(
        Math.abs(frame[fp]! - base[bp]!),
        Math.abs(frame[fp + 1]! - base[bp + 1]!),
        Math.abs(frame[fp + 2]! - base[bp + 2]!),
      )
      if (d <= threshold) continue
      mask[y * width + x] = 1
      rawChanged++
    }
  }

  // 连通域过滤：丢掉抗锯齿造成的零星噪点，只留成块的差异（见 MIN_COMPONENT_AREA_RATIO）
  const minArea = options.minComponentArea ?? minComponentArea(n)
  const filtered =
    minArea > 1 && rawChanged > 0
      ? filterSmallComponents(mask, width, height, minArea)
      : { kept: rawChanged, dropped: 0, droppedCount: 0, keptCount: rawChanged > 0 ? 1 : 0, keptBBoxArea: 0 }
  const changed = filtered.kept

  if (changed === 0) {
    return {
      data: Buffer.alloc(n * 4),
      bbox: null,
      changed: 0,
      rawChanged,
      droppedPixels: filtered.dropped,
      droppedComponents: filtered.droppedCount,
      componentCount: 0,
      changedRatio: 0,
      bboxAreaRatio: null,
      density: 0,
      offset: { dx, dy },
      meanDiffBefore: align.before,
      meanDiffAfter: align.after,
      usable: false,
    }
  }

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  const bbox: BBox = { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 }
  const bboxAreaRatio = (bbox.w * bbox.h) / n
  // 按连通域各算各的紧致度再按面积加权（关掉过滤时退回整体包围盒）
  const density = changed / (filtered.keptBBoxArea > 0 ? filtered.keptBBoxArea : bbox.w * bbox.h)

  /*
   * 扩张**掩膜**，不是包围盒矩形。
   *
   * 按矩形输出会把基准帧的整块头一并写成不透明——身体播到别的帧（`Idle` 有四帧）时，
   * 那块区域就会「冻」在基准帧的样子上，看起来像头被贴了一张图。
   * 只把变化区域的邻域写出去，才既盖住基准帧眼睛的抗锯齿边、又不多占一个像素。
   */
  const dilated = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    const x = i % width
    const y = (i - x) / width
    const xa = Math.max(0, x - dilate)
    const xb = Math.min(width - 1, x + dilate)
    const ya = Math.max(0, y - dilate)
    const yb = Math.min(height - 1, y + dilate)
    for (let yy = ya; yy <= yb; yy++) {
      for (let xx = xa; xx <= xb; xx++) dilated[yy * width + xx] = 1
    }
  }

  const data = Buffer.alloc(n * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!dilated[i]) continue
      // 取**平移后**的 frame 像素：图层要落在基准帧的坐标系里
      const fx = x + dx
      const fy = y + dy
      if (fx < 0 || fx >= width || fy < 0 || fy >= height) continue
      const sp = (fy * width + fx) * 4
      const p = i * 4
      data[p] = frame[sp]!
      data[p + 1] = frame[sp + 1]!
      data[p + 2] = frame[sp + 2]!
      data[p + 3] = 255
    }
  }

  return {
    data,
    bbox,
    changed,
    rawChanged,
    droppedPixels: filtered.dropped,
    droppedComponents: filtered.droppedCount,
    componentCount: filtered.keptCount,
    changedRatio: changed / n,
    bboxAreaRatio,
    density,
    offset: { dx, dy },
    meanDiffBefore: align.before,
    meanDiffAfter: align.after,
    usable: bboxAreaRatio <= MAX_DIFF_AREA_RATIO && density >= MIN_DIFF_DENSITY,
  }
}
