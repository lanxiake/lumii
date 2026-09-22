#!/usr/bin/env node
/**
 * measure-idle-motion.mjs — 待机到底会不会「上下浮动」，量出来
 *
 * ## 由来
 *
 * 2026-09-22 用户报「待机的上下浮动看着头晕」。查的时候有个反直觉的点：那时 Idle 的
 * `params` 里**已经没有 `bob`** 了（程序化层是干净的，见 `shimeji-sheet.mjs`），
 * 浮动全部来自**帧本身**。所以「有没有 bob」不能当判据——**得量像素**。
 *
 * ## 量什么
 *
 * 对每个模型的 Idle 动画：
 *   · **帧内跨度** —— 逐帧量内容在图集格子里的垂直位置（顶边 + 重心），取帧间极差。
 *     REST 那 8 帧就是这么露馅的：2 帧趴着（顶边 95）、6 帧坐着（顶边 78-87），
 *     格内跨度 17px——它是「趴下—起身」，不是呼吸。
 *   · **参数跨度** —— `params.bob` 的峰峰值是 `2 × bob`（正弦上下各一次）。
 *     ⚠️ 它**不乘 `scale`**：偏移量在渲染器的 stage 坐标里施加，是屏幕像素。
 *     这条是实测纠正过来的——第一版按"和帧一样要乘 scale"算，把 `bob: 9` 算成 4px，
 *     而实机量到的是 18px（`check-idle-stillness.mjs` 的顶边跨度）。
 *     帧是画进图集的，跟着 scale 缩放；参数不是。两者不能混为一谈。
 *   · **屏幕跨度** —— 帧那部分乘 `scale`，参数那部分直接加。
 *     `demo_shimeji_skoreacat` 的 17px × 2.2 ≈ **37px**，这就是"头晕"的量级。
 *
 * ## 为什么不做成 CI 门禁
 *
 * `bob` 是**有意的能力展示**——`demo_anime_girl` 那几只示范宠物专门用它演示程序化
 * 原语，阈值一刀切会把它们全判死。所以这是**诊断工具**，不是闸门：
 * 和 `measure-ground.mjs` 一样，下次再有人报「宠物在飘」，先跑它，
 * 一眼看出是帧的问题还是参数的问题。
 *
 * 用法：node measure-idle-motion.mjs [模型目录…]
 *       （默认量 apps/windows/resources/pet-models）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 本脚本在 verify/pet-sprite/ 下（比 characters/ 浅一层），仓库根是上两级
const REPO = path.resolve(HERE, '../..')
const require = createRequire(path.join(REPO, 'package.json'))
const sharp = require('sharp')

const DEFAULT_ROOT = path.join(REPO, 'apps/windows/resources/pet-models')
const ROOTS = process.argv.slice(2).length ? process.argv.slice(2) : [DEFAULT_ROOT]

/** alpha 阈值：低于它当背景。与 measure-ground.mjs 一致 */
const ALPHA_MIN = 16

/** 量一帧在其图集格子里的垂直位置（格内坐标） */
async function frameVertical(pngPath, rect) {
  const { data, info } = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let top = 1e9
  let sum = 0
  let n = 0
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const px = rect.x + x
      const py = rect.y + y
      if (px >= info.width || py >= info.height) continue
      if (data[(py * info.width + px) * info.channels + 3] > ALPHA_MIN) {
        if (y < top) top = y
        sum += y
        n++
      }
    }
  }
  return n ? { top, centroid: sum / n, pixels: n } : null
}

/** 读同目录的 pet.json 拿 scale（清单里没有这个字段，它在注册层） */
function readScale(dir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'))
    return typeof p.scale === 'number' ? p.scale : null
  } catch {
    return null
  }
}

/** 列出目录树下所有含 manifest.json 的模型目录（含 _variants 这类嵌套） */
function findModels(dir, depth = 0) {
  if (depth > 3 || !fs.existsSync(dir)) return []
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...findModels(p, depth + 1))
    else if (e.name === 'manifest.json') out.push(dir)
  }
  return [...new Set(out)]
}

const rows = []

for (const root of ROOTS) {
  for (const dir of findModels(root)) {
    let m
    try {
      m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    } catch (e) {
      console.log(`⚠ ${dir} 清单读不动：${e.message}`)
      continue
    }
    const idle = (m.animations ?? []).find((a) => a.group === 'Idle')
    if (!idle) continue

    const atlasJson = path.join(dir, m.atlasJson ?? 'atlas.json')
    const atlasPng = path.join(dir, m.atlas ?? 'atlas.png')
    let frames = []
    if (fs.existsSync(atlasJson) && fs.existsSync(atlasPng)) {
      const atlas = JSON.parse(fs.readFileSync(atlasJson, 'utf8'))
      for (const f of idle.frames) {
        const rect = (atlas.frames ?? {})[f.base]?.frame
        if (!rect) continue
        const v = await frameVertical(atlasPng, rect)
        if (v) frames.push(v)
      }
    }

    const topSpan = frames.length ? Math.max(...frames.map((f) => f.top)) - Math.min(...frames.map((f) => f.top)) : 0
    const centroidSpan = frames.length
      ? Math.max(...frames.map((f) => f.centroid)) - Math.min(...frames.map((f) => f.centroid))
      : 0
    const bob = idle.params?.bob ?? 0
    const scale = readScale(dir)
    // 帧在格内、跟着 scale 缩放；bob 在 stage 坐标里、就是屏幕像素（见文件头）
    const frameSpan = Math.max(topSpan, centroidSpan) * (scale ?? 1)
    const cellSpan = Math.max(topSpan, centroidSpan) + 2 * Math.abs(bob)
    const screenSpan = frameSpan + 2 * Math.abs(bob)

    rows.push({ id: m.id ?? path.basename(dir), frames: idle.frames.length, topSpan, centroidSpan, bob, scale, cellSpan, screenSpan })
  }
}

rows.sort((a, b) => b.screenSpan - a.screenSpan)

const pad = (s, n) => String(s).padEnd(n)
console.log(
  pad('模型', 24) + pad('Idle帧', 7) + pad('顶边跨度', 10) + pad('重心跨度', 10) +
  pad('bob', 6) + pad('scale', 7) + pad('屏幕跨度', 10) + '判定',
)
for (const r of rows) {
  // 判据是**屏幕像素**：8px 以下基本看不出上下动，20px 以上就是"在飘"
  const verdict = r.screenSpan > 20 ? '⚠ 看得出来在飘' : r.screenSpan > 8 ? '· 轻微' : '✓ 静止'
  const src = r.bob ? '参数为主' : r.frames > 1 ? '帧' : '—'
  console.log(
    pad(r.id, 24) + pad(r.frames, 7) + pad(r.topSpan + 'px', 10) + pad(r.centroidSpan.toFixed(1) + 'px', 10) +
    pad(r.bob, 6) + pad(r.scale ?? '—', 7) + pad(r.screenSpan.toFixed(1) + 'px', 10) +
    `${verdict}（来自${src}）`,
  )
}

console.log(`\n共 ${rows.length} 个模型。屏幕跨度 = 帧内跨度 × scale + 2×bob（bob 不乘 scale，见文件头）。`)
console.log('判据：>20px 看得出在飘（REST 8 帧那版是 17px×2.2 ≈ 37px）；≤8px 基本看不出。')
