/**
 * sheetcheck — 出图质量闸门
 *
 * 设计依据：docs/plans/客户端UI/2026-09-21-宠物精灵图生成线优化实施计划.md §四
 *
 * ## 为什么这一步要在流水线里，而不是躺在 verify/ 下
 *
 * `cutout → slice → normalize → pack → validate → install` 里，`validate` 验的是**包**
 * （路径合法性、有没有真透明像素、清单交叉引用），**不验画**。而该验的那些判据
 * （角色是不是同一只、有没有被格线切掉、这几格到底是不是一段动作）本来就都能算——
 * `verify/pet-sprite/check-sprite-sheet.mjs` 早就把前几条算出来了，只是**不在流水线里**，
 * 于是出坏了要等用户装完才看见。
 *
 * 有了它，「生图不可控」就退化成「每批出图立刻判，不合格只重出这一批」。
 *
 * ## 判据表
 *
 * | 判据 | 内容 | 不通过时 |
 * | --- | --- | --- |
 * | S0 网格整除 | 图宽/高能否被行列数整除（除不尽则各格尺寸不一） | 记一条问题 |
 * | S1 边界干净 | 格线上既没有角色越界，也没有模型画的分隔线 | **判 unusable，重出** |
 * | — 每格非空 | 每格抠完都得有内容 | **判 unusable，重出** |
 * | S4 同一只角色 | 跨格调色板双向重合度 | **判 unusable，重出** |
 * | S2 格内对中 | 包围盒中心相对格中心的偏移 | 记一条问题 |
 * | S6 连续性 | 相邻格差异小且均匀、首尾能接上 | 记一条问题 |
 * | S8 底色安全 | 底色到角色调色板的距离是否够抠底 | 记一条问题 |
 * | — 底色一致 | 各格估计出的底色是否一致（不一致说明估计被角色色顶替） | 记一条问题 |
 *
 * S6/S8 只记问题不判 unusable，是因为**它们的阈值还没被足够多的真样本校准过**
 * （S6 的 `loopRatio` 只经 4 张真图定过）。先报出来攒数据，够稳了再收紧。
 *
 * **S3（尺度离散度）刻意不列为判据**：实测 73.4% 的离散度是**预期的**，
 * 尺度归一交给 `normalize`——它用全体帧的共同倍率，逐帧各自撑满会把「蹲下」的帧
 * 放大到和「站直」一样高，角色看起来像在抽搐。
 */

import {
  alphaBBox,
  colorDistance,
  cutout,
  estimateBackground,
  formatHexColor,
  parseHexColor,
  type BBox,
  type RGB,
} from './cutout.js'
import { planGrid } from './slice.js'
import { BG_MIN_SAFE_DISTANCE } from './sheet-prompt.js'

/**
 * 边界带里允许的非底色像素**比例**上限。
 *
 * 早先这里是 `bleed === 0`（一个像素都不许有），**实测把一张好图判死了**：
 * 一张 1254×1254 的 2×2 出图，四格各只有 **9 个像素**落在边界带里，
 * 与底色（`#01fbfd` 青）的最大通道差是 31–36，肉眼完全看不出来——
 * 是出图的柔和渐变与压缩残差，不是角色越界。
 *
 * 绝对像素数在两种情形间没有分辨力：
 *   - 真噪声：九个像素，散落在格子中线的上方一两行
 *   - 真越界：一条肢体切到格线上，至少是「几十像素宽 × 3 行」= 数百像素
 * 所以改判**比例**：0.5% 是实测噪声（7524 个带内像素里的 9 个 = 0.12%）的四倍余量，
 * 又比任何真实越界低一个量级。
 *
 * **画了分隔线仍按硬失败处理**：那种情况由 `drewLine` 单独判，它要求某条最外沿
 * 的覆盖率 ≥ 90%，远在 0.5% 之上，不会被这条放过去。
 */
export const MAX_BLEED_RATIO = 0.005

export interface SheetThresholds {
  /** S2：包围盒中心相对格中心的偏移上限（占格短边比例） */
  centerOffset: number
  /** S4：任意两格调色板双向重合度下限 */
  paletteOverlap: number
  /** S6：首尾格差异相对相邻差中位数的倍数上限 */
  loopRatio: number
  /** S8：底色到角色调色板的最小距离下限 */
  bgDistance: number
  /** S8：算作「角色色」的调色板条目最低占比 */
  paletteShareFloor: number
  /** S1：边界带里允许的非底色像素比例上限（见 `MAX_BLEED_RATIO`） */
  bleedRatio: number
}

export const SHEET_THRESHOLDS: SheetThresholds = {
  centerOffset: 0.12,
  paletteOverlap: 0.8,
  loopRatio: 1.8,
  bgDistance: BG_MIN_SAFE_DISTANCE,
  paletteShareFloor: 0.01,
  bleedRatio: MAX_BLEED_RATIO,
}

/** 算调色板重合度时判「近似色」的容差 */
const PALETTE_MATCH_TOL = 40

export interface SheetPaletteEntry {
  rgb: RGB
  share: number
}

export interface SheetCellReport {
  index: number
  row: number
  col: number
  /** 该格自动估计出的底色 */
  background: string
  /** 自动调参得到的抠底容差 */
  tSolid: number
  /** 泄漏临界容差（null = 没测到泄漏） */
  leakAt: number | null
  /** 角色包围盒（格内坐标）。null = 整格没内容 */
  bbox: BBox | null
  /** 边界带（3px）里的非底色像素数；> 0 说明这一格边界不干净 */
  bleed: number
  /** `bleed` 占边界带像素的比例；S1 判的就是它（见 `MAX_BLEED_RATIO`） */
  bleedRatio: number
  /** 四条最外沿的非底色覆盖率，用来区分「画了分隔线」与「角色越界」 */
  edges: CellEdges
  /** 是否有一条边整条都非底色 ⇒ 模型在格子边界画了线 */
  drewLine: boolean
  /** 包围盒中心相对格中心的偏移，已按格短边归一化 */
  centerOffset: number
  palette: SheetPaletteEntry[]
}

export interface SheetCheckReport {
  grid: { cols: number; rows: number; cellW: number; cellH: number; sheetW: number; sheetH: number }
  /** S0：图尺寸能被行列整除吗（除不尽则各格尺寸不一） */
  divisible: boolean
  cells: SheetCellReport[]
  /** S1 角色不越格 */
  s1: boolean
  /** S2 格内对中 */
  s2: boolean
  /** S4 同一只角色 */
  s4: boolean
  /** S6 连续性 */
  s6: boolean
  /** S8 底色安全 */
  s8: boolean
  /** 相邻格差异（阅读顺序）；S6 的分母 */
  adjacentDiffs: number[]
  /** 首尾格差异；S6 的分子 */
  loopDiff: number
  /** 相邻差的中位数 */
  baselineDiff: number
  /** 底色到角色调色板的最小距离（取最差的那一格） */
  bgDistance: number
  /** 最低的跨格调色板双向重合度 */
  minPaletteOverlap: number
  /**
   * `ok` 全部判据通过；`suspect` 还能用但某条判据没过；`unusable` 必须重出这一批。
   *
   * 刻意**不叫** `needs-normalize`：归一化是每一批都要走的固定步骤，
   * 拿它当档位名会让人以为「ok 的那些不用归一化」。
   */
  verdict: 'ok' | 'suspect' | 'unusable'
  problems: string[]
}

/** 边界带（像素）：角色只要碰进这个带子就算越界 */
const BLEED_BAND = 3
/** 判「是不是背景色」的容差 */
const BLEED_TOL = 30
/**
 * 一条边被判成「画了分隔线」的非底色覆盖率下限。
 *
 * 实测撞到过：`nano-banana-2` 无视提示词里 FORBIDDEN 的「网格线、边框、分隔线」，
 * 在格线位置画了一整条十字（x=510..513 与 y=510..513 各有 1024 个非底色像素 = 贯穿全图）。
 * **光数边界带里的非底色像素分不出「画了线」与「角色越界」**，两者都表现为 bleed > 0，
 * 而处理方式完全不同（线条是模型行为、要换模型或改提示词；越界是角色画大了）。
 * 用「这条边是不是整条都被非底色占满」来区分。
 */
const EDGE_LINE_COVERAGE = 0.9

/** 各格估计出的底色之间，超过这个距离就认为「底色估计被角色色顶替了」 */
const BG_CONSISTENCY_TOL = 60

export interface CellEdges {
  top: number
  bottom: number
  left: number
  right: number
}
/** 调色板量化到每通道 5 bit */
const PALETTE_BITS = 3
const paletteKey = (r: number, g: number, b: number): number =>
  ((r >> PALETTE_BITS) << 10) | ((g >> PALETTE_BITS) << 5) | (b >> PALETTE_BITS)
const keyToRgb = (k: number): RGB => [
  ((k >> 10) & 31) << PALETTE_BITS,
  ((k >> 5) & 31) << PALETTE_BITS,
  (k & 31) << PALETTE_BITS,
]

/** 从 RGBA（已抠底）里取占比前 N 的颜色 */
function paletteOf(data: Buffer, w: number, h: number, topN = 20): SheetPaletteEntry[] {
  const counts = new Map<number, number>()
  let total = 0
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3]! < 230) continue
    const k = paletteKey(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!)
    counts.set(k, (counts.get(k) ?? 0) + 1)
    total++
  }
  if (total === 0) return []
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k, n]) => ({ rgb: keyToRgb(k), share: n / total }))
}

/** a 的调色板有多大比例能在 b 里找到近似色 */
function paletteHitRatio(a: SheetPaletteEntry[], b: SheetPaletteEntry[]): number {
  let hit = 0
  let sum = 0
  for (const c of a) {
    sum += c.share
    if (b.some((d) => colorDistance(c.rgb, d.rgb) <= PALETTE_MATCH_TOL)) hit += c.share
  }
  return sum > 0 ? hit / sum : 0
}

/**
 * 边界带上的非底色像素：总数 + 四条最外沿 1px 的非底色覆盖率。
 *
 * 覆盖率用最外沿那一行/列算，而不是整条 3px 带——「画了条线」的特征正是
 * **最外沿整条都非底色**；用整条带算会被角色越界也抬到高覆盖率，区分不开。
 *
 * 同时返回边界带的**去重像素数**（`band`），供上层把 `total` 折算成比例——
 * 绝对像素数没法跨画布尺寸比较，而 `total === 0` 这种二值判据又太脆（见 `MAX_BLEED_RATIO`）。
 */
function edgeScan(
  rgba: Buffer,
  w: number,
  h: number,
  bg: RGB,
): { total: number; band: number; edges: CellEdges } {
  const isChar = (x: number, y: number): boolean => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false
    const i = (y * w + x) * 4
    return colorDistance([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!], bg) > BLEED_TOL
  }

  let total = 0
  for (let x = 0; x < w; x++) {
    for (let d = 0; d < BLEED_BAND; d++) {
      if (isChar(x, d)) total++
      if (isChar(x, h - 1 - d)) total++
    }
  }
  for (let y = 0; y < h; y++) {
    for (let d = 0; d < BLEED_BAND; d++) {
      if (isChar(d, y)) total++
      if (isChar(w - 1 - d, y)) total++
    }
  }

  let top = 0
  let bottom = 0
  let left = 0
  let right = 0
  for (let x = 0; x < w; x++) {
    if (isChar(x, 0)) top++
    if (isChar(x, h - 1)) bottom++
  }
  for (let y = 0; y < h; y++) {
    if (isChar(0, y)) left++
    if (isChar(w - 1, y)) right++
  }
  return {
    total,
    // 四条 d 像素宽的边组成的环，角落别重复计
    band: Math.max(1, w * h - Math.max(0, w - 2 * BLEED_BAND) * Math.max(0, h - 2 * BLEED_BAND)),
    edges: { top: top / w, bottom: bottom / w, left: left / h, right: right / h },
  }
}

interface CellRaw {
  rgba: Buffer
  w: number
  h: number
  bbox: BBox | null
}

/**
 * 两格之间的平均通道差（0–255）。
 *
 * **只在两格包围盒的并集里比**：底色是同一片纯色，全格平均会把角色身上的差异
 * 稀释掉一个量级——而 S6 要测的恰恰是「角色变了多少」。
 */
function cellDiff(a: CellRaw, b: CellRaw): number {
  const w = Math.min(a.w, b.w)
  const h = Math.min(a.h, b.h)
  let x0 = 0
  let y0 = 0
  let x1 = w
  let y1 = h
  if (a.bbox && b.bbox) {
    x0 = Math.max(0, Math.min(a.bbox.minX, b.bbox.minX))
    y0 = Math.max(0, Math.min(a.bbox.minY, b.bbox.minY))
    x1 = Math.min(w, Math.max(a.bbox.maxX + 1, b.bbox.maxX + 1))
    y1 = Math.min(h, Math.max(a.bbox.maxY + 1, b.bbox.maxY + 1))
  }
  if (x1 <= x0 || y1 <= y0) return 0
  let sum = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      sum +=
        (Math.abs(a.rgba[i]! - b.rgba[i]!) +
          Math.abs(a.rgba[i + 1]! - b.rgba[i + 1]!) +
          Math.abs(a.rgba[i + 2]! - b.rgba[i + 2]!)) /
        3
      n++
    }
  }
  return n > 0 ? sum / n : 0
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/**
 * 判一份出图图集能不能用。
 *
 * **输入必须是 RGBA**（4 通道）。抠底算法要读 alpha 通道，
 * 用 3 通道喂进来会把 RGB 当成 RGBA 错位读，得到的结果毫无意义且不报错。
 */
export function analyzeSheet(
  sheet: Buffer,
  width: number,
  height: number,
  options: { cols: number; rows: number; thresholds?: Partial<SheetThresholds> },
): SheetCheckReport {
  const th = { ...SHEET_THRESHOLDS, ...options.thresholds }
  const { cols, rows } = options
  const rects = planGrid(width, height, { cols, rows })
  const cellW = rects[0]!.w
  const cellH = rects[0]!.h

  const cellReports: SheetCellReport[] = []
  const raws: CellRaw[] = []
  const problems: string[] = []

  for (const rect of rects) {
    const rgba = Buffer.alloc(rect.w * rect.h * 4)
    for (let y = 0; y < rect.h; y++) {
      const src = ((rect.y + y) * width + rect.x) * 4
      sheet.copy(rgba, y * rect.w * 4, src, src + rect.w * 4)
    }
    const bg = estimateBackground(rgba, rect.w, rect.h)
    const res = cutout(rgba, rect.w, rect.h, bg)
    const bbox = alphaBBox(res.data, rect.w, rect.h)
    const palette = paletteOf(res.data, rect.w, rect.h)
    const cx = bbox ? bbox.minX + bbox.w / 2 : rect.w / 2
    const cy = bbox ? bbox.minY + bbox.h / 2 : rect.h / 2
    const centerOffset = Math.hypot(cx - rect.w / 2, cy - rect.h / 2) / Math.min(rect.w, rect.h)
    const scan = edgeScan(rgba, rect.w, rect.h, bg)

    cellReports.push({
      index: rect.index,
      row: rect.row,
      col: rect.col,
      background: formatHexColor(bg),
      tSolid: res.tuning.tSolid,
      leakAt: res.tuning.leakAt ?? null,
      bbox,
      bleed: scan.total,
      bleedRatio: scan.total / scan.band,
      edges: scan.edges,
      drewLine: Object.values(scan.edges).some((v) => v >= EDGE_LINE_COVERAGE),
      centerOffset,
      palette,
    })
    raws.push({ rgba, w: rect.w, h: rect.h, bbox })
  }

  // ---- S0 网格整除 ----
  const divisible = width % cols === 0 && height % rows === 0
  if (!divisible) {
    problems.push(
      `S0 图尺寸 ${width}×${height} 不能被 ${cols}×${rows} 整除，各格尺寸不一` +
        `（末列/末行吃掉余数）——出图模型的输出尺寸不受 width/height 参数约束时就会这样`,
    )
  }

  // ---- 各格底色是否一致 ----
  //
  // 底色是逐格估计的（`estimateBackground` 取边框带的众数）。角色一旦盖住边框带，
  // 众数就会变成**角色色**——实测一个半径 66 的圆在 128 的格里占掉边框带的 57%，
  // 整格的底色被估成角色色，接着抠底全错、包围盒等于整格，
  // 最终表现为「越界」这种**看不出真因**的判据失败。所以先把这条单独报出来。
  const bgRgbs = cellReports.map((c) => parseHexColor(c.background)).filter((v): v is RGB => v !== null)
  let maxBgSpread = 0
  for (let i = 0; i < bgRgbs.length; i++) {
    for (let j = i + 1; j < bgRgbs.length; j++) {
      maxBgSpread = Math.max(maxBgSpread, colorDistance(bgRgbs[i]!, bgRgbs[j]!))
    }
  }
  if (maxBgSpread > BG_CONSISTENCY_TOL) {
    problems.push(
      `各格估计出的底色不一致（最大相差 ${maxBgSpread.toFixed(0)}）——` +
        `多半是某几格的角色盖住了边框带，众数取到了角色色；这一版的其它判据都不可信，重出这一批`,
    )
  }

  // ---- S1 边界干净 ----
  //
  // 判**比例**不判「一个都没有」：见 MAX_BLEED_RATIO 的实测来由。
  const s1 = cellReports.every((c) => c.bleedRatio <= th.bleedRatio)
  if (!s1) {
    const lined = cellReports.filter((c) => c.drewLine)
    const spilled = cellReports.filter((c) => c.bleedRatio > th.bleedRatio && !c.drewLine)
    if (lined.length > 0) {
      problems.push(
        `S1 模型在格子边界画了分隔线/边框（第 ${lined.map((c) => c.index + 1).join('、')} 格）` +
          `——提示词的 FORBIDDEN 里写了不许画，但这一版没守住。按格切会把线切进画面，重出或换模型`,
      )
    }
    if (spilled.length > 0) {
      problems.push(
        `S1 有 ${spilled.length} 格的角色越出格线（第 ${spilled.map((c) => c.index + 1).join('、')} 格，` +
          `最差 ${(Math.max(...spilled.map((c) => c.bleedRatio)) * 100).toFixed(2)}% 的边界带像素非底色，` +
          `上限 ${(MAX_BLEED_RATIO * 100).toFixed(2)}%）——切出来会缺一块，重出这一批`,
      )
    }
  }

  // ---- 每格都得有内容 ----
  const empty = cellReports.filter((c) => !c.bbox)
  if (empty.length > 0) {
    problems.push(`有 ${empty.length} 格抠完没有任何内容（第 ${empty.map((c) => c.index + 1).join('、')} 格）`)
  }

  // ---- S2 格内对中 ----
  const s2 = cellReports.every((c) => c.centerOffset <= th.centerOffset)
  if (!s2) {
    const worst = Math.max(...cellReports.map((c) => c.centerOffset))
    problems.push(
      `S2 角色在格内偏移过大（最差 ${(worst * 100).toFixed(0)}% > ${(th.centerOffset * 100).toFixed(0)}%）` +
        `——不影响可用性，normalize 会按包围盒重新定位`,
    )
  }

  // ---- S4 同一只角色 ----
  let minPaletteOverlap = 1
  for (let i = 0; i < cellReports.length; i++) {
    for (let j = i + 1; j < cellReports.length; j++) {
      const ab = paletteHitRatio(cellReports[i]!.palette, cellReports[j]!.palette)
      const ba = paletteHitRatio(cellReports[j]!.palette, cellReports[i]!.palette)
      minPaletteOverlap = Math.min(minPaletteOverlap, Math.min(ab, ba))
    }
  }
  const s4 = minPaletteOverlap >= th.paletteOverlap
  if (!s4) {
    problems.push(
      `S4 各格配色不像同一只角色（最低双向重合 ${(minPaletteOverlap * 100).toFixed(0)}% < ${(th.paletteOverlap * 100).toFixed(0)}%）——重出这一批`,
    )
  }

  // ---- S6 连续性 ----
  const adjacentDiffs: number[] = []
  for (let i = 0; i + 1 < raws.length; i++) adjacentDiffs.push(cellDiff(raws[i]!, raws[i + 1]!))
  const loopDiff = raws.length > 1 ? cellDiff(raws[raws.length - 1]!, raws[0]!) : 0
  const baselineDiff = median(adjacentDiffs)
  // 相邻差本身为 0 时（四格一模一样）说明模型压根没画出动作，单独报，别让比值除零
  const frozen = adjacentDiffs.length > 0 && baselineDiff < 1
  const s6 = !frozen && loopDiff <= Math.max(baselineDiff * th.loopRatio, baselineDiff + 2)
  if (frozen) {
    problems.push('S6 各格几乎没有差异——模型没有画出动作，四格是同一张画（重出这一批）')
  } else if (!s6) {
    problems.push(
      `S6 首尾接不上（首尾差 ${loopDiff.toFixed(1)}，相邻差中位数只有 ${baselineDiff.toFixed(1)}）` +
        `——循环播放时会有一次跳变`,
    )
  }

  // ---- S8 底色安全 ----
  let bgDistance = Number.POSITIVE_INFINITY
  for (const c of cellReports) {
    const bg = parseHexColor(c.background)
    if (!bg) continue
    for (const p of c.palette) {
      if (p.share < th.paletteShareFloor) continue
      bgDistance = Math.min(bgDistance, colorDistance(bg, p.rgb))
    }
  }
  if (!Number.isFinite(bgDistance)) bgDistance = 0
  const s8 = bgDistance >= th.bgDistance
  if (!s8) {
    problems.push(
      `S8 底色离角色色只有 ${bgDistance.toFixed(0)}（安全线 ${th.bgDistance}）` +
        `——抠底容差会逼近这个距离，有穿过描边漏进角色内部的风险`,
    )
  }

  const usable = s1 && s4 && empty.length === 0
  const ok = usable && s6 && s8 && divisible

  return {
    grid: { cols, rows, cellW, cellH, sheetW: width, sheetH: height },
    divisible,
    cells: cellReports,
    s1,
    s2,
    s4,
    s6,
    s8,
    adjacentDiffs,
    loopDiff,
    baselineDiff,
    bgDistance,
    minPaletteOverlap,
    verdict: ok ? 'ok' : usable ? 'suspect' : 'unusable',
    problems,
  }
}
