#!/usr/bin/env node
/**
 * check-mirror.mjs — #4 左右镜像：只出朝右的图，朝左靠镜像得到
 *
 * 调研文档 §5.3 的思路。对 Shimeji 素材尤其贴切——`PetState` 的注释里逐行写着
 * 「图片中头面向右侧」，也就是**整套图只有一个朝向**。
 *
 * ## 运行时没有翻转能力，所以镜像只能落在打包期
 *
 * 先在渲染层找过：`apps/windows/src/renderer/pet/` 下搜 `flip` / `mirror` / `scale.x` /
 * `facing` **一处都没有**。所以镜像不是一个运行期开关，是**再出一套帧**。
 * 于是成本问题具体化成：图集要翻倍。这里把它量出来。
 *
 * ## 判据必须配负对照
 *
 * 「镜像之后还能用」这句话里藏着一个最容易漏的动作：**多边形也得跟着镜像**。
 * 只翻图不翻命中区，图看着是对的、点击却全落在空处——这是典型的静默故障。
 * 所以本脚本跑三组：
 *   ① 原图  + 原多边形        → 基线覆盖率
 *   ② 镜像图 + **镜像后**多边形 → 应当与基线**完全相等**（对称性）
 *   ③ 镜像图 + **未镜像**多边形 → 负对照，覆盖率应当显著塌掉；塌不掉说明这个检查没劲儿
 *
 * 第 ③ 组不过反而是好消息——它证明这个检查确实能抓到那个错误。
 *
 * 用法：node check-mirror.mjs <宠物包目录> [...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { pointInPolygon } from './_ipc.built.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(REPO, 'package.json'))
const sharp = require('sharp')

const ALPHA = 8

/**
 * 覆盖率：轮廓像素里有多少落在多边形内；顺便量**反过来的错**。
 *
 * 两个方向都要量，因为它们坏在不同地方：
 *   · **漏盖**（轮廓在多边形外）→ 点角色身上没反应，用户看到的是「点了没动静」
 *   · **过盖**（多边形盖在透明区上）→ 角色的空白处吃掉鼠标，窗口**无法穿透**，
 *     违背桌宠「不打扰」的前提。§七 #1 的判据里写着「多边形不盖住角色旁边的透明区」，
 *     但当时只做了目视，没量过。
 */
function coverage(mask, W, H, polys) {
  let total = 0
  let inside = 0
  let covered = 0
  let over = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const solid = mask[y * W + x] === 1
      if (solid) total++
      let hit = false
      for (const p of polys) {
        if (pointInPolygon(x, y, p.points)) {
          hit = true
          break
        }
      }
      if (hit) {
        covered++
        if (solid) inside++
        else over++
      }
    }
  }
  return {
    total,
    inside,
    covered,
    over,
    pct: total ? (inside / total) * 100 : 0,
    overPct: covered ? (over / covered) * 100 : 0,
  }
}

const mirrorPoints = (points, W) => points.map(([x, y]) => [W - 1 - x, y])

async function check(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
  const atlasJson = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf-8'))
  const pngPath = path.join(dir, atlasJson.meta?.image ?? manifest.atlas)
  // ⚠ 清单里 canvas 的键是**小写** `w` / `h`。写成 `const { W, H } = manifest.canvas`
  // 会拿到两个 undefined，于是下面每个循环都一次不跑：掩码全零 → 覆盖率恒等于 0%、
  // 「镜像自反」也变成拿全零跟原图比而恒不相等。**两种失败长得都像被测对象坏了**，
  // 所以这个坑值得留一行注释。
  const W = manifest.canvas.w
  const H = manifest.canvas.h

  // 只量**动画引用到的 base 帧**，不量槽位贴片。
  //
  // 贴片（`face_none` / `face_blush` …）也是图集条目，但它们是**叠加层**、
  // 不是角色轮廓：`face_blush` 只有几十个不透明像素，全在脸上。把它算进覆盖率分母，
  // 「轮廓覆盖率」会从 90% 掉到 74%，而这个数字不表示任何东西——
  // 量的是角色轮廓，就该只喂角色轮廓。
  const usedNames = new Set()
  for (const a of manifest.animations ?? []) {
    for (const f of a.frames ?? []) if (f.base) usedNames.add(f.base)
  }

  // 逐帧解出「画布大小」的 RGBA（图集条目本身就是整张画布）
  const frames = {}
  for (const [name, e] of Object.entries(atlasJson.frames)) {
    if (!usedNames.has(name)) continue
    const b = e.frame ?? e
    const { data } = await sharp(pngPath)
      .extract({ left: b.x, top: b.y, width: b.w, height: b.h })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    frames[name] = data
  }
  const maskOf = (buf) => {
    const m = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) m[i] = buf[i * 4 + 3] > ALPHA ? 1 : 0
    return m
  }
  const mirrorBuf = (buf) => {
    const out = Buffer.alloc(buf.length)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const src = (y * W + (W - 1 - x)) * 4
        const dst = (y * W + x) * 4
        out[dst] = buf[src]
        out[dst + 1] = buf[src + 1]
        out[dst + 2] = buf[src + 2]
        out[dst + 3] = buf[src + 3]
      }
    }
    return out
  }

  const polys = manifest.hitAreas ?? []
  if (polys.length === 0) return { id: manifest.id, skip: '没有 hitAreas，无从验镜像' }

  // ---- A. 镜像自反：mirror(mirror(x)) 必须逐字节等于 x ----
  const probe = Object.values(frames)[0]
  const twice = mirrorBuf(mirrorBuf(probe))
  const identity = twice.equals(probe)

  // ---- B/C. 三组覆盖率 ----
  const mirroredPolys = polys.map((p) => ({ id: p.id, points: mirrorPoints(p.points, W) }))
  let base = 0
  let withMirrored = 0
  let withStale = 0
  let over = 0
  let n = 0
  // 逐帧的总像素数（判「过盖」的分母）
  let coveredAll = 0
  let overAll = 0
  for (const [name, buf] of Object.entries(frames)) {
    const m = maskOf(buf)
    const mm = maskOf(mirrorBuf(buf))
    const a = coverage(m, W, H, polys)
    base += a.pct
    coveredAll += a.covered
    overAll += a.over
    withMirrored += coverage(mm, W, H, mirroredPolys).pct
    withStale += coverage(mm, W, H, polys).pct
    n++
  }
  base /= n
  withMirrored /= n
  withStale /= n
  over = coveredAll ? (overAll / coveredAll) * 100 : 0

  return {
    id: manifest.id,
    frames: n,
    identity,
    base,
    withMirrored,
    withStale,
    over,
    // 图集翻倍的成本：多一套帧就是多一份像素
    atlasBytes: fs.statSync(pngPath).size,
  }
}

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('用法：node check-mirror.mjs <宠物包目录> ...')
  process.exit(2)
}

console.log(
  '宠物包'.padEnd(24) +
    '帧'.padStart(4) +
    '  覆盖  过盖(透明区)  镜像自反  原图覆盖  镜像+镜像多边形  镜像+旧多边形(负对照)',
)
let bad = 0
for (const d of dirs) {
  const r = await check(path.resolve(d))
  if (r.skip) {
    console.log(`${r.id.padEnd(24)}  —  ${r.skip}`)
    continue
  }
  const okSym = Math.abs(r.withMirrored - r.base) < 0.01
  // 负对照的判据：换用旧多边形后覆盖率**必须**掉下来。掉不下来说明这个检查没劲儿——
  // 不是"通过了"，是**测不出**。所以它算不合格，逼着人去看为什么。
  const okNeg = r.withStale < r.base - 5
  const okId = r.identity
  if (!okSym || !okNeg || !okId) bad++
  console.log(
    r.id.padEnd(24) +
      String(r.frames).padStart(4) +
      `  ${r.base.toFixed(1)}%` +
      `  ${r.over.toFixed(1)}%`.padStart(11) +
      `  ${okId ? '✓' : '✗'}        ` +
      `${r.base.toFixed(2)}%`.padStart(8) +
      `  ${r.withMirrored.toFixed(2)}%`.padStart(13) +
      ` ${okSym ? '✓' : '✗'}` +
      `  ${r.withStale.toFixed(2)}%`.padStart(16) +
      ` ${okNeg ? '✓（如预期塌掉）' : '✗（没抓手）'}`,
  )
  console.log(
    `  · 图集 ${(r.atlasBytes / 1024).toFixed(0)} KB；左右两套要 ${((r.atlasBytes * 2) / 1024).toFixed(0)} KB` +
      `（+${(r.atlasBytes / 1024).toFixed(0)} KB）`,
  )
}
console.log(
  bad
    ? `\n✗ ${bad} 个包有问题`
    : '\n✓ 全部通过：镜像自反、命中区随镜像、负对照可分辨',
)
if (bad) process.exitCode = 1
