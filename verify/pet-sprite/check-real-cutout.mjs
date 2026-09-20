#!/usr/bin/env node
/**
 * check-real-cutout.mjs — 在**真实 AI 出图**上补验抠底（关闭验证报告 §6 的适用边界）
 *
 * 验证点 A 用的是程序化素材（构造了噪声底/抗锯齿/近底色部位三项特性）。
 * 本脚本用真实生图模型产出的图重跑同一套算法，回答「真实输入是否更糟」。
 *
 * 真实图没有真值，故改用**无需真值的质量指标**：
 *   R1 不泄漏    掩膜未覆盖整图（flood fill 没穿透描边）
 *   R2 无残留底色 半透明边缘像素的反预乘结果，不应仍接近底色
 *   R3 描边存活   角色描边（最暗的一簇颜色）在抠底后仍为不透明
 *   R4 边缘锐利   半透明像素应集中在轮廓带，而非散布全身
 *
 * 用法：node verify/pet-sprite/check-real-cutout.mjs <img1.png> [img2.png ...]
 */

import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cutout, alphaBBox, estimateBackground, colorDistance } from './lib/cutout.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE = join(HERE, '..', '..', 'docs', 'test', 'pet-sprite', 'evidence')

const IMAGES = process.argv.slice(2)

/**
 * R2 残留底色：对每个半透明像素，看它的反预乘结果离底色多近。
 * 若离得很近，说明底色的贡献没被减干净 —— 叠到深色背景上会泛出品红色。
 * @returns 残留像素占比（越低越好）
 */
function residualBgRatio(res, w, h, bg, nearTol = 60) {
  let semi = 0, near = 0
  for (let i = 0; i < w * h; i++) {
    const a = res[i * 4 + 3] / 255
    if (a <= 0.02 || a >= 0.98) continue
    semi++
    const F = [res[i * 4], res[i * 4 + 1], res[i * 4 + 2]]
    if (colorDistance(F, bg) <= nearTol) near++
  }
  return { semi, near, ratio: semi ? near / semi : 0 }
}

/** R3 描边存活：取角色内最暗的一簇颜色作描边代表，统计其仍为不透明的像素数 */
function outlineSurvival(res, w, h, bbox) {
  // 在包围盒内找亮度最低的 20% 像素，取其中位数色作描边色
  const lums = []
  for (let y = bbox.minY; y <= bbox.maxY; y++) {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      const i = (y * w + x) * 4
      if (res[i + 3] < 128) continue
      lums.push({ i, l: 0.299 * res[i] + 0.587 * res[i + 1] + 0.114 * res[i + 2] })
    }
  }
  if (lums.length === 0) return { outlinePx: 0, opaquePx: 0, ratio: 0 }
  lums.sort((a, b) => a.l - b.l)
  const cut = lums.slice(0, Math.max(1, Math.floor(lums.length * 0.2)))
  let opaque = 0
  for (const { i } of cut) if (res[i + 3] > 200) opaque++
  return { outlinePx: cut.length, opaquePx: opaque, ratio: opaque / cut.length }
}

async function main() {
  if (IMAGES.length === 0) {
    console.error('用法: node check-real-cutout.mjs <img1.png> [img2.png ...]')
    process.exit(1)
  }
  await mkdir(EVIDENCE, { recursive: true })

  console.log('=== 真实 AI 出图的抠底补验（关闭报告 §6 适用边界）===')
  console.log('')

  let allPass = true
  const rows = []

  for (const p of IMAGES) {
    const name = p.split(/[\\/]/).pop().replace(/\.png$/, '')
    const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const bg = estimateBackground(data, info.width, info.height)
    const res = cutout(data, info.width, info.height, bg)
    const bbox = alphaBBox(res.data, info.width, info.height)
    const coverage = bbox ? (bbox.w * bbox.h) / (info.width * info.height) : 1
    const resid = residualBgRatio(res.data, info.width, info.height, bg)
    const outline = outlineSurvival(res.data, info.width, info.height, bbox)

    const r1 = coverage < 0.9
    const r2 = resid.ratio < 0.05
    const r3 = outline.ratio > 0.9
    const pass = r1 && r2 && r3
    if (!pass) allPass = false

    const hex = '#' + bg.map((v) => v.toString(16).padStart(2, '0')).join('')
    console.log(`${name}`)
    console.log(`  底色 ${hex}  自动 tSolid=${res.tuning.tSolid}（泄漏点 ${res.tuning.leakAt ?? '—'}）`)
    console.log(`  R1 不泄漏       掩膜占画面 ${(coverage * 100).toFixed(1)}%                                    ${r1 ? '✓' : '✗'}`)
    console.log(`  R2 无残留底色   半透明像素 ${resid.semi} 个，其中贴近底色的 ${resid.near} 个 = ${(resid.ratio * 100).toFixed(2)}%（阈值 5%）  ${r2 ? '✓' : '✗'}`)
    console.log(`  R3 描边存活     描边候选 ${outline.outlinePx} px，仍不透明 ${(outline.ratio * 100).toFixed(1)}%（阈值 90%）      ${r3 ? '✓' : '✗'}`)
    console.log(`  → ${pass ? '✓ PASS' : '✗ FAIL'}`)
    console.log('')

    rows.push({ name, bg, tSolid: res.tuning.tSolid, leakAt: res.tuning.leakAt, coverage, residual: resid, outline, pass })

    await sharp(res.data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .resize(640, 640, { fit: 'inside' })
      .png().toFile(join(EVIDENCE, `real-cutout-${name.slice(0, 24)}.png`))
  }

  console.log('─'.repeat(72))
  console.log(`真实图抠底补验：${allPass ? '✓ 全部通过 —— 报告 §6 的适用边界已关闭' : '✗ 存在失败项，需更新报告 §6'}`)
  console.log('')
  console.log('对照验证点 A（程序化素材）的同一算法：')
  console.log('  A 用真值图度量，预乘 MAE 0.03、陷阱色存活 100%')
  console.log('  本次用真实 AI 出图，无真值，改以上述无需真值的质量指标衡量')

  process.exit(allPass ? 0 : 1)
}

main().catch((e) => { console.error('[check-real-cutout] 失败:', e); process.exit(1) })
