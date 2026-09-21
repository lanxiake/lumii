/**
 * hit-areas — 从角色轮廓推导点击命中区（pet-asset，纯函数）
 *
 * 设计依据：docs/design/客户端UI/2026-09-21-宠物包规范设计.md 断点 B4。
 *
 * ## 为什么必须推导，而不是让作者手写
 *
 * 清单里没有 `hitAreas` 时，渲染器的 `hitTestPolygons` 恒返回 null，
 * 而注册表里的 `tapMotions` 是按 `HitAreaHead` / `HitAreaBody` 这两个 id 索引的
 * ——**两边对不上，点击一路静默走到 return，什么都不会发生**。
 * 实测日志里从头到尾没有一条 `[playMotion] group="Wave"`，就是这个原因。
 *
 * 手写顶点也不可行：顶点是相对画布的像素坐标，而画布尺寸、角色在画布里的站位
 * 都由归一化那一步决定（同一只角色换一次画布就全变）。作者写不出来，
 * 推导却是确定性的——轮廓就在 alpha 通道里。
 *
 * ## 为什么是「逐行扫描的多边形」而不是包围盒
 *
 * 渲染器的 `isPointerOverModel` 先用 `hitTest`、再用 `getBounds()` 兜底。
 * 命中区一旦盖住角色旁边的透明区，鼠标在那里就被宠物窗口吃掉、穿不到下层窗口。
 * 包围盒对「抬手」这种姿态会圈进一大片空白，逐行贴着轮廓扫则不会。
 */

import { alphaBBox } from './cutout.js'

/** 多边形顶点，相对画布左上角 */
export type HitAreaPoint = [number, number]

export interface DerivedHitArea {
  id: string
  points: HitAreaPoint[]
}

export interface HitAreaDeriveOptions {
  /** 头部占轮廓高度的比例（自上而下）。默认 0.34 */
  headRatio?: number
  /** 每条边采样多少行；越大越贴合轮廓。默认 32 */
  rows?: number
  /** alpha 阈值，低于它视为透明 */
  threshold?: number
  /** 头部命中区 id。默认 `HitAreaHead`（与注册表 tapMotions 的约定一致） */
  headId?: string
  /** 身体命中区 id。默认 `HitAreaBody` */
  bodyId?: string
}

export const DEFAULT_HEAD_RATIO = 0.34
/**
 * 默认采样行数。
 *
 * 定在 32 是量出来的（樱桃的待机帧，覆盖率 = 被命中区盖住的角色像素占比）：
 *
 * | 行数 | 覆盖率 | 顶点总数 | 漏得最多的一行 |
 * | --- | --- | --- | --- |
 * | 8 | 97.67% | 32 | 16%（一行里六分之一点不到） |
 * | 12 | 97.05% | 48 | 26% |
 * | 20 | 97.91% | 80 | 17% |
 * | **32** | **98.39%** | 124 | **只剩轮廓最尖那一行的 5 个像素** |
 *
 * 取 32 不是因为它覆盖率最高（只比 20 行多 0.5 个百分点），而是因为
 * **"某一整行里有大片点不到"这件事消失了**——前几档都存在某一行漏掉六分之一以上。
 * 剩下那 1.6% 是轮廓边缘 1–2px 的细条，屏幕上是亚像素级。
 */
export const DEFAULT_HIT_ROWS = 32

/** 头部占比的合法区间。太小点头会误判成身体，太大点身体会被当成头 */
const MIN_HEAD_RATIO = 0.05
const MAX_HEAD_RATIO = 0.8

/** 采样行数下限：低于 2 行构不成多边形（至少要有上、下两条边） */
const MIN_ROWS = 2

/** 统计 [yLo, yHi] 这几行里不透明像素的整体左右边界；全空返回 null */
function rangeExtent(
  rgba: Buffer,
  w: number,
  yLo: number,
  yHi: number,
  threshold: number,
): { minX: number; maxX: number } | null {
  let minX = Infinity
  let maxX = -1
  for (let y = yLo; y <= yHi; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3]! > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
  }
  return maxX < 0 ? null : { minX, maxX }
}

/**
 * 逐行扫描一条水平带，返回左右边界。
 *
 * ## 首尾两行要取**窗口并集**，不能只取那一行
 *
 * 这是实测逼出来的。轮廓包围盒的最上/最下一行，是轮廓**收成尖**的地方——
 * 樱桃待机帧的 y=441（脚底）整行只有 5 个不透明像素，而 y=432 有 44 个。
 * 只按这两行取样，多边形就会从上一采样点直接连到这个近退化的尖点，
 * 中间 9 行全被直线切掉：实测 y=439 那一行**有 70% 的角色像素点不到**。
 *
 * 改成取「首行到第一个采样点之间」「最后一个采样点到末行之间」这块窗口的整体边界，
 * 多边形在两端就覆盖满。代价是最底部那几行会**略微多覆盖**一点空白——
 * 命中区本来就该偏保守：多盖一点只是把宠物窗口的鼠标穿透边界推出去两三个像素，
 * 少盖一点则是点上去没反应。
 */
function scanBand(
  rgba: Buffer,
  w: number,
  y0: number,
  y1: number,
  rows: number,
  threshold: number,
): { left: number[]; right: number[]; ys: number[] } {
  const ys: number[] = []
  const left: number[] = []
  const right: number[] = []
  const step = rows > 1 ? (y1 - y0) / (rows - 1) : y1 - y0

  for (let i = 0; i < rows; i++) {
    /*
     * 采样点**取到两端**（首行落在 y0、末行落在 y1），不取中点。
     *
     * 取中点是我第一版的做法，理由是"避开边界行上的抗锯齿"。实测发现后果是
     * **头与身体之间留出一条点不到的缝**：头带采样到 y1 前就停了、体带从 y0 之后
     * 才开始，中间那十几像素两个多边形都不覆盖（樱桃 y 170..185）。
     *
     * 而那个理由本身也不成立：两条带的分界是**角色身体内部**的一条水平线，
     * 不是轮廓边缘，那里没有抗锯齿可避。
     */
    const t = rows === 1 ? 0.5 : i / (rows - 1)
    const y = Math.min(y1, Math.max(y0, Math.round(y0 + t * (y1 - y0))))
    ys.push(y)

    // 首尾各取半格窗口的并集；中间仍按单行取样（相邻行差别很小，取并集是白花钱）
    let lo = y
    let hi = y
    if (rows === 1) {
      lo = y0
      hi = y1
    } else if (i === 0) {
      lo = y0
      hi = Math.min(y1, Math.round(y0 + step / 2))
    } else if (i === rows - 1) {
      lo = Math.max(y0, Math.round(y1 - step / 2))
      hi = y1
    }

    const e = rangeExtent(rgba, w, lo, hi, threshold)
    left.push(e ? e.minX : Infinity)
    right.push(e ? e.maxX : -1)
  }

  // 空行回填：先向下找第一个非空行，再向后沿用。
  // 空行若不回填，多边形会在那里收成一个尖角；相邻行一旦左右交叉，多边形就自交了
  // ——自交的奇偶判定在部分边上会反过来。
  let carryL = Infinity
  let carryR = -1
  for (let i = 0; i < rows; i++) {
    if (left[i] !== Infinity) break
    for (let j = i + 1; j < rows; j++) {
      if (left[j] !== Infinity) {
        carryL = left[j]!
        carryR = right[j]!
        break
      }
    }
  }
  for (let i = 0; i < rows; i++) {
    if (left[i] === Infinity) {
      left[i] = carryL
      right[i] = carryR
    } else {
      carryL = left[i]!
      carryR = right[i]!
    }
  }
  return { left, right, ys }
}

/**
 * 压掉**连续同 x** 的顶点（一条竖直线段只需要两个端点）。
 *
 * 角色的身体两侧大多是竖直的，逐行采样会在那里产生一长串 x 完全相同的点，
 * 它们对形状没有任何贡献。
 *
 * **但省得不多，别高估它**：实测樱桃（双马尾 + 裙摆，轮廓以曲线为主）在 32 行时
 * 只有 128 → 124 个顶点（3%），48 行时 192 → 177（8%）。轮廓越直省得越多，
 * 所以像素风角色会比这只收益大。
 *
 * 保留每段的**首尾两个**点而不是只留一个：竖直线段由端点完全确定，留下首尾是**无损**的；
 * 只留一个会让线段提前拐弯。
 */
function compressVerticalRuns(points: HitAreaPoint[]): HitAreaPoint[] {
  if (points.length <= 2) return points
  const out: HitAreaPoint[] = [points[0]!]
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1]!
    const cur = points[i]!
    const next = points[i + 1]!
    // 与前后都同 x ⇒ 在竖直段中间，可以丢
    if (prev[0] === cur[0] && cur[0] === next[0]) continue
    out.push(cur)
  }
  out.push(points[points.length - 1]!)
  return out
}

/**
 * 把一条带的左右边界转成闭合多边形：左边从上往下、右边从下往上。
 *
 * 这个顺序保证多边形不自交（每行 `left ≤ right`，两条边不交叉），
 * 且绕向一致——射线法对两种绕向都成立，但一致的绕向让结果可复现。
 */
function bandPolygon(
  left: number[],
  right: number[],
  ys: number[],
): HitAreaPoint[] | null {
  const leftPts: HitAreaPoint[] = []
  const rightPts: HitAreaPoint[] = []
  for (let i = 0; i < ys.length; i++) {
    if (left[i] !== Infinity) leftPts.push([left[i]!, ys[i]!])
    if (right[i] !== -1) rightPts.push([right[i]!, ys[i]!])
  }
  if (leftPts.length === 0) return null
  const pts = [...compressVerticalRuns(leftPts), ...compressVerticalRuns(rightPts).reverse()]
  // 去重后仍不足 3 个顶点 ⇒ 退化（全透明，或只有一行）
  const uniq = new Set(pts.map((p) => `${p[0]},${p[1]}`))
  return uniq.size >= 3 ? pts : null
}

/**
 * 从一张归一化后的帧推出 `HitAreaHead` / `HitAreaBody` 两个命中区。
 *
 * 输入应当是**待机姿态**的帧：其它动作（举手、下蹲）会把轮廓撑开或收窄，
 * 推导出的命中区跟着变，点击区域就会随动画呼吸而抖动。
 *
 * @returns 命中的命中区数组；角色全透明时返回空数组
 */
export function deriveHitAreas(
  rgba: Buffer,
  w: number,
  h: number,
  opts: HitAreaDeriveOptions = {},
): DerivedHitArea[] {
  const threshold = opts.threshold ?? 128
  const headId = opts.headId ?? 'HitAreaHead'
  const bodyId = opts.bodyId ?? 'HitAreaBody'
  const rows = Math.max(MIN_ROWS, Math.floor(opts.rows ?? DEFAULT_HIT_ROWS))
  const headRatio = Math.min(
    MAX_HEAD_RATIO,
    Math.max(MIN_HEAD_RATIO, opts.headRatio ?? DEFAULT_HEAD_RATIO),
  )

  const bbox = alphaBBox(rgba, w, h, threshold)
  if (!bbox) return []

  // 头 / 体的分界：从头顶往下数 headRatio 的高度
  const splitY = bbox.minY + Math.round(bbox.h * headRatio)

  const out: DerivedHitArea[] = []
  const push = (id: string, y0: number, y1: number) => {
    if (y1 <= y0) return
    const band = scanBand(rgba, w, y0, y1, rows, threshold)
    const points = bandPolygon(band.left, band.right, band.ys)
    if (points) out.push({ id, points })
  }

  // 身体在前：两块重叠时**先命中者胜**，而头与身体的分界处总会有几行重叠。
  // 让身体优先，是因为点击头部本来就该是个更小的目标，重叠区判给身体更符合直觉。
  push(bodyId, splitY, bbox.maxY)
  push(headId, bbox.minY, splitY)

  return out
}
