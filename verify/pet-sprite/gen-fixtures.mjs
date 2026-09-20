#!/usr/bin/env node
/**
 * gen-fixtures.mjs — 技术验证素材生成（验证计划 T1）
 *
 * 用途：为验证点 A（抠底/切片/对齐）、B（程序化原语）、C（运行时合成）生成可复现的
 * 测试素材。**不依赖任何外部图片**，全部程序化产出，保证同参数同结果。
 *
 * 关键设计（对应验证计划 T1 的「关键设计」）：
 *  1. 底色 = 品红 + 逐像素噪声 —— 模拟 AI 出图的不均匀底，而非理想纯色
 *  2. 角色上刻意保留一个与底色**很接近**的部位（内耳/鼻头，距离见启动日志）——
 *     用来暴露抠底算法的容差边界。容差过松会吃掉内耳，过紧会残留底色
 *  3. 角色用 SVG 栅格化，**保留抗锯齿** —— 真实 AI 出图边缘是渐变的，
 *     朴素色键会在边缘留下色晕。这是验证点 A1 要抓的核心问题
 *
 * 产出（默认写入 ./fixtures/）：
 *  - char-magenta.png   256×256  角色部件图，不透明底（模拟 AI 直出）
 *  - char-alpha.png     256×256  真值图：同 SVG 透明底，抠底精度的度量基准
 *  - sheet-4x4.png      128×128  4×4 网格图集源图，带 alpha（模拟手绘图集）
 *  - parts/*.png                 分层部件：body / eye-open / eye-closed / mouth-0..3
 *
 * 用法：node verify/pet-sprite/gen-fixtures.mjs
 */

import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

/** 默认随机种子：固定值保证可复现 */
const DEFAULT_SEED = 20260920

// ---------------------------------------------------------------------------
// 确定性 PRNG —— 绝不能用 Math.random()，否则素材每次不同，验证结论不可复现
// ---------------------------------------------------------------------------

/** mulberry32：小而快的确定性 PRNG */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

// ---------------------------------------------------------------------------
// 配色
// ---------------------------------------------------------------------------

/** 品红底色（模拟 AI 出图的「纯色」底，实际带噪声） */
const BG = [0xd9, 0x21, 0x8f]
/** 容差陷阱色：刻意贴近底色，放在内耳与鼻头 */
const TRAP = [0xe8, 0x44, 0x9a]
/** 角色主体色 */
const BODY = [0xe8, 0xa3, 0x3d]
/** 描边色 */
const INK = [0x3a, 0x2e, 0x2a]

const rgb = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

/** 欧氏色彩距离（0–441），用于量化「陷阱色离底色多近」 */
function colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

// ---------------------------------------------------------------------------
// 噪声底
// ---------------------------------------------------------------------------

/**
 * 生成带噪声的不透明底色。
 * @param {number} w 宽
 * @param {number} h 高
 * @param {number[]} base 基色 RGB
 * @param {number} amp 单通道噪声幅度（±amp）
 * @param {() => number} rnd 确定性随机源
 */
function noisyBackground(w, h, base, amp, rnd) {
  const buf = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const n = () => (rnd() * 2 - 1) * amp
    buf[i * 4 + 0] = clamp255(base[0] + n())
    buf[i * 4 + 1] = clamp255(base[1] + n())
    buf[i * 4 + 2] = clamp255(base[2] + n())
    buf[i * 4 + 3] = 255
  }
  return buf
}

// ---------------------------------------------------------------------------
// 角色 SVG
// ---------------------------------------------------------------------------

/** 一只猫。内耳与鼻头用 TRAP 色（抠底容差陷阱），边缘靠 librsvg 抗锯齿 */
const CAT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <g stroke="${rgb(INK)}" stroke-width="6" stroke-linejoin="round">
    <ellipse cx="128" cy="168" rx="64" ry="54" fill="${rgb(BODY)}"/>
    <path d="M92 62 L86 24 L120 46 Z" fill="${rgb(BODY)}"/>
    <path d="M164 62 L170 24 L136 46 Z" fill="${rgb(BODY)}"/>
    <circle cx="128" cy="98" r="48" fill="${rgb(BODY)}"/>
  </g>
  <!-- 陷阱部位：内耳。与底色距离很近，容差过松会被一并抠掉 -->
  <path d="M97 57 L93 35 L112 47 Z" fill="${rgb(TRAP)}"/>
  <path d="M159 57 L163 35 L144 47 Z" fill="${rgb(TRAP)}"/>
  <!-- 眼睛 -->
  <ellipse cx="110" cy="96" rx="9" ry="11" fill="#ffffff"/>
  <ellipse cx="146" cy="96" rx="9" ry="11" fill="#ffffff"/>
  <ellipse cx="110" cy="97" rx="5" ry="7" fill="${rgb(INK)}"/>
  <ellipse cx="146" cy="97" rx="5" ry="7" fill="${rgb(INK)}"/>
  <!-- 陷阱部位：鼻头 -->
  <path d="M121 114 L135 114 L128 123 Z" fill="${rgb(TRAP)}"/>
  <!-- 尾巴（双层描边） -->
  <path d="M190 182 q30 -12 20 -48" fill="none" stroke="${rgb(INK)}" stroke-width="15" stroke-linecap="round"/>
  <path d="M190 182 q30 -12 20 -48" fill="none" stroke="${rgb(BODY)}" stroke-width="8" stroke-linecap="round"/>
</svg>`

// ---------------------------------------------------------------------------
// 产出 1：char-magenta.png —— 不透明底角色图（模拟 AI 直出）
// ---------------------------------------------------------------------------

async function genCharMagenta(rnd) {
  const SIZE = 256
  const bg = noisyBackground(SIZE, SIZE, BG, 8, rnd)
  const base = sharp(bg, { raw: { width: SIZE, height: SIZE, channels: 4 } })
  const fg = await sharp(Buffer.from(CAT_SVG)).png().toBuffer()

  const out = join(FIXTURES, 'char-magenta.png')
  await base
    .composite([{ input: fg, blend: 'over' }])
    .png({ compressionLevel: 9 })
    .toFile(out)

  const meta = await sharp(out).metadata()
  return { path: out, width: meta.width, height: meta.height, channels: meta.channels }
}

/**
 * 真值图：同一 SVG 渲染在**透明底**上。
 *
 * 这是抠底验证的关键素材。因为 char-magenta 正是由「真值的 alpha 合成到品红底」得到
 * （标准 over：C = a·F + (1−a)·B），所以真值的 alpha 与颜色就是抠底算法的**精确答案**。
 * 有了它，抠底质量可以用数值度量（alpha 误差、颜色误差），不必依赖目视判断。
 */
async function genCharGroundTruth() {
  const out = join(FIXTURES, 'char-alpha.png')
  await sharp(Buffer.from(CAT_SVG)).png({ compressionLevel: 9 }).toFile(out)
  const meta = await sharp(out).metadata()
  return { path: out, width: meta.width, height: meta.height }
}

// ---------------------------------------------------------------------------
// 产出 2：sheet-4x4.png —— 4×4 网格图集（带 alpha，模拟手绘图集）
// ---------------------------------------------------------------------------

/**
 * 单格内容：一个小球的弹跳 + 水平位移。
 *
 * 位移是必需的 —— 只做垂直弹跳时 |sin| 的对称性会让前后帧取值重复
 * （实测只剩 8 帧互异），加上水平位移后 16 帧互不相同。
 *
 * @param {number} cell 格子在 4×4 网格中的序号（决定其在图集中的位置）
 * @param {number} frame 帧序号（决定动画姿态，0–15）
 */
function bounceCellSvg(cell, frame) {
  const col = cell % 4
  const row = Math.floor(cell / 4)
  const t = frame / 16
  const cy = 24 - Math.abs(Math.sin(t * Math.PI)) * 12
  const cx = 6 + frame * 1.25
  const squash = 1 + Math.sin(t * Math.PI) * 0.12
  const rx = 5.5 * squash
  const ry = 5.5 / squash
  return `<g transform="translate(${col * 32} ${row * 32})">
    <ellipse cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}"
             fill="${rgb(BODY)}" stroke="${rgb(INK)}" stroke-width="2"/>
    <circle cx="${(cx - 2.5).toFixed(2)}" cy="${(cy - 2).toFixed(2)}" r="1.6" fill="#ffffff"/>
    <circle cx="${(cx + 2.5).toFixed(2)}" cy="${(cy - 2).toFixed(2)}" r="1.6" fill="#ffffff"/>
  </g>`
}

/**
 * 生成 4×4 图集。
 *
 * 注意：viewBox 必须覆盖整张图集。若写成单格高度（viewBox="0 0 128 32"），
 * 配合 preserveAspectRatio 的 meet 行为会让内容只落在画布中间一带，
 * 导致下面三行全空 —— 切片验证会假通过。
 */
async function genSheet4x4() {
  const CELL = 32
  const SIZE = CELL * 4
  const cells = Array.from({ length: 16 }, (_, f) => bounceCellSvg(f, f)).join('\n')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
${cells}
</svg>`

  const out = join(FIXTURES, 'sheet-4x4.png')
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out)

  const meta = await sharp(out).metadata()
  return { path: out, width: meta.width, height: meta.height, cell: CELL, frames: 16 }
}

// ---------------------------------------------------------------------------
// 产出 3：parts/*.png —— 分层部件（验证点 C 的覆盖层合成用）
// ---------------------------------------------------------------------------

/** 身体（不含五官），带锚点标记的坐标系：脚底中心为锚点 */
const PART_BODY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <g stroke="${rgb(INK)}" stroke-width="2" stroke-linejoin="round">
    <ellipse cx="32" cy="44" rx="18" ry="15" fill="${rgb(BODY)}"/>
    <path d="M22 20 L18 7 L32 17 Z" fill="${rgb(BODY)}"/>
    <path d="M42 20 L46 7 L32 17 Z" fill="${rgb(BODY)}"/>
    <circle cx="32" cy="28" r="14" fill="${rgb(BODY)}"/>
  </g>
</svg>`

/**
 * 眼睛：睁 / 闭。锚点即图心，尺寸一致（16×16），供覆盖层对齐验证。
 *
 * 注意：眼白必须够大。早期版本用 rx=2.6/ry=3.2 的椭圆配 rx=1.5/ry=2 的瞳孔，
 * 结果整张图只剩 14 个纯白像素 —— 验证脚本的「白色质心」判据卡在阈值边界上，
 * 看起来像渲染失败，实际是素材太小。素材要经得起检测，不能刚好擦边。
 */
const PART_EYES = {
  'eye-open': `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <ellipse cx="4.5" cy="8" rx="3.4" ry="4" fill="#ffffff"/>
    <ellipse cx="11.5" cy="8" rx="3.4" ry="4" fill="#ffffff"/>
    <ellipse cx="4.5" cy="8.5" rx="1.5" ry="2" fill="${rgb(INK)}"/>
    <ellipse cx="11.5" cy="8.5" rx="1.5" ry="2" fill="${rgb(INK)}"/>
  </svg>`,
  'eye-closed': `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <path d="M1.5 8 q3 3 6 0" fill="none" stroke="${rgb(INK)}" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M8.5 8 q3 3 6 0" fill="none" stroke="${rgb(INK)}" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`,
}

/**
 * 嘴：4 档开合（对应 mouthLevels），锚点统一在图心。
 *
 * 早期版本用两条二次贝塞尔围出开口，但两个控制点几乎重合 → 围成面积趋近 0，
 * 生成出来是两张**完全空的图**（实测 0 个不透明像素），「嘴型切档」判据因此恒假。
 * 改用椭圆，高度随档位线性增长，面积差足够被像素判据捕捉。
 */
const PART_MOUTH = Object.fromEntries(
  [0, 1, 2, 3].map((lv) => {
    const ry = 0.7 + lv * 1.7
    return [
      `mouth-${lv}`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
        <ellipse cx="8" cy="8" rx="4" ry="${ry.toFixed(2)}" fill="${rgb(INK)}"/>
      </svg>`,
    ]
  }),
)

async function genParts() {
  const dir = join(FIXTURES, 'parts')
  await mkdir(dir, { recursive: true })

  const written = []

  const bodyOut = join(dir, 'body.png')
  await sharp(Buffer.from(PART_BODY_SVG)).png({ compressionLevel: 9 }).toFile(bodyOut)
  written.push(bodyOut)

  for (const [name, svg] of Object.entries({ ...PART_EYES, ...PART_MOUTH })) {
    const out = join(dir, `${name}.png`)
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out)
    written.push(out)
  }

  // 部件尺寸清单：验证点 C 要用它做对齐断言
  const sizes = {}
  for (const p of written) {
    const m = await sharp(p).metadata()
    sizes[p.slice(dir.length + 1)] = { width: m.width, height: m.height, channels: m.channels }
  }
  await writeFile(join(dir, 'parts.json'), JSON.stringify(sizes, null, 2) + '\n', 'utf-8')

  return written
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const seed = Number(process.argv[2] ?? DEFAULT_SEED)
  const rnd = mulberry32(seed)

  await mkdir(FIXTURES, { recursive: true })

  console.log('[gen-fixtures] 开始生成验证素材')
  console.log(`[gen-fixtures] 随机种子 seed=${seed}（固定种子保证可复现）`)
  console.log(
    `[gen-fixtures] 抠底容差陷阱：底色 ${rgb(BG)} vs 陷阱色 ${rgb(TRAP)}，` +
      `欧氏距离 = ${colorDistance(BG, TRAP).toFixed(1)}（越小越难分离）`,
  )
  console.log('')

  const char = await genCharMagenta(rnd)
  console.log(`  ✓ char-magenta.png  ${char.width}×${char.height}通道${char.channels}（不透明底，模拟 AI 直出）`)
  console.log(`    ${char.path}`)

  const gt = await genCharGroundTruth()
  console.log(`  ✓ char-alpha.png    ${gt.width}×${gt.height}（真值：同 SVG 透明底，供抠底精度度量）`)
  console.log(`    ${gt.path}`)

  const sheet = await genSheet4x4()
  console.log(
    `  ✓ sheet-4x4.png     ${sheet.width}×${sheet.height}，${sheet.frames} 帧 × ${sheet.cell}px 网格`,
  )
  console.log(`    ${sheet.path}`)

  const parts = await genParts()
  console.log(`  ✓ parts/            ${parts.length} 个部件 + parts.json 尺寸清单`)
  console.log(`    ${join(FIXTURES, 'parts')}`)

  console.log('')
  console.log('[gen-fixtures] 完成。素材已固定，可反复运行校验一致性。')
}

main().catch((err) => {
  console.error('[gen-fixtures] 失败:', err)
  process.exit(1)
})
