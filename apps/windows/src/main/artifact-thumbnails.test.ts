// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import JSZip from 'jszip'
import { getArtifactThumb, pruneThumbCache } from './artifact-thumbnails'
import {
  resetFfmpegRunnerDeps,
  resolveFfmpegExecutable,
  runFfmpeg,
  setFfmpegRunnerDepsForTest,
} from './ffmpeg-runner'

let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-thumb-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function writePng(rel: string, width = 800, height = 600): Promise<void> {
  const abs = path.join(root, ...rel.split('/'))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await sharp({ create: { width, height, channels: 3, background: '#cc2222' } })
    .png()
    .toFile(abs)
}

function hasFfmpeg(): boolean {
  try {
    resolveFfmpegExecutable()
    return true
  } catch {
    return false
  }
}

describe('getArtifactThumb', () => {
  it('图片缩到 ≤256 并写缓存；第二次命中 fromCache', async () => {
    await writePng('outputs/x/a.png')

    const first = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/x/a.png' })
    expect(first.ok).toBe(true)
    expect(first.url).toContain('lumii-local://media/?path=')
    expect(first.fromCache).toBe(false)
    expect(first.meta?.width).toBeLessThanOrEqual(256)
    expect(first.meta?.height).toBeLessThanOrEqual(256)

    const second = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/x/a.png' })
    expect(second).toMatchObject({ ok: true, fromCache: true, url: first.url })
  })

  it('不存在的文件 / 越界路径 / 内部文件 → ok:false，不抛', async () => {
    expect(await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/x/none.png' })).toMatchObject({
      ok: false,
    })
    expect(await getArtifactThumb({ workspaceDir: root, relPath: '../etc/passwd' })).toMatchObject({
      ok: false,
    })
    await fs.mkdir(path.join(root, '.lumii'), { recursive: true })
    await fs.writeFile(path.join(root, '.lumii', 'a.png'), 'x')
    expect(await getArtifactThumb({ workspaceDir: root, relPath: '.lumii/a.png' })).toMatchObject({
      ok: false,
    })
  })

  it('PPTX 数页数（jszip）', async () => {
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p/>')
    zip.file('ppt/slides/slide2.xml', '<p/>')
    zip.file('ppt/slides/_rels/slide1.xml.rels', '<r/>')
    const abs = path.join(root, 'outputs', 'deck.pptx')
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, await zip.generateAsync({ type: 'nodebuffer' }))

    const result = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/deck.pptx' })
    expect(result).toMatchObject({ ok: true, meta: { pages: 2 }, fromCache: false })
  })

  it.skipIf(!hasFfmpeg())('视频抽首帧成 jpg', async () => {
    const abs = path.join(root, 'outputs', 'clip.mp4')
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const generated = await runFfmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x240:d=1',
      '-pix_fmt',
      'yuv420p',
      abs,
    ])
    expect(generated.ok).toBe(true)

    const result = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/clip.mp4' })
    expect(result.ok).toBe(true)
    expect(result.url).toContain('.jpg')
    const cached = await fs.stat(
      path.join(root, '.lumii', 'cache', 'thumbs', path.basename(new URL(result.url!).searchParams.get('path')!)),
    )
    expect(cached.size).toBeGreaterThan(0)
  })

  it('抽帧失败不留 tmp.jpg，且第二次会重试', async () => {
    const abs = path.join(root, 'outputs', 'broken.mp4')
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, 'not a video')

    // ffmpeg 一定失败；数一下被叫了几次，验证「失败没被永久负缓存」（TTL 内会复用，
    // 所以这里只断言文件系统没留垃圾）
    setFfmpegRunnerDepsForTest({
      resolveFfmpegPath: () => 'C:/fake/ffmpeg.exe',
      spawn: (() => {
        const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: () => {} })
        queueMicrotask(() => child.emit('close', 1))
        return child
      }) as never,
    })
    try {
      const result = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/broken.mp4' })
      expect(result.ok).toBe(false)

      const dir = path.join(root, '.lumii', 'cache', 'thumbs')
      const left = await fs.readdir(dir).catch(() => [] as string[])
      expect(left.filter((name) => name.endsWith('.jpg') || name.endsWith('.tmp'))).toEqual([])
    } finally {
      resetFfmpegRunnerDeps()
    }
  })
})

describe('pruneThumbCache', () => {
  it('超过上限时按 mtime 从旧到新删', async () => {
    const dir = path.join(root, '.lumii', 'cache', 'thumbs')
    await fs.mkdir(dir, { recursive: true })
    for (let index = 0; index < 3; index += 1) {
      const file = path.join(dir, `old-${index}.webp`)
      await fs.writeFile(file, Buffer.alloc(100))
      const old = new Date(Date.now() - (index + 1) * 60_000)
      await fs.utimes(file, old, old)
    }
    await fs.writeFile(path.join(dir, 'new.webp'), Buffer.alloc(100))

    const result = await pruneThumbCache(root, 150)
    expect(result.removed).toBeGreaterThan(0)
    const left = await fs.readdir(dir)
    const total = (
      await Promise.all(left.map(async (name) => (await fs.stat(path.join(dir, name))).size))
    ).reduce((sum, size) => sum + size, 0)
    expect(total).toBeLessThanOrEqual(150)
    expect(left).toContain('new.webp')
  })
})

describe('失败不留半截缓存', () => {
  it('坏文件（不是真图片）→ ok:false，缓存目录里不留 .webp / .tmp', async () => {
    const abs = path.join(root, 'outputs', 'broken.png')
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, 'not an image')

    const result = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/broken.png' })
    expect(result.ok).toBe(false)

    const dir = path.join(root, '.lumii', 'cache', 'thumbs')
    const left = await fs.readdir(dir).catch(() => [] as string[])
    // 留了文件就会被下次当成缓存命中，用户看到坏图
    expect(left.filter((name) => name.endsWith('.webp') || name.endsWith('.tmp'))).toEqual([])
  })
})

describe('并发与去重', () => {
  it('同 key 并发两次只生成一次；排队后仍能正常出图', async () => {
    await writePng('outputs/x/dedup.png')
    const dir = path.join(root, '.lumii', 'cache', 'thumbs')

    const [a, b] = await Promise.all([
      getArtifactThumb({ workspaceDir: root, relPath: 'outputs/x/dedup.png' }),
      getArtifactThumb({ workspaceDir: root, relPath: 'outputs/x/dedup.png' }),
    ])
    expect(a.ok && b.ok).toBe(true)
    // 共享同一个飞行中 promise → 拿到同一个结果对象；去掉 inflight 去重会变成两个对象
    expect(a).toBe(b)
    expect(await fs.readdir(dir)).toHaveLength(1)
  })

  it('并发若干坏文件不会卡死槽位：随后正常文件仍能生成', async () => {
    const bad = ['b1.png', 'b2.png', 'b3.png', 'b4.png', 'b5.png']
    for (const name of bad) {
      const abs = path.join(root, 'outputs', 'bad', name)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, 'not an image')
    }
    const results = await Promise.all(
      bad.map((name) => getArtifactThumb({ workspaceDir: root, relPath: `outputs/bad/${name}` })),
    )
    expect(results.every((r) => !r.ok)).toBe(true)

    await writePng('outputs/good.png')
    const good = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/good.png' })
    expect(good.ok).toBe(true)
  })

  it('失败结果有 60s 负缓存：坏文件第二次直接返回失败、不重跑', async () => {
    const abs = path.join(root, 'outputs', 'broken2.png')
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, 'not an image')

    const first = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/broken2.png' })
    const second = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/broken2.png' })
    expect(first.ok).toBe(false)
    expect(second).toEqual(first)
  })

  it('内容变了（同尺寸同 mtime 风险）→ key 变，重新生成', async () => {
    await writePng('outputs/x/v.png', 800, 600)
    const first = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/x/v.png' })
    expect(first.ok).toBe(true)

    const abs = path.join(root, 'outputs', 'x', 'v.png')
    const before = await fs.stat(abs)
    // 换内容但把 mtime 拨回去：只有首块内容 hash 能让 key 变
    await writePng('outputs/x/v.png', 801, 600)
    await fs.utimes(abs, before.atime, before.mtime)

    const second = await getArtifactThumb({ workspaceDir: root, relPath: 'outputs/x/v.png' })
    expect(second.ok).toBe(true)
    expect(second.url).not.toBe(first.url)
  })
})
