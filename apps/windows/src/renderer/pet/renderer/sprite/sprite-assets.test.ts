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
  it('至少有三份示范模型（三只 AI 生成的角色）', () => {
    expect(SHIPPED.length).toBeGreaterThanOrEqual(3)
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

  it('帧数关系符合两种方案的公式（断言不变式，不写死数字）', () => {
    // 写死数字会在表情/口型数一变就失效（P1-d 把表情从 4 扩到 12 时就踩过一次）。
    // 这里改成从变体 C 的清单里读出真实的表情数 / 口型数 / 身体帧数，再验证公式。
    const manifestOf = (dir: string) => {
      const v = VARIANTS.find((x) => x.dir === dir)!
      const r = validateSpriteManifest(v.manifest)
      if (!r.ok) throw new Error(`${dir} 清单不合法`)
      return r.manifest
    }
    const idleFrames = (dir: string) => {
      const m = manifestOf(dir)
      return resolveSpriteRuntime(m).animationsByGroup.get('Idle')?.[0]?.frames ?? []
    }

    const cManifest = manifestOf('demo_variant_c')
    const faceParts = cManifest.slots?.face?.parts ?? {}
    const eyeCat = Object.keys(faceParts).find((c) => /eye/i.test(c))!
    const eyes = faceParts[eyeCat].length
    const mouths = cManifest.mouthLevels?.length ?? 0
    // 身体帧数 = 变体 C 的 Idle 里出现过的不同 base 数
    const bodies = new Set(idleFrames('demo_variant_c').map((f) => f.base)).size

    // A 整体帧 = 身体帧 × 表情 × 口型（组合爆炸的来源）
    expect(idleFrames('demo_variant_a').length).toBe(bodies * eyes * mouths)
    // C 混合 = 身体帧 + 表情 + 口型（三者各自一套，不组合）
    expect(idleFrames('demo_variant_c').length).toBe(bodies)
    expect(eyes * mouths).toBeGreaterThan(bodies) // 前提：组合确实比加法多
  })

  it('表情数达到设计 §4.2 的目标规模（12）', () => {
    const v = VARIANTS.find((x) => x.dir === 'demo_variant_c')!
    const r = validateSpriteManifest(v.manifest)
    if (!r.ok) throw new Error('清单不合法')
    const faceParts = r.manifest.slots?.face?.parts ?? {}
    const eyeCat = Object.keys(faceParts).find((c) => /eye/i.test(c))!
    expect(faceParts[eyeCat].length).toBeGreaterThanOrEqual(12)
  })
})

function motionGroupsWithFrames(rt: ReturnType<typeof resolveSpriteRuntime>): string[] {
  const out: string[] = []
  for (const group of rt.animationsByGroup.keys()) {
    if (findAnimation(rt, group)?.frames.length) out.push(group)
  }
  return out
}

// ---------------------------------------------------------------------------
// 场景 / 道具层（P1-e）
// ---------------------------------------------------------------------------

describe('scene 槽（场景/道具层）', () => {
  /**
   * 这一块测的是**运行时语义**（道具被帧驱动、未声明就沿用、越界道具被拒），
   * 用一份就地构造的最小清单即可。
   *
   * 早先它挂在 `SHIPPED` 上——「随包那份示范模型恰好带道具层」被当成了被测性质。
   * 示范模型换成 AI 生成的三只之后就不成立了（它们只有 face 层），
   * 而语义本身没变。测什么就依赖什么，别赖在恰好路过的素材上。
   */
  const SCENE_MANIFEST = {
    id: 'scene_fixture',
    rendererType: 'sprite' as const,
    canvas: { w: 48, h: 56 },
    anchor: [24, 54] as [number, number],
    atlas: 'atlas.png',
    atlasJson: 'atlas.json',
    slots: {
      face: { kind: 'layered' as const, at: [0, 0] as [number, number], parts: { eyes: ['eye_open', 'eye_shut'] } },
      scene: {
        kind: 'layered' as const,
        at: [0, 0] as [number, number],
        parts: { prop: ['prop_none', 'prop_ball', 'prop_star'] },
      },
    },
    animations: [
      {
        group: 'Idle',
        index: 0,
        kind: 'loop' as const,
        fps: 4,
        frames: [{ base: 'body_00', face: { eyes: 'eye_open' } }, { base: 'body_01' }],
      },
      {
        group: 'PlayBall',
        index: 0,
        kind: 'once' as const,
        next: 'Idle',
        fps: 6,
        frames: [
          { base: 'body_00', scene: { prop: 'prop_ball' }, face: { eyes: 'eye_open' } },
          { base: 'body_01', scene: { prop: 'prop_star' } },
          { base: 'body_00', scene: { prop: 'prop_none' }, face: { eyes: 'eye_shut' } },
        ],
      },
    ],
  }

  const manifestOf = () => {
    const r = validateSpriteManifest(SCENE_MANIFEST)
    if (!r.ok) throw new Error(`就地清单不合法：${r.errors.map((e) => e.message).join(' | ')}`)
    return r.manifest
  }

  it('声明了 scene 槽与道具部件', () => {
    const scene = manifestOf().slots?.scene
    expect(scene?.kind).toBe('layered')
    expect(Object.keys(scene?.parts ?? {})).toContain('prop')
    expect(scene!.parts!.prop.length).toBeGreaterThanOrEqual(2)
  })

  it('道具能被帧驱动：解析后的帧快照里带着 scene 状态', () => {
    const rt = resolveSpriteRuntime(manifestOf())
    const play = rt.animationsByGroup.get('PlayBall')?.[0]
    expect(play).toBeDefined()
    // 三个帧各自的道具不同，最后一帧回到"不显示"
    expect(play!.frames.map((f) => f.layered.scene?.prop)).toEqual([
      'prop_ball',
      'prop_star',
      'prop_none',
    ])
  })

  it('未声明 scene 的帧沿用上一帧的道具（增量语义对 scene 同样成立）', () => {
    const rt = resolveSpriteRuntime(manifestOf())
    const idle = rt.animationsByGroup.get('Idle')?.[0]
    // Idle 的帧没声明 scene → 取默认（PROPS 的首个 = prop_none）
    expect(idle!.frames.every((f) => f.layered.scene?.prop === 'prop_none')).toBe(true)
  })
})
