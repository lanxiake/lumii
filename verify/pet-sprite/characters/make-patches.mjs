#!/usr/bin/env node
/**
 * make-patches.mjs — #3 情绪贴片：程序化画出来的表情标记，不单独生图
 *
 * 调研文档 §5.4。原意是「别为每种表情单独出一张图」——一个模型 12 种表情
 * 就要 12 批出图，成本是动作数的好几倍。
 *
 * ## 落点：把贴片装进**表情槽**，渲染器一行不用改
 *
 * 渲染器的槽位绑定（`bindMouthAndExpression`）只认名字在
 * `EYES_NAMES = ['eyes','eye','expression','face']` 里的类别，绑定之后
 * `setExpression(emotionMap[tag])` 就能切它。所以只要把贴片槽的类别命名成 `face`，
 * **现有的 `emotionMap → setExpression` 那条路直接就通了**，不需要新 API。
 *
 * 这对**扁平模型**（Shimeji 那种整帧画、没有独立面部层的）尤其合适：
 * 它们永远不会有原生表情，贴片是唯一能给出「情绪可见变化」的手段。
 * 而有面部层的模型（樱桃）不用这条路——它的 `face.eyes` 已经是原生表情了。
 *
 * ## 位置从 hitAreas 推，不是写死的坐标
 *
 * 贴片要贴在脸上，而「脸在哪」这件事模型自己已经声明过了——就是 `HitAreaHead`
 * 那个多边形。拿它的包围盒当中枢，贴片按相对比例摆放，于是**换一只宠物不用改一行**。
 * 写死 (x, y) 的话，每换一套素材都要重调一遍，而且调错了没人看得出来。
 *
 * ## 零生成
 *
 * 贴片全部是 SVG 画的几何图形（椭圆、折线、星形），由 sharp 栅格化。
 * 不调任何生图模型，所以这一条**不受出图能力约束**——想加多少种就加多少种。
 *
 * 用法：node make-patches.mjs <宠物包目录> [--no-install]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runPetAssetOp } from './_ipc.built.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(REPO, 'package.json'))
const sharp = require('sharp')

const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--'))
const install = !args.includes('--no-install')
if (!dir) {
  console.error('用法：node make-patches.mjs <宠物包目录> [--no-install]')
  process.exit(2)
}

async function op(name, a) {
  const r = await runPetAssetOp({ op: name, args: a })
  if (!r.ok) throw new Error(`${name} 失败：${r.error}`)
  return r.result
}

/**
 * 贴片清单。`at` 是相对**头部包围盒**的比例坐标：
 *   (0,0) = 头框左上  (1,1) = 头框右下，允许超出（汗滴要飞在头外面）
 * `s` 是尺寸，同样按头框宽高取比例。
 */
const PATCHES = [
  { name: 'face_none', draw: () => '' },
  {
    name: 'face_blush',
    draw: () => `
      <ellipse cx="0.22" cy="0.72" rx="0.15" ry="0.10" fill="#ff6b8a" opacity="0.55"/>
      <ellipse cx="0.78" cy="0.72" rx="0.15" ry="0.10" fill="#ff6b8a" opacity="0.55"/>`,
  },
  {
    name: 'face_sparkle',
    draw: () => `
      ${star(0.86, 0.06, 0.20, '#ffd94a')}
      ${star(1.04, 0.28, 0.12, '#fff2a8')}
      ${star(0.02, 0.16, 0.10, '#fff2a8')}`,
  },
  {
    name: 'face_sweat',
    draw: () => `
      <path d="M 0.94 0.10 C 1.06 0.26 1.10 0.34 1.02 0.40 C 0.94 0.46 0.86 0.36 0.90 0.24 Z"
            fill="#7fd4ff" opacity="0.9" stroke="#3aa6dd" stroke-width="0.02"/>`,
  },
  {
    name: 'face_anger',
    draw: () => `
      <g stroke="#ff4d4d" stroke-width="0.075" stroke-linecap="round" fill="none">
        <path d="M 0.14 0.02 L 0.30 0.18 M 0.30 0.02 L 0.14 0.18"/>
        <path d="M 0.20 0.10 L 0.24 0.22"/>
      </g>`,
  },
  {
    name: 'face_heart',
    draw: () => `
      <path d="M 0.90 0.02 C 0.84 -0.08 0.72 0.00 0.76 0.10 C 0.80 0.20 0.90 0.26 0.90 0.26
               C 0.90 0.26 1.00 0.20 1.04 0.10 C 1.08 0.00 0.96 -0.08 0.90 0.02 Z"
            fill="#ff5c8a" opacity="0.92"/>`,
  },
]

/** 四角星：中心 (cx,cy)，半径 r */
function star(cx, cy, r, fill) {
  const k = r * 0.28 // 腰部收得多细
  const pts = [
    [cx, cy - r],
    [cx + k, cy - k],
    [cx + r, cy],
    [cx + k, cy + k],
    [cx, cy + r],
    [cx - k, cy + k],
    [cx - r, cy],
    [cx - k, cy - k],
  ]
  return `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${fill}"/>`
}

// ---------------------------------------------------------------------------

const manifestPath = path.join(dir, 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
const W = manifest.canvas.w
const H = manifest.canvas.h

const head = (manifest.hitAreas ?? []).find((a) => /head/i.test(a.id))
if (!head) throw new Error('清单里没有 HitAreaHead——贴片没有可依附的位置。先跑 hitAreas')
const hx = head.points.map((p) => p[0])
const hy = head.points.map((p) => p[1])
const hb = {
  x0: Math.min(...hx),
  x1: Math.max(...hx),
  y0: Math.min(...hy),
  y1: Math.max(...hy),
}
const hw = hb.x1 - hb.x0 + 1
const hh = hb.y1 - hb.y0 + 1
console.log(`${manifest.id}：画布 ${W}×${H}，头框 ${hw}×${hh} @ (${hb.x0},${hb.y0})`)

// 把图集里已有条目解出来，跟贴片一起重新打包
const atlasJson = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf-8'))
const png = path.join(dir, atlasJson.meta?.image ?? manifest.atlas)
const work = path.join(
  process.env.HOME ?? process.env.USERPROFILE,
  '.lumii',
  'workspace',
  'outputs',
  `patches-${manifest.id}`,
)
fs.rmSync(work, { recursive: true, force: true })
const parts = path.join(work, 'parts')
fs.mkdirSync(parts, { recursive: true })

const existing = []
for (const [name, e] of Object.entries(atlasJson.frames)) {
  const b = e.frame ?? e
  await sharp(png)
    .extract({ left: b.x, top: b.y, width: b.w, height: b.h })
    .png()
    .toFile(path.join(parts, `${name}.png`))
  existing.push(name)
}

const svgFor = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
  `<g transform="translate(${hb.x0},${hb.y0}) scale(${hw},${hh})">${body}</g></svg>`

for (const p of PATCHES) {
  const body = p.draw()
  const buf = body
    ? await sharp(Buffer.from(svgFor(body))).png().toBuffer()
    : await sharp({
        create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer()
  fs.writeFileSync(path.join(parts, `${p.name}.png`), buf)
}
console.log(`  贴片 ${PATCHES.length} 个（${PATCHES.map((p) => p.name).join(' ')}）`)

const pkgDir = path.join(work, 'pkg')
const packed = await op('pack', { dir: parts, outDir: pkgDir, name: 'atlas' })
console.log(`  图集 ${packed.size.w}×${packed.size.h}，${packed.entryCount} 条`)

// ---- 清单：加 face 槽 + 每帧声明它 ----
manifest.slots = {
  ...(manifest.slots ?? {}),
  // 类别必须叫 `face`（或 eyes/eye/expression）：那是渲染器认表情层的白名单
  face: { kind: 'layered', at: [0, 0], parts: { face: PATCHES.map((p) => p.name) } },
}
for (const a of manifest.animations ?? []) {
  for (const f of a.frames ?? []) {
    // 每帧都声明：不声明的话这一层保持上一次的纹理，
    // 切动作时上一段的贴片会挂在脸上不走
    f.face = { face: 'face_none' }
  }
}
fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

// ---- pet.json：emotionMap 把情绪名映到贴片下标 ----
const petPath = path.join(dir, 'pet.json')
const pet = JSON.parse(fs.readFileSync(petPath, 'utf-8'))
const idx = (n) => PATCHES.findIndex((p) => p.name === n)
pet.emotionMap = {
  neutral: idx('face_none'), 平静: idx('face_none'), 默认: idx('face_none'),
  joy: idx('face_sparkle'), 开心: idx('face_sparkle'), 高兴: idx('face_sparkle'),
  兴奋: idx('face_sparkle'), 微笑: idx('face_sparkle'), smile: idx('face_sparkle'),
  shy: idx('face_blush'), 害羞: idx('face_blush'), 脸红: idx('face_blush'),
  不好意思: idx('face_blush'), blush: idx('face_blush'),
  fear: idx('face_sweat'), 担心: idx('face_sweat'), 紧张: idx('face_sweat'),
  无奈: idx('face_sweat'), 尴尬: idx('face_sweat'), worried: idx('face_sweat'),
  anger: idx('face_anger'), 生气: idx('face_anger'), 不满: idx('face_anger'),
  愤怒: idx('face_anger'),
  love: idx('face_heart'), 喜欢: idx('face_heart'), 亲昵: idx('face_heart'),
  撒娇: idx('face_heart'),
}
fs.writeFileSync(path.join(pkgDir, 'pet.json'), JSON.stringify(pet, null, 2))

const v = await op('validate', { dir: pkgDir })
if (!v.ok) throw new Error(`校验不过：${JSON.stringify(v.errors)}`)
console.log('  ✓ validate 通过')

for (const f of ['manifest.json', 'atlas.png', 'atlas.json', 'pet.json']) {
  fs.copyFileSync(path.join(pkgDir, f), path.join(dir, f))
}
console.log(`  已写回 ${path.relative(REPO, dir)}`)

if (install) {
  // `op()` 已经解包过一层：拿到的是 install 命令的 result，形状 `{ok, validation, plan, install}`。
  // **不要再读 `inst.result.ok`**——那是双重解包，会稳定抛 TypeError。
  // 这个 bug 长期没暴露，是因为调用方一直带着 `--no-install`。
  const inst = await op('install', { dir: pkgDir })
  if (!inst.ok) throw new Error(`安装失败：${inst.error ?? JSON.stringify(inst.validation?.errors)}`)
  console.log('  已装到用户宠物目录')
}
console.log(`\n✓ ${manifest.id}：表情槽 ${PATCHES.length} 档，emotionMap ${Object.keys(pet.emotionMap).length} 个别名`)
