/**
 * pet-asset-ipc 单元测试
 *
 * 这里守两件事：
 *  1. **写入边界**——工具链有写盘操作，而 Agent 侧的写权限按设计只到 `workspace/outputs/`。
 *     越界必须在进工具链之前就被拒。
 *  2. **端点契约**——参数缺失、op 未知、工具链内部报错，都要包成 `{ ok: false, error }`
 *     而不是抛出去（与其它路由的约定一致）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import {
  allowedWriteRoots,
  isAllowedWritePath,
  isPetAssetOp,
  runPetAssetOp,
} from './pet-asset-ipc'
import { setActiveWorkspaceDirGetter, _resetActiveWorkspaceDirGetterForTest } from '../workspace-paths'

let root: string
let savedPetDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pet-asset-ipc-'))
  setActiveWorkspaceDirGetter(() => root)
  // 用户宠物目录也指到临时区，别碰到真实配置
  savedPetDir = process.env.PET_MODELS_DIR
  process.env.PET_MODELS_DIR = join(root, 'pet-models')
})

afterEach(() => {
  _resetActiveWorkspaceDirGetterForTest()
  if (savedPetDir === undefined) delete process.env.PET_MODELS_DIR
  else process.env.PET_MODELS_DIR = savedPetDir
  rmSync(root, { recursive: true, force: true })
})

describe('isPetAssetOp', () => {
  /**
   * 这份清单要**跟着 `pet-asset-ipc.ts` 的 `OPS` 走**。
   *
   * 此前它只列了最早的六个，后面加的 `normalize` / `sheetPlan` / `sheetCheck` /
   * `diffLayer` 一个都没覆盖，名字还写着「六个」——看着像全的，其实是快照。
   * 新增 op 时这里要一起加，否则新 op 的形状没有任何测试兜着。
   */
  it('认得注册表里的全部 op', () => {
    for (const op of [
      'validate',
      'install',
      'cutout',
      'slice',
      'align',
      'normalize',
      'pack',
      'sheetPlan',
      'sheetCheck',
      'diffLayer',
      'hitAreas',
      'idlePin',
    ]) {
      expect(isPetAssetOp(op)).toBe(true)
    }
  })
  it('其它一律不认', () => {
    for (const v of ['', 'rm', 'exec', 1, null, undefined, {}]) {
      expect(isPetAssetOp(v)).toBe(false)
    }
  })
})

describe('isAllowedWritePath — 写入边界', () => {
  it('workspace/outputs 之内放行', () => {
    expect(isAllowedWritePath(join(root, 'outputs', 'a.png'))).toBe(true)
    expect(isAllowedWritePath(join(root, 'outputs', 'deep', 'nested', 'b.png'))).toBe(true)
    expect(isAllowedWritePath(join(root, 'outputs'))).toBe(true)
  })

  it('用户宠物目录之内放行（install 的法定落点）', () => {
    expect(isAllowedWritePath(join(root, 'pet-models', 'mycat'))).toBe(true)
  })

  it('workspace 里但不在 outputs 之下 → 拒绝', () => {
    // 设计 §5.1：Agent 只能写 workspace/outputs/，工作区其它位置不开
    expect(isAllowedWritePath(join(root, 'wiki', 'x.json'))).toBe(false)
    expect(isAllowedWritePath(join(root, 'a.png'))).toBe(false)
  })

  it('上跳绕过 → 拒绝（校验在 resolve 之后做前缀比对）', () => {
    expect(isAllowedWritePath(join(root, 'outputs', '..', '..', 'escape.png'))).toBe(false)
    expect(isAllowedWritePath(join(root, 'outputs', '..', 'wiki', 'x'))).toBe(false)
  })

  it('完全无关的路径 → 拒绝', () => {
    expect(isAllowedWritePath(resolve(tmpdir(), 'elsewhere', 'x.png'))).toBe(false)
  })

  it('非字符串 / 空 / 含 NUL → 拒绝', () => {
    expect(isAllowedWritePath(undefined)).toBe(false)
    expect(isAllowedWritePath(123)).toBe(false)
    expect(isAllowedWritePath('')).toBe(false)
    expect(isAllowedWritePath(join(root, 'outputs', 'a\u0000b.png'))).toBe(false)
  })

  it('与 outputs 同前缀但不同目录（outputs-evil）→ 拒绝', () => {
    // 前缀比对要带分隔符，否则 outputs-evil 会被当成 outputs 的子路径
    expect(isAllowedWritePath(join(root, 'outputs-evil', 'x.png'))).toBe(false)
  })

  it('allowedWriteRoots 报出两个根，供技能决定输出落点', () => {
    const roots = allowedWriteRoots()
    expect(roots).toHaveLength(2)
    expect(roots[0]).toBe(join(root, 'outputs'))
    expect(roots[1]).toBe(join(root, 'pet-models'))
  })
})

describe('runPetAssetOp — 参数与错误契约', () => {
  it('未知 op 报错而不是抛', async () => {
    const r = await runPetAssetOp({ op: 'rm' as never })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未知 op')
  })

  it('缺参数时报错', async () => {
    expect((await runPetAssetOp({ op: 'validate' })).ok).toBe(false)
    expect((await runPetAssetOp({ op: 'slice', args: { input: 'x' } })).ok).toBe(false)
    expect((await runPetAssetOp({ op: 'cutout', args: { input: 'x' } })).ok).toBe(false)
  })

  it('输出路径越界时**在进工具链之前**就拒', async () => {
    const outside = join(root, 'wiki', 'out.png')
    const r = await runPetAssetOp({ op: 'cutout', args: { input: 'whatever.png', output: outside } })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('输出路径不在允许范围内')
  })

  it('slice 与 pack 的输出目录同样受限', async () => {
    const bad = join(root, 'wiki', 'out')
    expect((await runPetAssetOp({ op: 'slice', args: { input: 'x.png', outDir: bad } })).ok).toBe(false)
    expect((await runPetAssetOp({ op: 'pack', args: { dir: 'x', outDir: bad } })).ok).toBe(false)
  })

  it('工具链内部报错被包成 ok:false，不抛出去', async () => {
    // 目录不存在 → runValidate 内部会报出来
    const r = await runPetAssetOp({ op: 'validate', args: { dir: join(root, '不存在') } })
    expect(r.ok).toBe(false)
    expect(typeof r.error === 'string').toBe(true)
  })
})

describe('runPetAssetOp — 真实闭环', () => {
  /** 造一个最小可用包：一张 16×16 的图集 + 索引 + 清单 */
  async function makePackage(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer()
    await fs.writeFile(join(dir, 'atlas.png'), png)
    await fs.writeFile(
      join(dir, 'atlas.json'),
      JSON.stringify({ frames: { f0: { frame: { x: 0, y: 0, w: 8, h: 8 } } }, meta: { image: 'atlas.png', size: { w: 16, h: 16 } } }),
    )
    await fs.writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'ipc_demo',
        rendererType: 'sprite',
        canvas: { w: 8, h: 8 },
        anchor: [4, 7],
        atlas: 'atlas.png',
        atlasJson: 'atlas.json',
        animations: [{ group: 'Idle', kind: 'loop', frames: [{ base: 'f0' }] }],
      }),
    )
  }

  it('validate 通过合法包', async () => {
    const pkg = join(root, 'pkg')
    await makePackage(pkg)
    const r = await runPetAssetOp({ op: 'validate', args: { dir: pkg } })
    if (!r.ok) throw new Error(`应当通过：${r.error}`)
    expect((r.result as { ok: boolean }).ok).toBe(true)
  })

  it('install 把包装进用户宠物目录并写注册表', async () => {
    const pkg = join(root, 'pkg')
    await makePackage(pkg)
    const r = await runPetAssetOp({ op: 'install', args: { dir: pkg } })
    if (!r.ok) throw new Error(`应当成功：${r.error}`)
    const installed = (r.result as { install?: { installedDir: string } }).install
    expect(installed?.installedDir).toBe(join(root, 'pet-models', 'ipc_demo'))
    const reg = JSON.parse(await fs.readFile(join(root, 'pet-models', 'registry.json'), 'utf-8'))
    expect(reg.models.map((m: { id: string }) => m.id)).toContain('ipc_demo')
  })

  it('pack 产出能被 validate 认下的图集（工具链自洽）', async () => {
    // 先造两张待打包的图。**必须带透明区**——P0-a 的安装校验会拒绝"未抠底"的图集，
    // 第一版夹具用了全不透明的图，validate 正确地把它挡下来了。
    const partsDir = join(root, 'outputs', 'parts')
    await fs.mkdir(partsDir, { recursive: true })
    for (const [i, rgb] of [
      [0, [200, 40, 40]],
      [1, [40, 200, 40]],
    ] as const) {
      const buf = Buffer.alloc(8 * 8 * 4)
      for (let y = 2; y < 6; y++) {
        for (let x = 2; x < 6; x++) {
          const o = (y * 8 + x) * 4
          buf[o] = rgb[0]
          buf[o + 1] = rgb[1]
          buf[o + 2] = rgb[2]
          buf[o + 3] = 255
        }
      }
      const png = await sharp(buf, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer()
      await fs.writeFile(join(partsDir, `f${i}.png`), png)
    }

    const outDir = join(root, 'outputs', 'packed')
    const packed = await runPetAssetOp({ op: 'pack', args: { dir: partsDir, outDir } })
    if (!packed.ok) throw new Error(`打包应当成功：${packed.error}`)
    expect((packed.result as { roundTripOk: boolean }).roundTripOk).toBe(true)

    // 把产物补成完整包再校验
    await fs.writeFile(
      join(outDir, 'manifest.json'),
      JSON.stringify({
        id: 'packed_demo',
        rendererType: 'sprite',
        canvas: { w: 8, h: 8 },
        anchor: [4, 7],
        atlas: 'atlas.png',
        atlasJson: 'atlas.json',
        animations: [{ group: 'Idle', kind: 'loop', frames: [{ base: 'f0' }, { base: 'f1' }] }],
      }),
    )
    const v = await runPetAssetOp({ op: 'validate', args: { dir: outDir } })
    if (!v.ok) throw new Error(`校验应当通过：${v.error}`)
    expect((v.result as { ok: boolean }).ok).toBe(true)
  })
})
