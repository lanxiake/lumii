/**
 * toolchain — slice / align / pack 的 I/O 层
 *
 * 几何算法分别在 `slice.ts` / `align.ts` / `pack.ts`（纯函数、可单测），
 * 这里只负责读盘、调它们、再落盘。
 */

import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import sharp from 'sharp'
import { readRgba, writeRgbaPng } from './image.js'
import { planGrid, type SliceCell, type SliceGridOptions } from './slice.js'
import {
  computeAlignPlacements,
  computeNormalize,
  type AlignOptions,
  type AlignResult,
  type NormalizeOptions,
} from './align.js'
import { buildAtlasIndex, planAtlasLayout, type PackLayoutOptions } from './pack.js'
import { listFilesRecursive } from './io.js'
import { parseAtlasIndex } from '@mtbot/pet-core'

const IMAGE_EXT = /\.(png|webp)$/i

// ---------------------------------------------------------------------------
// slice
// ---------------------------------------------------------------------------

export interface SliceOutcome {
  input: string
  outDir: string
  source: { w: number; h: number }
  cells: (SliceCell & { file: string })[]
}

/**
 * 按网格切图，每格写一个 PNG。
 *
 * 输出文件名用 `r{行}c{列}`，不用序号——序号在行列数变化时会整体错位，
 * 而行列坐标是稳定的，重新切一次不会把上一轮的文件名对错。
 */
export async function runSlice(
  inputPath: string,
  outDir: string,
  opts: SliceGridOptions & { prefix?: string },
): Promise<SliceOutcome> {
  const { data, width, height } = await readRgba(inputPath)
  const cells = planGrid(width, height, opts)
  const prefix = opts.prefix ?? basename(inputPath, extname(inputPath))

  await fs.mkdir(outDir, { recursive: true })
  const out: SliceOutcome['cells'] = []
  for (const cell of cells) {
    const buf = Buffer.alloc(cell.w * cell.h * 4)
    for (let y = 0; y < cell.h; y++) {
      const srcStart = ((cell.y + y) * width + cell.x) * 4
      data.copy(buf, y * cell.w * 4, srcStart, srcStart + cell.w * 4)
    }
    const file = join(outDir, `${prefix}_r${cell.row}c${cell.col}.png`)
    await writeRgbaPng(file, buf, cell.w, cell.h)
    out.push({ ...cell, file })
  }

  return { input: inputPath, outDir, source: { w: width, h: height }, cells: out }
}

// ---------------------------------------------------------------------------
// 共用的读帧
// ---------------------------------------------------------------------------

interface Frame {
  name: string
  data: Buffer
  width: number
  height: number
}

/** 读目录下的图片为帧；文件名（去扩展名）即条目名 */
async function readFrames(dir: string): Promise<Frame[]> {
  const files = (await listFilesRecursive(dir)).filter((f) => IMAGE_EXT.test(f))
  if (files.length === 0) throw new Error(`目录里没有 png/webp：${dir}`)
  const frames: Frame[] = []
  for (const rel of files) {
    const { data, width, height } = await readRgba(join(dir, rel))
    frames.push({ name: rel.replace(IMAGE_EXT, '').replace(/[\\/]/g, '_'), data, width, height })
  }
  return frames
}

// ---------------------------------------------------------------------------
// align
// ---------------------------------------------------------------------------

export interface AlignOutcome extends AlignResult {
  input: string
}

/** 计算对齐落位并报告（只读，不写盘——对齐参数由 pack 消费） */
export async function runAlign(inputDir: string, opts: AlignOptions = {}): Promise<AlignOutcome> {
  const frames = await readFrames(inputDir)
  return { input: inputDir, ...computeAlignPlacements(frames, opts) }
}

// ---------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------

export interface PackOutcome {
  input: string
  outDir: string
  atlas: string
  atlasJson: string
  entryCount: number
  size: { w: number; h: number }
  /** 是否做了地线对齐 */
  aligned: boolean
  /** 回读自产出的 atlas.json（往返自检，确保能被 parseAtlasIndex 读回） */
  roundTripOk: boolean
}

export interface PackRunOptions extends PackLayoutOptions {
  /** 打包前先按地线对齐；false / 省略则按原样放 */
  align?: AlignOptions | false
  /** 输出文件名（不含扩展名）；默认 atlas */
  name?: string
}

/**
 * 打包目录下的图片为图集。
 *
 * 做完会**把自己写的 atlas.json 读回来验一遍**（用运行时的 `parseAtlasIndex`）。
 * 工具链产出必须过得了自家校验，这条不靠"我记得格式是对的"，靠读回来。
 */
export async function runPack(
  inputDir: string,
  outDir: string,
  opts: PackRunOptions = {},
): Promise<PackOutcome> {
  const frames = await readFrames(inputDir)
  const name = opts.name ?? 'atlas'
  const imageName = `${name}.png`

  // 需要对齐时：所有帧统一到公共画布，内容按落位摆放
  let placements: Map<string, { x: number; y: number }> | null = null
  let cellSize: { w: number; h: number } | null = null
  if (opts.align) {
    const aligned = computeAlignPlacements(frames, opts.align)
    placements = new Map(aligned.placements.map((p) => [p.name, { x: p.x, y: p.y }]))
    cellSize = aligned.canvas
  }

  const layoutInput = frames.map((f) => ({
    name: f.name,
    width: cellSize?.w ?? f.width,
    height: cellSize?.h ?? f.height,
  }))
  const layout = planAtlasLayout(layoutInput, opts)

  const canvas = Buffer.alloc(layout.width * layout.height * 4)
  for (const entry of layout.entries) {
    const frame = frames.find((f) => f.name === entry.name)!
    const at = placements?.get(entry.name) ?? { x: 0, y: 0 }
    blit(canvas, layout.width, frame.data, frame.width, frame.height, entry.x + at.x, entry.y + at.y)
  }

  await fs.mkdir(outDir, { recursive: true })
  const atlasPath = join(outDir, imageName)
  const jsonPath = join(outDir, `${name}.json`)
  await sharp(canvas, { raw: { width: layout.width, height: layout.height, channels: 4 } })
    .png()
    .toFile(atlasPath)
  const index = buildAtlasIndex(layout, imageName)
  await fs.writeFile(jsonPath, JSON.stringify(index, null, 2) + '\n', 'utf-8')

  // 往返自检：用运行时的解析器读回来
  const back = parseAtlasIndex(JSON.parse(await fs.readFile(jsonPath, 'utf-8')))
  const roundTripOk = back.ok && back.atlas.frames.length === frames.length

  return {
    input: inputDir,
    outDir,
    atlas: atlasPath,
    atlasJson: jsonPath,
    entryCount: layout.entries.length,
    size: { w: layout.width, h: layout.height },
    aligned: Boolean(opts.align),
    roundTripOk,
  }
}

/** 把一张 RGBA 贴到另一张的 (x, y)；越界部分裁掉，不抛 */
function blit(
  dst: Buffer,
  dstW: number,
  src: Buffer,
  srcW: number,
  srcH: number,
  x: number,
  y: number,
): void {
  const dstH = dst.length / 4 / dstW
  for (let sy = 0; sy < srcH; sy++) {
    const ty = y + sy
    if (ty < 0 || ty >= dstH) continue
    for (let sx = 0; sx < srcW; sx++) {
      const tx = x + sx
      if (tx < 0 || tx >= dstW) continue
      const si = (sy * srcW + sx) * 4
      // src 已由 readRgba 保证是不透明底，alpha 就是它的覆盖度
      if (src[si + 3] === 0) continue
      dst.set(src.subarray(si, si + 4), (ty * dstW + tx) * 4)
    }
  }
}

// ---------------------------------------------------------------------------
// normalize（归一化到目标画布）
// ---------------------------------------------------------------------------

export interface NormalizeOutcome {
  input: string
  outDir: string
  canvas: { w: number; h: number }
  /** 所有帧共用的缩放倍率 */
  scale: number
  count: number
  /** 因缩放或落位而超出画布被裁掉的帧（正常情况应为 0） */
  clipped: string[]
}

/**
 * 把一组图归一化到目标画布：按共同倍率缩放，再按锚点落位。
 *
 * 输出与输入同名、同尺寸（都等于 canvas），供 `pack` 直接打包。
 * 缩放的目标尺寸由`computeNormalize` 按共同倍率算好，所以这里直接用 `fit: fill`
 * （宽高已保比例，再让 sharp 自己 contain 会二次缩放）。落位后超出画布的部分会被裁掉
 * 并记进 `clipped`——那说明 `fit` 太大或素材本身有问题，不该静默丢掉像素。
 */
export async function runNormalize(
  inputDir: string,
  outDir: string,
  opts: NormalizeOptions,
): Promise<NormalizeOutcome> {
  const frames = await readFrames(inputDir)
  const placements = computeNormalize(frames, opts)
  const scale = placements[0]?.scale ?? 1

  await fs.mkdir(outDir, { recursive: true })
  const clipped: string[] = []

  for (const [i, p] of placements.entries()) {
    const src = frames[i]
    // 判"被裁"要看**内容**（包围盒）而不是整张图：缩放后整张图通常远大于画布
    // （四周大片透明留白），拿它比会 8 张全报假警报。真正要紧的是角色本体有没有被切。
    if (p.bbox) {
      const bx0 = p.x + p.bbox.minX * p.scale
      const by0 = p.y + p.bbox.minY * p.scale
      const bx1 = p.x + (p.bbox.maxX + 1) * p.scale
      const by1 = p.y + (p.bbox.maxY + 1) * p.scale
      if (bx0 < -0.5 || by0 < -0.5 || bx1 > opts.canvas.w + 0.5 || by1 > opts.canvas.h + 0.5) {
        clipped.push(p.name)
      }
    }

    const resized = await sharp(src.data, { raw: { width: src.width, height: src.height, channels: 4 } })
      .resize(p.width, p.height, { fit: 'fill', kernel: 'nearest' })
      .raw()
      .toBuffer()

    const canvasBuf = Buffer.alloc(opts.canvas.w * opts.canvas.h * 4)
    blit(canvasBuf, opts.canvas.w, resized, p.width, p.height, p.x, p.y)
    await writeRgbaPng(join(outDir, `${p.name}.png`), canvasBuf, opts.canvas.w, opts.canvas.h)
  }

  return { input: inputDir, outDir, canvas: opts.canvas, scale, count: placements.length, clipped }
}
