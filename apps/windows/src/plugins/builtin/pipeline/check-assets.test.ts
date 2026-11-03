/**
 * `content-to-assets/check-assets.cjs` 的两条判据。
 *
 * 这个脚本守的是**"图真的能用"**，不是"文件存在"：
 * - 尺寸必须从 PNG 头读，不信 agent 写的 COVER.txt（那是它自己的说法）；
 * - 大小阈值直接比字节，不用 `find -size +10k`（Git Bash 下按 1024 字节块向上取整，
 *   9120B 的文件会被判成"小于 10k"，2026-11-03 真机就因此报了 IMAGES=0）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'bundled-pipelines', 'content-to-assets', 'check-assets.cjs',
)

/** 造一张合法 PNG；`bytes` 不足 MIN_BYTES 时用随机像素撑大 */
function makePng(file: string, w: number, h: number, noise = false): void {
  const row = (y: number) => {
    const px = Buffer.alloc(w * 3)
    if (noise) for (let i = 0; i < px.length; i++) px[i] = (i * 31 + y * 17) & 0xff
    else px.fill(0x80)
    return Buffer.concat([Buffer.from([0]), px])
  }
  const raw = Buffer.concat(Array.from({ length: h }, (_, y) => row(y)))
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-assets-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** 跑脚本，返回 {code, out}；非零退出不抛 */
function run(extra: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, dir, ...extra], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('check-assets', () => {
  it('正例：2 张配图 + 3:4 封面 → 通过', () => {
    makePng(path.join(dir, 'img1.png'), 1024, 1536, true)
    makePng(path.join(dir, 'img2.png'), 1024, 1536, true)
    makePng(path.join(dir, 'cover.png'), 768, 1024, true)
    const r = run()
    expect(r.out).toContain('IMAGES=3')
    expect(r.out).toContain('COVER=cover.png 768x1024')
    expect(r.out).toContain('COVER_RATIO=ok')
    expect(r.code).toBe(0)
  })

  it('**小文件不算数**：9KB 的图在 Git Bash 的 `-size +10k` 下会被误判，这里必须按字节', () => {
    makePng(path.join(dir, 'img1.png'), 1024, 1536) // 单色 → 压缩后极小
    makePng(path.join(dir, 'img2.png'), 1024, 1536)
    makePng(path.join(dir, 'cover.png'), 768, 1024, true)
    const r = run()
    // 断言的是"两张配图都不够大"，不写死 IMAGES=0——cover 是噪声图，压缩后可能刚好过线
    expect(r.out).toMatch(/IMAGES=\d+/)
    const n = Number(/IMAGES=(\d+)/.exec(r.out)?.[1] ?? -1)
    expect(n).toBeLessThan(2)
    expect(r.out).toContain('可用配图不足 2 张')
    expect(r.code).toBe(1)
  })

  it('**封面尺寸从 PNG 头读，不信 COVER.txt**', () => {
    makePng(path.join(dir, 'img1.png'), 1024, 1536, true)
    makePng(path.join(dir, 'img2.png'), 1024, 1536, true)
    makePng(path.join(dir, 'cover.png'), 1024, 1024, true)
    // agent 声称是对的——必须被无视
    fs.writeFileSync(path.join(dir, 'COVER.txt'), 'cover.png 768x1024')
    const r = run()
    expect(r.out).toContain('COVER=cover.png 1024x1024')
    expect(r.out).toContain('封面实测 1024x1024')
    expect(r.code).toBe(1)
  })

  it('没有封面文件 → 失败', () => {
    makePng(path.join(dir, 'img1.png'), 1024, 1536, true)
    makePng(path.join(dir, 'img2.png'), 1024, 1536, true)
    const r = run()
    expect(r.out).toContain('没有 cover.* 封面文件')
    expect(r.code).toBe(1)
  })

  it('目录不存在 → 失败，不静默通过', () => {
    const r = run([])
    fs.rmSync(dir, { recursive: true, force: true })
    const r2 = run()
    expect(r.code === 0 || r2.code === 1).toBe(true)
    expect(r2.out).toContain('图片目录不存在')
  })
})
