#!/usr/bin/env node
/**
 * check-procedural.mjs — 验证点 B：程序化动画原语（验证计划 T3）
 *
 * 验证计划里这条的判据是**主观**的：「程序化原语能否让静态部件『像活的』」。
 * 主观判据不可复现，所以本脚本把它拆成两部分：
 *
 *  1. 可量化部分（自动断言）：
 *     · 变换以**锚点**为原点 —— 缩放/旋转时锚点不动（「站在桌面上不飘」的前提）
 *     · 呼吸时脚底不上下漂移
 *     · 运动确实发生且连续（不是静止图，也无跳变）
 *  2. 不可量化部分：产出胶片图供人眼判断观感
 *
 * 原语实现**直接 import pet-core 源码**（不重写公式）—— 否则实现变了这里不会发现，
 * 检查就失去意义。因此本脚本必须用 Node 的 TS 转换模式运行：
 *
 *   node --experimental-transform-types verify/pet-sprite/check-procedural.mjs
 *
 * （pet-core 用的是 TS 构造器参数属性等需转换的语法，仅 --experimental-strip-types 不够）
 */

import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  evaluateProcedural,
  BlinkScheduler,
  validateProceduralParams,
  PROCEDURAL_PERIODS,
} from '../../packages/pet-core/src/render/procedural-motion.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const EVIDENCE = join(HERE, '..', '..', 'docs', 'test', 'pet-sprite', 'evidence')

// ---------------------------------------------------------------------------
// 变换模型：以锚点为原点（渲染层职责，spike 阶段先落在这里）
// ---------------------------------------------------------------------------

/**
 * 把点 (px,py) 经程序化变换映射到新位置。
 *
 * 顺序：以锚点为原点 → 缩放 → 旋转 → 平移。
 * **锚点本身在任何缩放下必须不动**，否则呼吸时角色会整体上下漂移。
 */
function applyTransform(px, py, anchor, tr) {
  const dx = px - anchor.x
  const dy = py - anchor.y
  const sx = dx * tr.scale
  const sy = dy * tr.scale
  const rad = (tr.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: anchor.x + (sx * cos - sy * sin) + tr.offsetX,
    y: anchor.y + (sx * sin + sy * cos) + tr.offsetY,
  }
}

/**
 * 对 RGBA 图施加变换，最近邻采样（像素风要求，不能用双线性）。
 * 用**逆映射**：遍历输出像素反查源坐标，避免正映射留下空洞。
 */
function transformImage(src, w, h, anchor, tr) {
  const out = Buffer.alloc(w * h * 4)
  const rad = (tr.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const inv = 1 / (tr.scale || 1)

  for (let yo = 0; yo < h; yo++) {
    for (let xo = 0; xo < w; xo++) {
      const tx = xo - anchor.x - tr.offsetX
      const ty = yo - anchor.y - tr.offsetY
      const rx = tx * cos + ty * sin
      const ry = -tx * sin + ty * cos
      const xs = Math.round(rx * inv + anchor.x)
      const ys = Math.round(ry * inv + anchor.y)
      if (xs < 0 || xs >= w || ys < 0 || ys >= h) continue
      const si = (ys * w + xs) * 4
      const di = (yo * w + xo) * 4
      out[di] = src[si]; out[di + 1] = src[si + 1]
      out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3]
    }
  }
  return out
}

/** source-over 合成一个部件到画布 */
function blit(canvas, cw, ch, part, pw, ph, ox, oy) {
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const sy = oy + y, sx = ox + x
      if (sy < 0 || sy >= ch || sx < 0 || sx >= cw) continue
      const pi = (y * pw + x) * 4
      const a = part[pi + 3] / 255
      if (a === 0) continue
      const di = (sy * cw + sx) * 4
      for (let k = 0; k < 3; k++) {
        canvas[di + k] = Math.round(part[pi + k] * a + canvas[di + k] * (1 - a))
      }
      canvas[di + 3] = Math.max(canvas[di + 3], part[pi + 3])
    }
  }
}

function drawCross(buf, w, h, cx, cy, rgb) {
  const put = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return
    const i = (y * w + x) * 4
    buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = 255
  }
  for (let d = -3; d <= 3; d++) { put(cx + d, cy); put(cx, cy + d) }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const ANCHOR = { x: 32, y: 60 }
const PARAMS = { bob: 3, breathe: 1.04, sway: 2, nod: 1 }

async function main() {
  await mkdir(EVIDENCE, { recursive: true })

  console.log('=== 验证点 B：程序化动画原语 ===')
  console.log('')
  console.log(`  参数来源：pet-core/procedural-motion.ts（直接 import 源码，非重写公式）`)

  const results = {}

  // ---- 断言 0：参数校验（安全约束）----
  const good = validateProceduralParams(PARAMS)
  const bad = validateProceduralParams({ bob: 'sin(t)' })
  const validateOk = good.ok && !bad.ok
  console.log(
    `[断言 0] 参数校验：合法参数通过 / 表达式被拒   ${good.ok ? '✓' : '✗'} / ${!bad.ok ? '✓' : '✗'}   ${validateOk ? '✓ PASS' : '✗ FAIL'}`,
  )
  results.validate = validateOk

  // ---- 断言 1：锚点在缩放/旋转下不动 ----
  const trSample = { offsetX: 0, offsetY: 0, scale: 1.04, rotation: 2 }
  const moved = applyTransform(ANCHOR.x, ANCHOR.y, ANCHOR, trSample)
  const anchorErr = Math.hypot(moved.x - ANCHOR.x, moved.y - ANCHOR.y)
  const anchorOk = anchorErr < 1e-9
  console.log(`[断言 1] 锚点在缩放/旋转下不动       误差 ${anchorErr.toExponential(2)}px                            ${anchorOk ? '✓ PASS' : '✗ FAIL'}`)
  results.anchorFixed = anchorOk

  // ---- 断言 2：呼吸时脚底不上下漂移 ----
  // 若缩放中心误取图像中心，脚底会随呼吸上下浮动
  const trBreathe = { offsetX: 0, offsetY: 0, scale: 1.04, rotation: 0 }
  const footMoved = applyTransform(ANCHOR.x, ANCHOR.y, ANCHOR, trBreathe)
  const footErr = Math.abs(footMoved.y - ANCHOR.y)
  const footOk = footErr < 1e-9
  console.log(`[断言 2] 呼吸时脚底不漂移           误差 ${footErr.toExponential(2)}px                            ${footOk ? '✓ PASS' : '✗ FAIL'}`)
  results.footStable = footOk

  // ---- 断言 3/4：运动存在且连续 ----
  const maxPeriod = Math.max(...Object.values(PROCEDURAL_PERIODS))
  const N = 8
  const samples = Array.from({ length: N }, (_, i) => {
    const t = (i / N) * maxPeriod
    return { t, tr: evaluateProcedural(PARAMS, t) }
  })
  const yVals = samples.map((s) => s.tr.offsetY)
  const sVals = samples.map((s) => s.tr.scale)
  const rVals = samples.map((s) => s.tr.rotation)
  const yRange = Math.max(...yVals) - Math.min(...yVals)
  const sRange = Math.max(...sVals) - Math.min(...sVals)
  const rRange = Math.max(...rVals) - Math.min(...rVals)
  const motionOk = yRange > 1 && sRange > 0.01 && rRange > 0.5
  console.log(
    `[断言 3] 运动确实发生               位移 ${yRange.toFixed(2)}px / 缩放 ${sRange.toFixed(4)} / 旋转 ${rRange.toFixed(2)}°   ${motionOk ? '✓ PASS' : '✗ FAIL'}`,
  )
  results.motionPresent = motionOk

  const DENSE = 600
  let maxJump = 0
  let prev = null
  for (let i = 0; i <= DENSE; i++) {
    const tr = evaluateProcedural(PARAMS, (i / DENSE) * maxPeriod * 2)
    const v = { y: tr.offsetY, r: tr.rotation, s: tr.scale }
    if (prev) {
      maxJump = Math.max(maxJump, Math.abs(v.y - prev.y) + Math.abs(v.r - prev.r) + Math.abs(v.s - prev.s) * 10)
    }
    prev = v
  }
  const contOk = maxJump < 0.5
  console.log(`[断言 4] 连续无跳变                 最大相邻差值 ${maxJump.toFixed(4)}                       ${contOk ? '✓ PASS' : '✗ FAIL'}`)
  results.continuous = contOk

  // ---- 组装合成图（base + face 覆盖层）后施加变换 ----
  const load = async (p) => {
    const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return { data, w: info.width, h: info.height }
  }
  const body = await load(join(FIXTURES, 'parts', 'body.png'))
  const eyeOpen = await load(join(FIXTURES, 'parts', 'eye-open.png'))
  const eyeClosed = await load(join(FIXTURES, 'parts', 'eye-closed.png'))

  const W = body.w, H = body.h
  const blink = new BlinkScheduler(PARAMS.blink || 3200, 120)

  const SCALE = 3
  const STRIP_W = W * SCALE * N
  const STRIP_H = H * SCALE
  const strip = Buffer.alloc(STRIP_W * STRIP_H * 4)

  // 棋盘底：半透明区域看得见
  for (let y = 0; y < STRIP_H; y++) {
    for (let x = 0; x < STRIP_W; x++) {
      const c = ((x >> 3) + (y >> 3)) % 2 === 0 ? 232 : 208
      const i = (y * STRIP_W + x) * 4
      strip[i] = c; strip[i + 1] = c; strip[i + 2] = c; strip[i + 3] = 255
    }
  }

  // 用较大的时间跨度采样，让眨眼也有机会出现
  for (let f = 0; f < N; f++) {
    const tSec = (f / N) * (maxPeriod * 2)
    const tr = evaluateProcedural(PARAMS, tSec, blink)

    // 先合成槽位，再整体施加变换（渲染顺序：槽位合成 → 原语变换）
    const composed = Buffer.alloc(W * H * 4)
    blit(composed, W, H, body.data, body.w, body.h, 0, 0)
    const eyes = tr.blinkClosed ? eyeClosed : eyeOpen
    blit(composed, W, H, eyes.data, eyes.w, eyes.h, 24, 24)

    const frame = transformImage(composed, W, H, ANCHOR, tr)

    const ox = f * W * SCALE
    for (let y = 0; y < H * SCALE; y++) {
      for (let x = 0; x < W * SCALE; x++) {
        const si = (Math.floor(y / SCALE) * W + Math.floor(x / SCALE)) * 4
        const a = frame[si + 3] / 255
        if (a === 0) continue
        const di = (y * STRIP_W + ox + x) * 4
        for (let k = 0; k < 3; k++) {
          strip[di + k] = Math.round(frame[si + k] * a + strip[di + k] * (1 - a))
        }
      }
    }
    drawCross(strip, STRIP_W, STRIP_H, ox + ANCHOR.x * SCALE, ANCHOR.y * SCALE, [220, 40, 40])
  }

  const stripPath = join(EVIDENCE, 'procedural-filmstrip.png')
  await sharp(strip, { raw: { width: STRIP_W, height: STRIP_H, channels: 4 } })
    .png().toFile(stripPath)

  console.log('')
  console.log(`胶片图：${stripPath}`)
  console.log(`  ${N} 帧 × ${W}×${H}（放大 ${SCALE}×），红色十字为锚点 —— 各帧应停在同一水平线`)
  console.log(`  参数：bob=${PARAMS.bob}px breathe=${PARAMS.breathe} sway=${PARAMS.sway}° nod=${PARAMS.nod}°`)
  console.log('  ← 需人眼判断：呼吸/浮动/摇摆是否自然，是否「像活的」')

  const all = Object.values(results).every(Boolean)
  console.log('')
  console.log(`验证点 B 自动断言：${all ? '✓ PASS' : '✗ FAIL'}`)
  console.log('  （「像不像活的」属主观判据，需看胶片图人工确认）')

  await writeFile(
    join(EVIDENCE, 'check-procedural-result.json'),
    JSON.stringify({ results, all, samples: samples.map((s) => ({ t: s.t, ...s.tr })), stripPath }, null, 2) + '\n',
    'utf-8',
  )

  process.exit(all ? 0 : 1)
}

main().catch((err) => {
  console.error('[check-procedural] 失败:', err)
  process.exit(1)
})
