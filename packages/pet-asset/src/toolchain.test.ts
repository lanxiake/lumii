import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { parseAtlasIndex, validateSpriteManifest } from '@mtbot/pet-core'
import { runSlice, runAlign, runPack } from './toolchain.js'
import { listFilesRecursive } from './io.js'
import { alphaBBox } from './cutout.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pet-asset-toolchain-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * 造一张「直出图集」：2×2 四格，每格一个方块，**垂直位置各不相同**。
 * 这正是真实直出图集的问题——角色一致但取景不统一，所以对齐必须有东西可做。
 */
async function makeSheet(cell = 32): Promise<string> {
  const W = cell * 2
  const buf = Buffer.alloc(W * W * 4)
  const put = (x: number, y: number, rgb: [number, number, number]) => {
    const i = (y * W + x) * 4
    buf[i] = rgb[0]
    buf[i + 1] = rgb[1]
    buf[i + 2] = rgb[2]
    buf[i + 3] = 255
  }
  const blocks: { cx: number; cy: number; rgb: [number, number, number] }[] = [
    { cx: 8, cy: 6, rgb: [200, 40, 40] },
    { cx: 40, cy: 12, rgb: [40, 200, 40] },
    { cx: 8, cy: 44, rgb: [40, 40, 200] },
    { cx: 40, cy: 50, rgb: [200, 200, 40] },
  ]
  for (const b of blocks) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) put(b.cx + x, b.cy + y, b.rgb)
  }
  const p = join(root, 'sheet.png')
  await sharp(buf, { raw: { width: W, height: W, channels: 4 } }).png().toFile(p)
  return p
}

describe('runSlice', () => {
  it('按网格切出四格并落盘', async () => {
    const sheet = await makeSheet()
    const outDir = join(root, 'parts')
    const r = await runSlice(sheet, outDir, { cols: 2, rows: 2 })

    expect(r.source).toEqual({ w: 64, h: 64 })
    expect(r.cells).toHaveLength(4)
    expect(await listFilesRecursive(outDir)).toEqual([
      'sheet_r0c0.png',
      'sheet_r0c1.png',
      'sheet_r1c0.png',
      'sheet_r1c1.png',
    ])
  })

  it('每格的内容确实是该格（用颜色认）', async () => {
    const sheet = await makeSheet()
    const outDir = join(root, 'parts')
    await runSlice(sheet, outDir, { cols: 2, rows: 2 })

    const read = async (f: string) =>
      (await sharp(join(outDir, f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data
    // 左上格应有红块、右上格绿块
    const tl = await read('sheet_r0c0.png')
    const tr = await read('sheet_r0c1.png')
    const hasColor = (d: Buffer, rgb: [number, number, number]) => {
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - rgb[0]) < 12 && Math.abs(d[i + 1] - rgb[1]) < 12 && Math.abs(d[i + 2] - rgb[2]) < 12) return true
      }
      return false
    }
    expect(hasColor(tl, [200, 40, 40])).toBe(true)
    expect(hasColor(tr, [40, 200, 40])).toBe(true)
  })
})

describe('runAlign（只读）', () => {
  it('四格的底边被对齐到同一条线', async () => {
    const sheet = await makeSheet()
    const partsDir = join(root, 'parts')
    await runSlice(sheet, partsDir, { cols: 2, rows: 2 })

    const r = await runAlign(partsDir, { baseline: 'bottom' })
    expect(r.alignedCount).toBe(4)

    const bottoms = new Set<number>()
    for (const p of r.placements) {
      expect(p.bbox).not.toBeNull()
      bottoms.add(p.y + p.bbox!.maxY)
    }
    // 对齐后所有底边收敛到同一个值
    expect(bottoms.size).toBe(1)
  })

  it('不对齐时底边是散的（证明上一条不是白给）', async () => {
    const sheet = await makeSheet()
    const partsDir = join(root, 'parts')
    await runSlice(sheet, partsDir, { cols: 2, rows: 2 })

    // 直接读原始切片，底边互不相同
    const bottoms = new Set<number>()
    for (const f of await listFilesRecursive(partsDir)) {
      const { data, info } = await sharp(join(partsDir, f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      bottoms.add(alphaBBox(data, info.width, info.height)!.maxY)
    }
    expect(bottoms.size).toBeGreaterThan(1)
  })
})

describe('runPack', () => {
  it('打包并往返自检通过', async () => {
    const sheet = await makeSheet()
    const partsDir = join(root, 'parts')
    await runSlice(sheet, partsDir, { cols: 2, rows: 2 })

    const outDir = join(root, 'pkg')
    const r = await runPack(partsDir, outDir, { align: {} })
    expect(r.entryCount).toBe(4)
    expect(r.roundTripOk).toBe(true)
    expect(r.aligned).toBe(true)
    expect(await listFilesRecursive(outDir)).toEqual(['atlas.json', 'atlas.png'])
  })

  it('产出的图集能被清单校验认下（工具链产出必须过得了自家校验）', async () => {
    const sheet = await makeSheet()
    const partsDir = join(root, 'parts')
    await runSlice(sheet, partsDir, { cols: 2, rows: 2 })
    const outDir = join(root, 'pkg')
    await runPack(partsDir, outDir, { align: {} })

    const atlasJson = JSON.parse(await fs.readFile(join(outDir, 'atlas.json'), 'utf-8'))
    const parsed = parseAtlasIndex(atlasJson)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // 用图集条目真的能拼出一份合法清单
    const names = parsed.atlas.frames.map((f) => f.name)
    const manifest = {
      id: 'packed_demo',
      rendererType: 'sprite',
      canvas: { w: 32, h: 32 },
      anchor: [16, 30],
      atlas: 'atlas.png',
      atlasJson: 'atlas.json',
      animations: [{ group: 'Idle', kind: 'loop', fps: 8, frames: names.map((n) => ({ base: n })) }],
    }
    const v = validateSpriteManifest(manifest, {
      assets: await listFilesRecursive(outDir),
      atlasFrames: names,
    })
    if (!v.ok) {
      throw new Error(`清单校验失败：${v.errors.map((e) => `${e.path} ${e.message}`).join(' | ')}`)
    }
    expect(v.ok).toBe(true)
  })

  it('不对齐时按原样放（各帧保持自己的尺寸）', async () => {
    const sheet = await makeSheet()
    const partsDir = join(root, 'parts')
    await runSlice(sheet, partsDir, { cols: 2, rows: 2 })
    const outDir = join(root, 'pkg2')
    const r = await runPack(partsDir, outDir)
    expect(r.aligned).toBe(false)
    expect(r.roundTripOk).toBe(true)
    // 四格等大；默认每行最多 8 格，所以排成一行 4×32 = 128 宽
    expect(r.size).toEqual({ w: 128, h: 32 })
  })

  it('空目录报错而不是产出空图集', async () => {
    const emptyDir = join(root, 'empty')
    await fs.mkdir(emptyDir, { recursive: true })
    await expect(runPack(emptyDir, join(root, 'out'))).rejects.toThrow()
  })
})
