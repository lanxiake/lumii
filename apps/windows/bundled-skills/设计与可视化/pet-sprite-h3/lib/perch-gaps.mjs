#!/usr/bin/env node
/**
 * perch-gaps.mjs — 从**装好之后的图集**量出攀附几何（`manifest.perchGaps`）
 *
 * ## 这两个数是什么
 *
 * `pet-core` 的 `PerchConfig` 要的是「**锚点到接触面的距离 ÷ 画布高**」：
 *
 * | 字段 | 含义 | 谁用 | 量法 |
 * | --- | --- | --- | --- |
 * | `wall` | 锚点到 **CLIMB 内容墙侧边**的距离 | `wallX` / `screenWallX` | `(climb.x1 − anchor[0]) / canvas.h` |
 * | `ceiling` | 锚点到 **CRAWL 内容贴天花板那条边**的距离 | `ceilingY` | `(anchor[1] − crawl.y0) / canvas.h` |
 *
 * 乘上 `modelHeight = canvas.h × scale` 就是屏幕像素，于是「内容的那条边正好落在
 * 墙面/天花板上」。推导见 `packages/pet-core/src/behavior/perch.ts`。
 *
 * `wall` 量的是**右边**（`x1`），因为整套攀附几何假定**素材面朝右**——
 * `flipForPerch` 就是按这个假定写的。素材若反过来画，这里也得跟着改。
 *
 * ## 为什么必须量「装好的」，不能量源表
 *
 * 画布坐标空间是**归一化之后**才有的：倍率 = `canvas.h × 0.94 / 组内最高包围盒`，
 * 而「组」是帧尺寸相同的格。在源表上算等于把 `computeNormalize` 再抄一遍——
 * 抄错不报错，只表现为宠物贴不到墙。装好的图集是唯一的既成事实。
 *
 * ## 为什么不能省（不能靠 `PERCH_DEFAULTS` 兜底）
 *
 * 兜底值 `0.43 / 0.99` 是 **Shimeji 那套素材的实测值**，成立的前提是
 * "CLIMB 内容贴着格的墙侧边、CRAWL 内容贴着格的顶边"——那位作者画的时候就那么摆。
 * H3 出的素材按**重心**对齐、内容在格中央，同一组比例套上去，实测团子
 * **离墙 20px、离天花板 45px**：看着不是"贴着墙爬"而是"悬在那儿被电梯带上去"。
 *
 * ⚠ **「CRAWL 素材有没有倒挂」在这里量不出来，别试着猜。** 归一化把内容**底边对齐到锚点**，
 * 所以不管素材是正是反，装完之后 `crawl.y1 ≈ anchor[1]` 都成立、`ceiling` 也是同一个数
 * （实测团子翻与不翻都是 0.5647）。翻转改变的是**内容里角色的朝向**，不是包围盒。
 * 所以朝向只能由生产侧声明——`install-pet.mjs` 的 `ACTIONS[].invertY`。
 *
 * 用法：
 *   node perch-gaps.mjs <宠物包目录> [--write]
 */

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

/** 与引擎/工具一致的判据阈值（16 会把抗锯齿边缘也算进去） */
const ALPHA_THRESHOLD = 128

/** 单一动作组的并集包围盒（画布坐标）。帧尺寸相同的格才算同一组 */
function groupBounds(sheet, atlas, names) {
  let x0 = Infinity
  let x1 = -1
  let y0 = Infinity
  let y1 = -1
  for (const name of names) {
    const fr = atlas.frames[name]?.frame
    if (!fr) throw new Error(`图集索引里没有 ${name}`)
    let hit = false
    // 从**整幅 raw** 里切片，不要每帧 `sharp(atlas.png).extract()` ——
    // 那样每帧都要把 15MB 的图集解一遍，16 帧就是 16 次全解码（实测几十秒）
    for (let y = 0; y < fr.h; y++) {
      let p = ((fr.y + y) * sheet.w + fr.x) * sheet.ch + 3
      for (let x = 0; x < fr.w; x++, p += sheet.ch) {
        if (sheet.data[p] <= ALPHA_THRESHOLD) continue
        hit = true
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    if (!hit) throw new Error(`图集条目 ${name} 整格透明——空了`)
  }
  return { x0, x1, y0, y1 }
}

/**
 * 量一个宠物包的攀附几何。
 *
 * @returns `null` = 这个模型没有攀附动作组（Live2D 与多数 2D 模型都没有），
 *          调用方不该据此报错；否则 `{ wall, ceiling, warnings, detail }`
 */
export async function measurePerchGaps(pkgDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'manifest.json'), 'utf-8'))
  const atlasPath = path.join(pkgDir, manifest.atlasJson ?? 'atlas.json')
  if (!fs.existsSync(atlasPath) || !fs.existsSync(path.join(pkgDir, manifest.atlas ?? 'atlas.png'))) {
    throw new Error(`${pkgDir} 里没有图集（${manifest.atlas} / ${manifest.atlasJson}）`)
  }
  const atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf-8'))

  const framesOf = (group) =>
    (manifest.animations ?? []).find((a) => a.group === group)?.frames?.map((f) => f.base) ?? []
  const climbNames = framesOf('Climb')
  const crawlNames = framesOf('Crawl')
  // **两组都要有**才量得出完整的攀附几何：只有一组时另一个数没有依据，
  // 宁可让它去走兜底值，也不要凭一组编出另一组。
  if (!climbNames.length || !crawlNames.length) return null

  const { canvas, anchor } = manifest
  const { data, info } = await sharp(path.join(pkgDir, manifest.atlas ?? 'atlas.png'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const sheet = { data, w: info.width, h: info.height, ch: info.channels }
  const climb = groupBounds(sheet, atlas, climbNames)
  const crawl = groupBounds(sheet, atlas, crawlNames)

  const round4 = (v) => Number(v.toFixed(4))
  const wall = round4((climb.x1 - anchor[0]) / canvas.h)
  const ceiling = round4((anchor[1] - crawl.y0) / canvas.h)

  const warnings = []
  if (wall <= 0) {
    warnings.push(
      `CLIMB 内容整体落在锚点左边（x1=${climb.x1} ≤ 锚点 ${anchor[0]}）——` +
        `素材多半是**面朝左**画的，而整套攀附几何假定面朝右（见 perch.ts 的 flipForPerch）`,
    )
  }
  if (wall > 1 || ceiling > 1) {
    warnings.push(`比例超过 1（wall=${wall} ceiling=${ceiling}）——留白比画布还高，切图或锚点算错了`)
  }

  return {
    wall,
    ceiling,
    warnings,
    detail: { climb, crawl, anchor, canvas },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('perch-gaps.mjs')
if (isMain) {
  const args = process.argv.slice(2)
  const dir = args.find((a) => !a.startsWith('--'))
  const write = args.includes('--write')
  if (!dir) {
    console.error('用法：node perch-gaps.mjs <宠物包目录> [--write]')
    process.exit(2)
  }
  const pkgDir = path.resolve(dir)
  const r = await measurePerchGaps(pkgDir)
  if (!r) {
    console.log(`${pkgDir} 没有 Climb/Crawl 两组，不需要 perchGaps`)
    process.exit(0)
  }
  const { climb, crawl, anchor, canvas } = r.detail
  // scale 在 pet.json 里（manifest 没有它）。缺了就不报像素，只报比例
  const petPath = path.join(pkgDir, 'pet.json')
  const scale = fs.existsSync(petPath) ? Number(JSON.parse(fs.readFileSync(petPath, 'utf-8')).scale) : 0
  console.log(
    `${pkgDir}  画布 ${canvas.w}×${canvas.h}  锚点 (${anchor[0]}, ${anchor[1]})` +
      (scale ? `  scale ${scale}` : ''),
  )
  console.log(`  CLIMB 并集 x[${climb.x0},${climb.x1}] y[${climb.y0},${climb.y1}]`)
  console.log(`  CRAWL 并集 x[${crawl.x0},${crawl.x1}] y[${crawl.y0},${crawl.y1}]`)
  console.log(`  → perchGaps = { wall: ${r.wall}, ceiling: ${r.ceiling} }`)
  if (scale) {
    // **把比例翻成屏幕像素再说一遍**：比例本身看不出对错，像素看得出。
    // modelHeight = 画布高 × scale，就是渲染器眼里"这只宠物多高"。
    const modelH = canvas.h * scale
    console.log(
      `  modelHeight ${modelH.toFixed(1)}px → 爬墙时锚点离墙 ${(r.wall * modelH).toFixed(1)}px、` +
        `内容高 ${((climb.y1 - climb.y0) * scale).toFixed(1)}px；` +
        `爬天花板时锚点在上沿下 ${(r.ceiling * modelH).toFixed(1)}px、` +
        `内容高 ${((crawl.y1 - crawl.y0) * scale).toFixed(1)}px（贴着的那条边落在 0）`,
    )
  }
  for (const w of r.warnings) console.log(`  ⚠ ${w}`)
  if (write) {
    const p = path.join(pkgDir, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(p, 'utf-8'))
    m.perchGaps = { wall: r.wall, ceiling: r.ceiling }
    fs.writeFileSync(p, JSON.stringify(m, null, 2))
    console.log(`  ✓ 已写入 ${p}`)
  }
}
