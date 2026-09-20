import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { runCutout, runInstall, runValidate } from './commands.js'
import { listFilesRecursive, readJson } from './io.js'
import { colorDistance, type RGB } from './cutout.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pet-asset-cmd-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const MAGENTA: RGB = [217, 33, 143]
const INK: RGB = [40, 40, 48]

const ATLAS_JSON = {
  frames: {
    idle_00: { frame: { x: 0, y: 0, w: 32, h: 32 } },
    idle_01: { frame: { x: 32, y: 0, w: 32, h: 32 } },
    m0: { frame: { x: 64, y: 0, w: 16, h: 16 } },
    m1: { frame: { x: 80, y: 0, w: 16, h: 16 } },
  },
  meta: { image: 'atlas.png', size: { w: 96, h: 32 } },
}

const MANIFEST = {
  id: 'demo_cat',
  rendererType: 'sprite',
  pixelArt: true,
  canvas: { w: 32, h: 32 },
  anchor: [16, 30],
  atlas: 'atlas.png',
  atlasJson: 'atlas.json',
  animations: [
    { group: 'Idle', index: 0, kind: 'loop', fps: 8, frames: [{ base: 'idle_00' }, { base: 'idle_01' }] },
  ],
  mouthLevels: ['m0', 'm1'],
}

/** 画一张图集：方块区域为角色，其余为底色（withAlpha=false）或透明（true） */
async function makeAtlas(withAlpha: boolean): Promise<Buffer> {
  const w = 96
  const h = 32
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inBlock = (x >= 2 && x < 30 && y >= 2 && y < 30) || (x >= 34 && x < 62 && y >= 2 && y < 30)
      const inMouth = x >= 66 && x < 78 && y >= 8 && y < 24
      if (inBlock || inMouth) {
        buf[i] = INK[0]
        buf[i + 1] = INK[1]
        buf[i + 2] = INK[2]
        buf[i + 3] = 255
      } else if (withAlpha) {
        buf[i + 3] = 0
      } else {
        buf[i] = MAGENTA[0]
        buf[i + 1] = MAGENTA[1]
        buf[i + 2] = MAGENTA[2]
        buf[i + 3] = 255
      }
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
}

interface PackageOptions {
  manifest?: unknown
  withAlpha?: boolean
  pet?: unknown
  /** 是否写入 atlas.json（false 时文件名保持但内容缺失） */
  skipAtlasJson?: boolean
  dirName?: string
}

async function makePackage(opts: PackageOptions = {}): Promise<string> {
  const dir = join(root, opts.dirName ?? 'pkg')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(opts.manifest ?? MANIFEST, null, 2))
  if (!opts.skipAtlasJson) {
    await fs.writeFile(join(dir, 'atlas.json'), JSON.stringify(ATLAS_JSON, null, 2))
  }
  await fs.writeFile(join(dir, 'atlas.png'), await makeAtlas(opts.withAlpha ?? true))
  if (opts.pet !== undefined) {
    await fs.writeFile(join(dir, 'pet.json'), JSON.stringify(opts.pet, null, 2))
  }
  return dir
}

describe('runValidate', () => {
  it('完整包通过', async () => {
    const r = await runValidate(await makePackage())
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.manifest?.id).toBe('demo_cat')
  })

  it('缺少清单时只报这个错，不连带报一堆下游错误', async () => {
    const dir = join(root, 'empty')
    await fs.mkdir(dir, { recursive: true })
    const r = await runValidate(dir)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.message.includes('缺少清单文件'))).toBe(true)
  })

  it('清单是坏 JSON 时报错而不抛', async () => {
    const dir = join(root, 'badjson')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'manifest.json'), '{ 坏')
    const r = await runValidate(dir)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.message.includes('JSON'))).toBe(true)
  })

  it('未抠底时报错并指向 cutout', async () => {
    const r = await runValidate(await makePackage({ withAlpha: false }))
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.message).join('\n')).toContain('cutout')
  })

  it('帧引用在图集里不存在时报错', async () => {
    const r = await runValidate(
      await makePackage({
        manifest: {
          ...MANIFEST,
          animations: [{ group: 'Idle', kind: 'loop', frames: [{ base: '不存在' }] }],
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.message.includes('图集中不存在条目'))).toBe(true)
  })

  it('图集索引缺失时跳过帧校验但仍能通过结构校验', async () => {
    const r = await runValidate(await makePackage({ skipAtlasJson: true }))
    // atlas.json 文件不存在 → 由 assets 交叉校验报出来
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.path === 'atlasJson')).toBe(true)
  })

  it('回传图集尺寸与最小 alpha，便于作者确认抠底情况', async () => {
    const r = await runValidate(await makePackage())
    expect(r.atlasInfo?.width).toBe(96)
    expect(r.atlasInfo?.height).toBe(32)
    expect(r.atlasInfo?.minAlpha).toBe(0)
    expect(r.atlasInfo?.hasTransparency).toBe(true)
  })
})

describe('runInstall', () => {
  it('校验通过才安装，并写注册表', async () => {
    const pkg = await makePackage({ pet: { name: '像素猫', scale: 1 } })
    const target = join(root, 'user')
    const r = await runInstall(pkg, target)

    expect(r.ok).toBe(true)
    expect(r.install?.installedDir).toBe(join(target, 'demo_cat'))
    const reg = await readJson(join(target, 'registry.json'))
    const models = (reg.value as { models: { id: string; name: string; rendererType: string }[] }).models
    expect(models[0]).toMatchObject({ id: 'demo_cat', name: '像素猫', rendererType: 'sprite' })
    expect((reg.value as { defaultModelId: string }).defaultModelId).toBe('demo_cat')
  })

  it('校验不通过时一个字节都不写', async () => {
    const pkg = await makePackage({ withAlpha: false })
    const target = join(root, 'user')
    const r = await runInstall(pkg, target)

    expect(r.ok).toBe(false)
    expect(r.validation.errors.length).toBeGreaterThan(0)
    // 目标目录根本没被创建
    await expect(fs.access(target)).rejects.toThrow()
  })

  it('重复安装同 id 覆盖旧版本，不留备份', async () => {
    const target = join(root, 'user')
    await runInstall(await makePackage({ dirName: 'v1', pet: { name: '旧名' } }), target)
    await runInstall(await makePackage({ dirName: 'v2', pet: { name: '新名' } }), target)

    const reg = await readJson(join(target, 'registry.json'))
    const models = (reg.value as { models: { name: string }[] }).models
    expect(models).toHaveLength(1)
    expect(models[0].name).toBe('新名')
    expect(await fs.readdir(target)).toEqual(expect.arrayContaining(['demo_cat', 'registry.json']))
    expect((await fs.readdir(target)).filter((n) => n.startsWith('.'))).toEqual([])
  })

  it('安装不会碰用户手写的其它模型条目', async () => {
    const target = join(root, 'user')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(
      join(target, 'registry.json'),
      JSON.stringify({
        version: 2,
        models: [{ id: '手写的', name: '手写的', rendererType: 'live2d', modelUrl: 'x.model3.json' }],
        defaultModelId: '手写的',
      }),
    )
    await runInstall(await makePackage(), target)
    const reg = await readJson(join(target, 'registry.json'))
    const models = (reg.value as { models: { id: string }[] }).models
    expect(models.map((m) => m.id)).toEqual(['手写的', 'demo_cat'])
    expect((reg.value as { defaultModelId: string }).defaultModelId).toBe('手写的')
  })
})

describe('runCutout', () => {
  it('抠掉底色、还原 alpha，并自动识别出底色', async () => {
    const input = join(root, 'raw.png')
    const output = join(root, 'out.png')
    await fs.writeFile(input, await makeAtlas(false))

    const r = await runCutout(input, output)

    expect(r.backgroundSource).toBe('estimated')
    expect(colorDistance(r.background, MAGENTA)).toBeLessThan(12)
    expect(r.bbox).not.toBeNull()
    expect(r.residualRatio).toBeLessThan(0.01)

    const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]
    // 夹具：两块角色在 x∈[2,30) 与 x∈[34,62)，y∈[2,30)
    expect(alphaAt(0, 0)).toBe(0) // 角落：原底色
    expect(alphaAt(95, 16)).toBe(0) // 右侧留白：原底色
    expect(alphaAt(16, 16)).toBe(255) // 第一块角色中心
    expect(alphaAt(45, 16)).toBe(255) // 第二块角色中心
  })

  it('显式背景色优先于自动估计', async () => {
    const input = join(root, 'raw.png')
    const output = join(root, 'out.png')
    await fs.writeFile(input, await makeAtlas(false))
    const r = await runCutout(input, output, { bg: '#d9218f' })
    expect(r.backgroundSource).toBe('explicit')
    expect(r.background).toEqual(MAGENTA)
  })

  it('背景色格式非法时明确报错', async () => {
    const input = join(root, 'raw.png')
    await fs.writeFile(input, await makeAtlas(false))
    await expect(runCutout(input, join(root, 'o.png'), { bg: '洋红' })).rejects.toThrow('背景色格式不合法')
  })

  it('整图都是底色时报告部件报废', async () => {
    const input = join(root, 'flat.png')
    const output = join(root, 'flat-out.png')
    const w = 32
    const h = 32
    const buf = Buffer.alloc(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      buf[i * 4] = MAGENTA[0]
      buf[i * 4 + 1] = MAGENTA[1]
      buf[i * 4 + 2] = MAGENTA[2]
      buf[i * 4 + 3] = 255
    }
    await fs.writeFile(input, await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer())

    const r = await runCutout(input, output)
    expect(r.bbox).toBeNull()
    expect(r.warnings.join('\n')).toContain('报废')
  })
})

describe('listFilesRecursive 与包读取的配合', () => {
  it('包内文件列表用于交叉校验', async () => {
    const pkg = await makePackage()
    const files = await listFilesRecursive(pkg)
    expect(files).toEqual(['atlas.json', 'atlas.png', 'manifest.json'])
  })
})
