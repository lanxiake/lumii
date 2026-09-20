/**
 * pack — 打包成图集（pet-asset）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.2
 *
 * 产出 `atlas.png` + `atlas.json`，格式是 **TexturePacker Hash**——与运行时
 * `parseAtlasIndex` 读的那一种，也与示范模型生成器写的一致。工具链产出必须过得了
 * 自家校验，这条由 `pack.test.ts` 里的往返用例守住。
 *
 * 排布用**统一格子**而不是紧凑排布（bin packing）：格子尺寸一致时 `atlas.json`
 * 的矩形一眼能看懂、手改清单时不必反复对数字，而图集体积在桌宠这个量级（几十 KB）
 * 上不是瓶颈——真实模型 11 张图、1.2 KB。
 */

export interface PackInput {
  name: string
  width: number
  height: number
}

export interface PackLayoutOptions {
  /** 每行最多几格；默认 8 */
  maxCols?: number
  /** 格子内边距（像素）；默认 0。留白可避免 NEAREST 采样时相邻格串色 */
  padding?: number
}

export interface PackedEntry {
  name: string
  x: number
  y: number
  w: number
  h: number
}

export interface PackLayout {
  width: number
  height: number
  cols: number
  rows: number
  entries: PackedEntry[]
}

/** 计算图集排布（纯函数） */
export function planAtlasLayout(
  frames: readonly PackInput[],
  opts: PackLayoutOptions = {},
): PackLayout {
  if (frames.length === 0) throw new Error('至少要有一张图才能打包')
  const maxCols = Math.max(1, Math.floor(opts.maxCols ?? 8))
  const padding = Math.max(0, Math.floor(opts.padding ?? 0))

  const cellW = Math.max(...frames.map((f) => f.width))
  const cellH = Math.max(...frames.map((f) => f.height))
  const cols = Math.min(maxCols, frames.length)
  const rows = Math.ceil(frames.length / cols)

  const strideX = cellW + padding
  const strideY = cellH + padding

  const entries: PackedEntry[] = frames.map((f, i) => ({
    name: f.name,
    x: (i % cols) * strideX,
    y: Math.floor(i / cols) * strideY,
    w: f.width,
    h: f.height,
  }))

  return {
    // 去掉最后一格之后多出来的那圈 padding
    width: cols * strideX - padding,
    height: rows * strideY - padding,
    cols,
    rows,
    entries,
  }
}

/** TexturePacker Hash 格式的图集索引 */
export interface AtlasIndexJson {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>
  meta: { image: string; size: { w: number; h: number } }
}

/** 构造图集索引 JSON（纯函数），字段与 `parseAtlasIndex` 的读取侧一一对应 */
export function buildAtlasIndex(
  layout: PackLayout,
  imageName: string,
): AtlasIndexJson {
  const frames: AtlasIndexJson['frames'] = {}
  for (const e of layout.entries) {
    frames[e.name] = { frame: { x: e.x, y: e.y, w: e.w, h: e.h } }
  }
  return {
    frames,
    meta: { image: imageName, size: { w: layout.width, h: layout.height } },
  }
}
