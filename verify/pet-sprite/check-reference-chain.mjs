#!/usr/bin/env node
/**
 * check-reference-chain.mjs — 验证点 D：图生图参考链的角色一致性
 *
 * 验证方式：三帧由真实生图模型按「以上一帧为参考」的链式方式生成
 * （frame1 文生图 → frame2 参考 frame1 → frame3 参考 frame2），
 * 本脚本量化「第 3 帧与第 1 帧是否仍是同一角色」。
 *
 * 三条量化判据（对应计划里「体型、五官布局、配色一致」的肉眼判据）：
 *   D1 配色一致   —— 抠底后角色调色板的重合度
 *   D2 体型一致   —— 角色包围盒纵横比之差
 *   D3 轮廓一致   —— 归一化后的剪影 IoU（最能反映「还是不是同一个角色」）
 *
 * 另附带一项工程可用性检查：
 *   D4 抠底可用   —— 自动容差调参能否找到不泄漏的 tSolid（见 lib/cutout.mjs 的硬约束）
 *
 * 用法：node verify/pet-sprite/check-reference-chain.mjs
 */

import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cutout, alphaBBox, estimateBackground, colorDistance } from './lib/cutout.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE = join(HERE, '..', '..', 'docs', 'test', 'pet-sprite', 'evidence')

/** 三帧的绝对路径（由 check-reference-chain 的调用方生成，见 report 记录） */
const FRAMES = [
  { name: 'frame1', label: '第1帧（文生图，站立）', path: process.argv[2] },
  { name: 'frame2', label: '第2帧（参考第1帧，挥手）', path: process.argv[3] },
  { name: 'frame3', label: '第3帧（参考第2帧，坐下）', path: process.argv[4] },
  ...(process.argv[5]
    ? [{ name: 'frame4', label: '第4帧（参考第3帧，回到站立）', path: process.argv[5] }]
    : []),
]

/**
 * 同姿态对照：首帧与末帧姿态相同，相隔多跳。
 * 此时 IoU 不再被「有意改姿态」污染，**直接等于纯身份漂移**。
 * 这是判定「链式生成能否保持角色」的决定性对照。
 */
const SAME_POSE_PAIR = FRAMES.length >= 4 ? [0, FRAMES.length - 1] : null

/** 归一化尺寸：把剪影缩放到统一大小再比形状 */
const NORM = 256

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 调色板：量化到 5 bit/通道，取占比前 N 的颜色 */
function palette(img, topN = 24) {
  const counts = new Map()
  let total = 0
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4
      if (img.data[i + 3] < 230) continue // 只看实心像素，避免边缘混色干扰
      const k = ((img.data[i] >> 3) << 10) | ((img.data[i + 1] >> 3) << 5) | (img.data[i + 2] >> 3)
      counts.set(k, (counts.get(k) ?? 0) + 1)
      total++
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
  const unq = (k) => [((k >> 10) & 31) << 3, ((k >> 5) & 31) << 3, (k & 31) << 3]
  return sorted.map(([k, n]) => ({ rgb: unq(k), share: total ? n / total : 0 }))
}

/**
 * 调色板重合度：把 A 的每个颜色按占比计权，看它在 B 的调色板里能否找到近邻。
 * @returns 0~1，1 表示 A 的调色板被 B 完整覆盖
 */
function paletteOverlap(pa, pb, tol = 40) {
  let hit = 0, sum = 0
  for (const c of pa) {
    sum += c.share
    const near = pb.some((d) => colorDistance(c.rgb, d.rgb) <= tol)
    if (near) hit += c.share
  }
  return sum > 0 ? hit / sum : 0
}

/** 剪影：抠底结果裁到包围盒 → 缩放到 NORM×NORM → 二值化 */
async function silhouette(img, bbox) {
  const crop = sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
    .extract({ left: bbox.minX, top: bbox.minY, width: bbox.w, height: bbox.h })
  const { data, info } = await crop
    .resize(NORM, NORM, { fit: 'fill', kernel: 'linear' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const bin = new Uint8Array(NORM * NORM)
  for (let i = 0; i < NORM * NORM; i++) bin[i] = data[i * 4 + 3] > 128 ? 1 : 0
  return { bin, w: info.width, h: info.height }
}

/** 两个二值剪影的 IoU */
function iou(a, b) {
  let inter = 0, union = 0
  for (let i = 0; i < a.bin.length; i++) {
    const x = a.bin[i], y = b.bin[i]
    if (x && y) inter++
    if (x || y) union++
  }
  return union === 0 ? 0 : inter / union
}

/** 所有两两组合的索引对 */
function allPairs(n = FRAMES.length) {
  const out = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j])
  return out
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (FRAMES.some((f) => !f.path)) {
    console.error('用法: node check-reference-chain.mjs <frame1.png> <frame2.png> <frame3.png> [frame4.png]')
    process.exit(1)
  }
  await mkdir(EVIDENCE, { recursive: true })

  console.log('=== 验证点 D：图生图参考链的角色一致性 ===')
  console.log('')

  const analyzed = []
  for (const f of FRAMES) {
    const { data, info } = await sharp(f.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const bg = estimateBackground(data, info.width, info.height)
    const res = cutout(data, info.width, info.height, bg)
    const bbox = alphaBBox(res.data, info.width, info.height)
    const img = { data: res.data, w: info.width, h: info.height }

    analyzed.push({
      ...f,
      bg,
      tuning: res.tuning,
      bbox,
      aspect: bbox.w / bbox.h,
      coverage: (bbox.w * bbox.h) / (info.width * info.height),
      palette: palette(img),
      img,
    })

    // 抠底结果存成证据
    await sharp(res.data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png().toFile(join(EVIDENCE, `refchain-${f.name}-cutout.png`))
  }

  // ---- D4 抠底可用性 ----
  // 注意：几乎任何图像在高容差下都会出现「泄漏」—— 容差足够大时 flood fill 必然穿透一切。
  // 所以「检测到泄漏」恰恰说明自动调参在工作，不是失败。
  // 真正的判据是：回退后的容差能否产出**可用的掩膜** —— 即掩膜没有覆盖整张图。
  console.log('[D4] 抠底可用性（自动调参后的掩膜是否合理）')
  let d4 = true
  for (const a of analyzed) {
    const maskCoverage = a.coverage
    const ok = maskCoverage < 0.9
    if (!ok) d4 = false
    const bgHex = '#' + a.bg.map((v) => v.toString(16).padStart(2, '0')).join('')
    console.log(
      `     ${a.name}  底色 ${bgHex}  自动 tSolid=${a.tuning.tSolid}` +
        `（泄漏点 ${a.tuning.leakAt ?? '未触及'}，回退余量 ${a.tuning.leakAt ? a.tuning.leakAt - a.tuning.tSolid : '—'}）` +
        `  掩膜占画面 ${(maskCoverage * 100).toFixed(1)}%   ${ok ? '✓' : '✗ 疑似整图泄漏'}`,
    )
  }
  console.log(`     ${d4 ? '✓ PASS 三帧均能安全抠底' : '✗ FAIL 掩膜异常'}`)
  console.log('')

  // ---- 剪影 ----
  for (const a of analyzed) {
    a.sil = await silhouette(a.img, a.bbox)
  }

  // ---- D1 配色 ----
  console.log('[D1] 配色一致性（抠底后角色调色板重合度）')
  const pairs = allPairs()
  let d1 = true
  for (const [i, j] of pairs) {
    const ab = paletteOverlap(analyzed[i].palette, analyzed[j].palette)
    const ba = paletteOverlap(analyzed[j].palette, analyzed[i].palette)
    const both = Math.min(ab, ba)
    if (both < 0.8) d1 = false
    console.log(
      `     ${analyzed[i].name} → ${analyzed[j].name}  重合度 ${(ab * 100).toFixed(1)}%` +
        `   反向 ${(ba * 100).toFixed(1)}%   双向取小 ${(both * 100).toFixed(1)}%`,
    )
  }
  console.log(`     ${d1 ? '✓ PASS 配色一致' : '✗ FAIL 配色漂移'}`)
  console.log('')

  // ---- D2 体型 ----
  console.log('[D2] 体型一致性（角色包围盒纵横比）')
  for (const a of analyzed) {
    console.log(`     ${a.name}  包围盒 ${a.bbox.w}×${a.bbox.h}  纵横比 ${a.aspect.toFixed(3)}  占画面 ${(a.coverage * 100).toFixed(1)}%`)
  }
  const aspects = analyzed.map((a) => a.aspect)
  const aspectSpread = (Math.max(...aspects) - Math.min(...aspects)) / (aspects.reduce((s, v) => s + v, 0) / aspects.length)
  const d2 = aspectSpread < 0.35
  console.log(`     纵横比相对离散度 ${(aspectSpread * 100).toFixed(1)}%（阈值 35%）   ${d2 ? '✓ PASS' : '✗ FAIL'}`)
  console.log('')

  // ---- D3 轮廓 IoU ----
  console.log('[D3] 轮廓一致性（归一化剪影 IoU）')
  const ious = []
  for (let i = 0; i < analyzed.length; i++) {
    for (let j = i + 1; j < analyzed.length; j++) {
      const v = iou(analyzed[i].sil, analyzed[j].sil)
      ious.push({ pair: `${analyzed[i].name}-${analyzed[j].name}`, i: i + 1, j: j + 1, iou: v })
      const tag =
        SAME_POSE_PAIR && i === SAME_POSE_PAIR[0] && j === SAME_POSE_PAIR[1]
          ? '   ← 同姿态对照（纯漂移，决定性判据）'
          : ''
      console.log(`     ${analyzed[i].name} vs ${analyzed[j].name}  IoU ${(v * 100).toFixed(1)}%${tag}`)
    }
  }

  // 判据分两种情形：
  //  - 有同姿态对照帧：以它为准（排除姿态变化这个混杂因素）
  //  - 没有：退化为看首尾，但结论必须标注「含姿态变化，不能单独归因于漂移」
  let d3, d3Note
  if (SAME_POSE_PAIR) {
    const pair = ious.find((p) => p.i === SAME_POSE_PAIR[0] + 1 && p.j === SAME_POSE_PAIR[1] + 1)
    d3 = pair.iou >= 0.75
    d3Note = `同姿态对照 IoU ${(pair.iou * 100).toFixed(1)}%（阈值 75%）`
  } else {
    const pair = ious.find((p) => p.i === 1 && p.j === analyzed.length)
    d3 = pair.iou >= 0.75
    d3Note = `首尾 IoU ${(pair.iou * 100).toFixed(1)}%（含姿态变化，不能单独归因于漂移）`
  }
  console.log(`     ${d3 ? '✓ PASS' : '✗ FAIL'}  ${d3Note}`)
  console.log('')

  // ---- 产出并排对比图 ----
  const CELL = 320
  const NW = analyzed.length
  const strip = Buffer.alloc(CELL * NW * CELL * 4)
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL * NW; x++) {
      const c = ((x >> 3) + (y >> 3)) % 2 === 0 ? 235 : 210
      const i = (y * CELL * NW + x) * 4
      strip[i] = c; strip[i + 1] = c; strip[i + 2] = c; strip[i + 3] = 255
    }
  }
  for (let k = 0; k < NW; k++) {
    const a = analyzed[k]
    const { data, info } = await sharp(a.data ?? a.img.data, {
      raw: { width: a.img.w, height: a.img.h, channels: 4 },
    })
      .extract({ left: a.bbox.minX, top: a.bbox.minY, width: a.bbox.w, height: a.bbox.h })
      .resize(CELL - 16, CELL - 16, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw().toBuffer({ resolveWithObject: true })
    const ox = k * CELL + 8, oy = 8
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const si = (y * info.width + x) * 4
        const al = data[si + 3] / 255
        if (al === 0) continue
        const di = ((oy + y) * CELL * NW + ox + x) * 4
        for (let c = 0; c < 3; c++) {
          strip[di + c] = Math.round(data[si + c] * al + strip[di + c] * (1 - al))
        }
      }
    }
  }
  const stripPath = join(EVIDENCE, 'refchain-comparison.png')
  await sharp(strip, { raw: { width: CELL * NW, height: CELL, channels: 4 } }).png().toFile(stripPath)

  // 剪影叠加图：首尾剪影叠在一起，重合处绿色、仅第1帧红色、仅第3帧蓝色
  const ov = Buffer.alloc(NORM * NORM * 4)
  const LAST = analyzed.length - 1
  const s0 = analyzed[0].sil.bin, s2 = analyzed[LAST].sil.bin
  for (let i = 0; i < NORM * NORM; i++) {
    const a = s0[i], b = s2[i]
    const c = a && b ? [80, 200, 120] : a ? [230, 80, 80] : b ? [80, 120, 230] : [245, 245, 245]
    ov[i * 4] = c[0]; ov[i * 4 + 1] = c[1]; ov[i * 4 + 2] = c[2]; ov[i * 4 + 3] = 255
  }
  const overlayPath = join(EVIDENCE, 'refchain-silhouette-overlay.png')
  await sharp(ov, { raw: { width: NORM, height: NORM, channels: 4 } }).png().toFile(overlayPath)

  const all = d1 && d2 && d3 && d4
  console.log('─'.repeat(72))
  console.log(`验证点 D 判定：${all ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  D1 配色一致   ${d1 ? '✓' : '✗'}`)
  console.log(`  D2 体型一致   ${d2 ? '✓' : '✗'}`)
  console.log(`  D3 轮廓一致   ${d3 ? '✓' : '✗'}  （${d3Note}）`)
  console.log(`  D4 抠底可用   ${d4 ? '✓' : '✗'}`)
  console.log('')
  console.log(`并排对比图：${stripPath}`)
  console.log(`剪影叠加图：${overlayPath}`)
  console.log('  （绿色=两帧重合，红色=仅第1帧，蓝色=仅第3帧 —— 蓝红越多说明漂移越大）')

  await writeFile(
    join(EVIDENCE, 'check-reference-chain-result.json'),
    JSON.stringify(
      {
        all, d1, d2, d3, d4,
        ious,
        aspectSpread,
        frames: analyzed.map((a) => ({
          name: a.name, label: a.label, path: a.path,
          bg: a.bg, tuning: a.tuning, bbox: a.bbox, aspect: a.aspect,
          palette: a.palette.slice(0, 8),
        })),
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  )

  process.exit(all ? 0 : 1)
}

main().catch((e) => {
  console.error('[check-reference-chain] 失败:', e)
  process.exit(1)
})
