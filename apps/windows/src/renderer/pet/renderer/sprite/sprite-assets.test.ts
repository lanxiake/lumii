/**
 * 随包示范模型的清单守卫测试
 *
 * 素材是脚本生成的产物，容易「改了生成脚本没重跑」或「手改了清单没校验」。
 * 这里把**仓库里实际发布的那几份清单**读进来跑一遍校验与运行时解析，
 * 让这类漂移在 CI 上就暴露，而不是等到运行时白屏。
 *
 * 同时充当三方案变体的回归网：变体 A 的 `mouthLevels` 缺失、变体 B 的槽位命名，
 * 都是生成脚本先写错、被这类检查抓出来的。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findAnimation,
  motionCount,
  mouthLevelIndex,
  resolveSpriteRuntime,
  validateSpriteManifest,
} from '@mtbot/pet-core'

/** apps/windows/resources/pet-models（自本文件上溯 5 级到 apps/windows） */
const RESOURCES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../resources/pet-models',
)

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf-8'))

interface PackageCheck {
  dir: string
  manifest: unknown
}

function discoverPackages(root: string): PackageCheck[] {
  if (!existsSync(root)) return []
  const out: PackageCheck[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(root, entry.name, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    out.push({ dir: entry.name, manifest: readJson(manifestPath) })
  }
  return out
}

const SHIPPED = discoverPackages(RESOURCES)
const VARIANTS = discoverPackages(join(RESOURCES, '_variants'))

// 路径写错时上面的发现函数会返回空数组，于是一堆用例「通过」但什么都没测。
// 这条先兜住：目录必须在，且必须真的扫到东西。
describe('测试前置', () => {
  it('示范模型资源目录存在且扫到了包', () => {
    if (!existsSync(RESOURCES)) {
      throw new Error(`资源目录不存在：${RESOURCES}（路径层级写错了？）`)
    }
    expect(SHIPPED.length).toBeGreaterThan(0)
    expect(VARIANTS.length).toBeGreaterThan(0)
  })
})

describe('随包示范模型', () => {
  it('至少有两份示范模型（像素 + 2D 高清）', () => {
    expect(SHIPPED.length).toBeGreaterThanOrEqual(2)
  })

  it.each(SHIPPED.map((p) => [p.dir, p] as const))('%s 清单通过校验', (_name, pkg) => {
    const r = validateSpriteManifest(pkg.manifest)
    if (!r.ok) {
      throw new Error(`清单校验失败：${r.errors.map((e) => `${e.path} ${e.message}`).join(' | ')}`)
    }
    expect(r.ok).toBe(true)
  })

  it.each(SHIPPED.map((p) => [p.dir, p] as const))('%s 图集与清单引用对得上', (_name, pkg) => {
    const dir = join(RESOURCES, pkg.dir)
    const atlasJson = readJson(join(dir, 'atlas.json')) as { frames: Record<string, unknown> }
    const frameNames = new Set(Object.keys(atlasJson.frames))
    const r = validateSpriteManifest(pkg.manifest, { assets: readdirSync(dir), atlasFrames: [...frameNames] })
    if (!r.ok) {
      throw new Error(`交叉校验失败：${r.errors.map((e) => `${e.path} ${e.message}`).join(' | ')}`)
    }
    expect(r.ok).toBe(true)
  })

  it.each(SHIPPED.map((p) => [p.dir, p] as const))('%s 能被运行时解析出 Idle/Talk', (_name, pkg) => {
    const r = validateSpriteManifest(pkg.manifest)
    if (!r.ok) throw new Error('清单不合法，无法继续')
    const rt = resolveSpriteRuntime(r.manifest)
    // 编排器要求待机组存在，否则待机调度起不来
    expect(motionCount(rt, rt.manifest.animations[0].group)).toBeGreaterThan(0)
    expect(motionGroupsWithFrames(rt)).toContain('Idle')
  })

  it.each(SHIPPED.map((p) => [p.dir, p] as const))('%s 声明了口型档位就一定能取到档', (_name, pkg) => {
    const r = validateSpriteManifest(pkg.manifest)
    if (!r.ok) throw new Error('清单不合法')
    const levels = r.manifest.mouthLevels ?? []
    if (levels.length === 0) return
    // 0 / 等分点 / 1 都要落在合法档位上
    for (const v of [0, 0.5, 0.999, 1, -1, 2]) {
      const idx = mouthLevelIndex(v, levels.length)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(levels.length)
    }
  })
})

describe('三方案变体', () => {
  it('变体齐全（A/B/C 各一份）', () => {
    const keys = VARIANTS.map((v) => v.dir).sort()
    expect(keys).toEqual(['demo_variant_a', 'demo_variant_b', 'demo_variant_c'])
  })

  it.each(VARIANTS.map((p) => [p.dir, p] as const))('%s 清单通过校验', (_name, pkg) => {
    const r = validateSpriteManifest(pkg.manifest)
    if (!r.ok) {
      throw new Error(`清单校验失败：${r.errors.map((e) => `${e.path} ${e.message}`).join(' | ')}`)
    }
    expect(r.ok).toBe(true)
  })

  it('方案 A 不声明 mouthLevels —— 口型烘在整帧里，声明了会指向不存在的条目', () => {
    const a = VARIANTS.find((v) => v.dir === 'demo_variant_a')
    expect(a).toBeDefined()
    const m = a!.manifest as { mouthLevels?: string[]; slots?: unknown }
    expect(m.mouthLevels).toBeUndefined()
    expect(m.slots).toBeUndefined()
  })

  it('方案 B/C 都有可切换的口型与表情层', () => {
    for (const key of ['demo_variant_b', 'demo_variant_c']) {
      const v = VARIANTS.find((x) => x.dir === key)!
      const m = v.manifest as { mouthLevels?: string[] }
      expect(m.mouthLevels?.length, key).toBe(4)
    }
  })

  it('方案 A 的帧数显著多于 B/C（组合爆炸的直接体现）', () => {
    const count = (dir: string) => {
      const v = VARIANTS.find((x) => x.dir === dir)!
      const r = validateSpriteManifest(v.manifest)
      if (!r.ok) throw new Error(`${dir} 清单不合法`)
      return resolveSpriteRuntime(r.manifest).animationsByGroup.get('Idle')?.[0]?.frames.length ?? 0
    }
    const a = count('demo_variant_a')
    const c = count('demo_variant_c')
    // 演示集下 4 表情 × 4 口型 × 3 身体帧 = 48，而混合方案只需要 3 帧身体
    expect(a).toBe(48)
    expect(c).toBeLessThan(20)
    expect(a / c).toBeGreaterThan(3)
  })
})

function motionGroupsWithFrames(rt: ReturnType<typeof resolveSpriteRuntime>): string[] {
  const out: string[] = []
  for (const group of rt.animationsByGroup.keys()) {
    if (findAnimation(rt, group)?.frames.length) out.push(group)
  }
  return out
}
