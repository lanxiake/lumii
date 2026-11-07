/**
 * 抽帧自检：渲染之后、交付之前，用**像素**判断画面好不好。
 *
 * ## 为什么需要这一层
 *
 * 前面几层门禁都是看**数据**（元素数量、坐标、kind）。它们查不出这些问题：
 * - 元素画出来了，但在画面里小到看不见
 * - 整屏只有一块内容，左边三分之二是空的
 * - 某个元素是纯色块，不承载任何信息
 *
 * 这些只有看帧才知道。判据取自 SenseNova 的 `code-video` 手册 §5
 * 「Pixels are the only evidence」与 anything2explainer 的六组反例：
 * 主体太小、背景碎屑、空白帧。
 *
 * ## 为什么不交给 VLM
 *
 * 一次多模态往返几秒钟 + 一次调用成本，而这里要判的几件事都是**几何量**：
 * 非背景像素的包围盒、占比、最大连通域。确定性判据可复现、可单测、零成本。
 * VLM 该做的是「这个图讲清楚了吗」，那是审美判断，不是这里要守的底线。
 */

/** 一帧的像素统计（由调用方从 PNG 解出，这里只做判定） */
export interface FrameStats {
  width: number
  height: number
  /** 非背景像素数量（与背景色差超过阈值的像素） */
  inkPixels: number
  /** 非背景像素的包围盒（像素） */
  bbox: { x: number; y: number; w: number; h: number } | null
  /** 最大连通域的像素数（用来判断「是不是只有一小块内容」） */
  largestBlobPixels: number
  /**
   * 各颜色的像素数（按桶量化后的 RGB 键），用来判「有没有大片色块压在文字下」。
   *
   * 只统计非背景像素。键是 `${r>>4},${g>>4},${b>>4}`——16 级量化足以区分
   * 「浅蓝底」与「白底」，又不会被抗锯齿产生上百种相近色。
   */
  colorBuckets?: Map<string, number>
}

export type FrameIssueKind =
  /** 整帧几乎没有内容（可能渲染失败或这一节是空的） */
  | 'blank_frame'
  /** 内容太散：最大一块占非背景像素的比例过低（碎屑感） */
  | 'scattered'
  /** 内容太小：包围盒占画面比例过低（主体看不见） */
  | 'too_small'
  /** 内容挤在一角：包围盒重心偏离画面中心过多 */
  | 'off_center'

export interface FrameIssue {
  kind: FrameIssueKind
  /** 出问题的是第几帧（在本次抽样的序列里，0 起） */
  frame: number
  detail: string
}

/**
 * 判定一帧。
 *
 * 阈值取自实测与各项目的手册：
 * - 空白帧：非背景像素 < 0.3%（实测正常帧在 2%~15%）
 * - 碎屑：最大连通域占非背景像素 < 35%（一大块内容会有 60%+）
 * - 太小：包围盒 < 画面的 12%（SenseNova 要求主体 ≥1/3 高度，但那是主体；
 *   这里守的是「整屏至少占一点」，再低就是没画出来）
 * - 偏角：包围盒重心离画面中心 > 画面短边的 32%
 */
export function checkFrame(stats: FrameStats, frameIndex: number): FrameIssue[] {
  const issues: FrameIssue[] = []
  const total = stats.width * stats.height
  if (total <= 0) return issues
  const inkRatio = stats.inkPixels / total

  if (inkRatio < 0.003) {
    issues.push({
      kind: 'blank_frame',
      frame: frameIndex,
      detail: `第 ${frameIndex + 1} 帧只有 ${(inkRatio * 100).toFixed(2)}% 的像素有内容，近似空白`,
    })
    // 空白帧就不必再判其它了
    return issues
  }

  if (stats.inkPixels > 0 && stats.largestBlobPixels / stats.inkPixels < 0.35) {
    issues.push({
      kind: 'scattered',
      frame: frameIndex,
      detail: `第 ${frameIndex + 1} 帧最大一块只占内容的 ${Math.round((stats.largestBlobPixels / stats.inkPixels) * 100)}%，显得零散`,
    })
  }

  const bbox = stats.bbox
  if (bbox) {
    const bboxArea = bbox.w * bbox.h
    if (bboxArea / total < 0.12) {
      issues.push({
        kind: 'too_small',
        frame: frameIndex,
        detail: `第 ${frameIndex + 1} 帧内容只占画面的 ${Math.round((bboxArea / total) * 100)}%，太小`,
      })
    }
    const cx = bbox.x + bbox.w / 2
    const cy = bbox.y + bbox.h / 2
    const dx = (cx - stats.width / 2) / stats.width
    const dy = (cy - stats.height / 2) / stats.height
    const dist = Math.hypot(dx, dy)
    if (dist > 0.32) {
      issues.push({
        kind: 'off_center',
        frame: frameIndex,
        detail: `第 ${frameIndex + 1} 帧内容重心偏离画面中心 ${Math.round(dist * 100)}%`,
      })
    }
  }

  // 对比度问题**不在这一层判**。
  //
  // 试过两种像素判据都不可靠：
  // - 「单一色桶占比过高」→ 黑底白字天然如此，全屏误报
  // - 「内容集中在 ≤2 个色桶」→ 纯色背景 + 单色文字在像素分布上与
  //   「浅蓝块 + 蓝字」完全一样，区分不了
  //
  // 真正的判据需要**元素语义**（哪个是色块、哪个是文字、谁压在谁上面），
  // 那在数据层有准确信息，见 `checkSceneLayout` 的 `highlight_over_text`。

  return issues
}

/**
 * 从原始 RGBA 缓冲区统计一帧。
 *
 * 调用方拿到的是 `capturePage().toBitmap()` 的 BGRA 缓冲。这里**不解码 PNG**：
 * Electron 已经给了原始像素，再编码成 PNG 再解码是纯浪费。
 *
 * @param pixels BGRA 缓冲区（Electron 的 NativeImage.toBitmap 格式）
 * @param bg 背景色 [r,g,b]
 * @param tolerance 与背景色的 RGB 距离阈值，超过就算「有内容」
 */
export function analyzeFrame(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  bg: readonly [number, number, number],
  tolerance = 26,
): FrameStats {
  const total = width * height
  let ink = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  // 连通域用并查集：画面元素是分离的色块，洪水填充会比逐像素标记更直观，
  // 但并查集只需一次扫描且不需要递归栈
  const labels = new Int32Array(total).fill(-1)
  let nextLabel = 0
  const colorBuckets = new Map<string, number>()
  // 先做一遍二值化，同时记录包围盒
  for (let i = 0; i < total; i++) {
    const o = i * 4
    const b = pixels[o]!
    const g = pixels[o + 1]!
    const r = pixels[o + 2]!
    const dist = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2])
    if (dist > tolerance) {
      ink++
      labels[i] = 0 // 占位，下一步再分配
      // 16 级量化的色桶：能区分「浅蓝块」与「白底上的蓝线」，又不会被抗锯齿炸开
      const key = `${r >> 4},${g >> 4},${b >> 4}`
      colorBuckets.set(key, (colorBuckets.get(key) ?? 0) + 1)
      const x = i % width
      const y = (i - x) / width
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  // 4 邻域连通域标记（迭代式，避免递归爆栈）
  const sizes = new Map<number, number>()
  const stack: number[] = []
  for (let i = 0; i < total; i++) {
    if (labels[i] !== 0) continue
    const label = ++nextLabel
    let size = 0
    stack.push(i)
    labels[i] = label
    while (stack.length > 0) {
      const p = stack.pop()!
      size++
      const x = p % width
      const y = (p - x) / width
      // 右、左、下、上
      const neighbors = [
        x + 1 < width ? p + 1 : -1,
        x > 0 ? p - 1 : -1,
        p + width < total ? p + width : -1,
        p - width >= 0 ? p - width : -1,
      ]
      for (const n of neighbors) {
        if (n >= 0 && labels[n] === 0) {
          labels[n] = label
          stack.push(n)
        }
      }
    }
    sizes.set(label, size)
  }
  let largest = 0
  for (const s of sizes.values()) if (s > largest) largest = s

  return {
    width,
    height,
    inkPixels: ink,
    bbox: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    largestBlobPixels: largest,
    colorBuckets,
  }
}

/**
 * 从风格主题的十六进制背景色解析出 RGB。
 *
 * 主题里的 `bg` 可能是 `transparent`（那实际是页面底色），这时用 fallback。
 */
export function parseHexColor(hex: string, fallback: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return fallback
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
