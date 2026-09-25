#!/usr/bin/env node
/**
 * detached-check.mjs —— **抠完底之后**的第二道处理（绿渣 + 绿边），默认只报不改
 *
 *   node detached-check.mjs <表目录|png> [--cols 16] [--apply]
 *                                  [--small 420] [--big 1500] [--gap 6]
 *                                  [--spill recolor|clamp|off] [--radius 3] [--maxdist 6] [--no-semi]
 *
 * 代码里（`h3-motion.mjs` 出表后自动调的就是它）：
 *   import { scrubSheetPng } from './detached-check.mjs'
 *   await scrubSheetPng(sheetPng, 16, { apply: true })
 *
 * ## 这一道工序里有两道**互不干涉**的处理
 *
 *   1. **碎块过滤（改 alpha）** —— `lib/detached-blobs.mjs`：小且离本体远的块抹成
 *      透明，大块保留并告警。拦的是**表里中段长出来的**绿渣（角色移动把身后让开，
 *      模型把那块重画一遍，颜色离精确底色 26~80，`ColorToMask threshold=30` 抠不掉）。
 *      机位图那道（`stage-frame --drop-debris`）只能拦首帧自带的渣，拦不住这里。
 *   2. **溢色修复（改 RGB，alpha 一个字节不动）** —— `lib/spill-fix.mjs`：边缘那圈
 *      被绿底钓走的颜色，换成从干净内部像素扩散过来的角色自己的颜色。
 *      抠底只决定透明不透明，**颜色它不管**，所以这一步必须单独有。
 *
 * 各管各的闸门，别互相抢：溢色修复带一条 `maxdist` 源距闸门（最近干净源 >6px 就不用），
 * 落在这道闸门外的正好是飘在远处的碎块——**它们不该被染成角色的颜色**（只会更显眼），
 * 归第 1 道管。所以顺序是**先碎块过滤、后溢色修复**：碎块先消失，扩散就不用管它们，
 * 而闸门仍然留着当地（第 1 道会保留的大块——脚下的云、断开的水袖——也可能离干净源
 * 很远，那种真东西同样不该被染色）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { dropDetachedBlobs, labelComponents, componentBoxes } from '../lib/detached-blobs.mjs'
import { fixSpill, spillStats } from '../lib/spill-fix.mjs'

export const SCRUB_DEFAULTS = {
  // 第 1 道：碎块
  smallArea: 420, bigArea: 1500, minGap: 6, alphaThreshold: 40,
  // 第 2 道：溢色
  spill: 'recolor', radius: 3, maxdist: 6, semi: true,
  // 第 1 道总开关：特效层表（整张都是散开的光点）必须关掉，见下面的注释
  cc: true,
}

/**
 * @returns {Promise<object>} 逐格累计的报表（`lines` 直接打印即可）
 */
export async function scrubSheetPng(sheetPng, cols, { apply = false, ...opt } = {}) {
  const o = { ...SCRUB_DEFAULTS, ...opt }
  const { data, info } = await sharp(sheetPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width, H = info.height, cw = Math.floor(W / cols)
  const hist = []
  const kept = []
  let dropped = 0, droppedArea = 0
  let spillTouch = 0, spillFar = 0, spillSemi = 0, spillDistMax = 0
  let loadBefore = 0, loadAfter = 0
  const lines = [
    `后处理 ${path.basename(path.dirname(sheetPng))}  ${W}×${H} ${cols}格×${cw}px｜碎块：本体级≥${o.bigArea}｜告警带 ${o.smallArea}~${o.bigArea}｜抹掉<${o.smallArea} 且离本体>${o.minGap}px｜溢色：${o.spill}${o.spill === 'off' ? '' : ` 边缘带≤${o.radius}px、源距≤${o.maxdist}px、${o.semi ? '含' : '不含'}半透明圈`}${apply ? '' : '（只报不改）'}`,
  ]
  for (let c = 0; c < cols; c++) {
    const cell = Buffer.alloc(cw * H * 4)
    for (let y = 0; y < H; y++) data.copy(cell, y * cw * 4, (y * W + c * cw) * 4, (y * W + c * cw + cw) * 4)
    // 直方图用**未过滤**的块分布——阈值该定在哪要看这个
    const a0 = Buffer.allocUnsafe(cw * H)
    for (let i = 0; i < cw * H; i++) a0[i] = cell[i * 4 + 3]
    const { labels, areas } = labelComponents(a0, cw, H, o.alphaThreshold)
    const boxes = componentBoxes(labels, areas, cw, H)
    const big = boxes.filter((b) => b.area >= o.bigArea)
    for (const b of boxes) if (!big.includes(b)) hist.push(b.area)

    const s0 = o.spill === 'off' ? null : spillStats(cell, cw, H, o.radius)
    if (s0) loadBefore += s0.edge.load + s0.semi.load

    // 第 1 道：改 alpha
    // ⚠ **特效层（`slots` 的 aura/sparkle 表）必须 `--no-cc`**：那道判据的前提是
    // "有一个主体，其余小块是渣"，而特效层**整张表都是散开的小块**（一圈光点），
    // 照跑会把整圈删光。特效表只跑第 2 道（溢色）。
    const r = o.cc === false
      ? { bodies: [], dropped: [], kept: [] }
      : dropDetachedBlobs(cell, cw, H, { smallArea: o.smallArea, bigArea: o.bigArea, minGap: o.minGap, alphaThreshold: o.alphaThreshold })
    dropped += r.dropped.length
    droppedArea += r.dropped.reduce((s, b) => s + b.area, 0)
    for (const k of r.kept) kept.push({ ...k, cell: c })

    // 第 2 道：改 RGB（alpha 一律不动）
    let sp = null
    if (o.spill !== 'off') {
      sp = fixSpill(cell, cw, H, { method: o.spill, radius: o.radius, maxdist: o.maxdist, includeSemi: o.semi })
      spillTouch += sp.touched; spillFar += sp.skippedFar; spillSemi += sp.semiTouched
      if (sp.distMax > spillDistMax) spillDistMax = sp.distMax
      const s1 = spillStats(cell, cw, H, o.radius)
      loadAfter += s1.edge.load + s1.semi.load
    }
    if (r.dropped.length || (sp && sp.touched)) {
      lines.push(`  格${String(c).padStart(2)} 本体${r.bodies.length}块 抹块${String(r.dropped.length).padStart(2)}${r.dropped.length ? `[${r.dropped.slice(0, 3).map((b) => b.area + 'px').join(',')}]` : ''} 换色${String(sp ? sp.touched : 0).padStart(5)}${sp ? `（含半透明 ${sp.semiTouched}）` : ''}`)
    }
    if (apply) for (let y = 0; y < H; y++) cell.copy(data, (y * W + c * cw) * 4, y * cw * 4, (y * cw + cw) * 4)
  }
  if (apply) {
    await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toFile(sheetPng)
    lines.push(`✓ 后处理已写回 ${sheetPng}`)
  }
  lines.push(`合计：抹掉碎块 ${dropped} 块 / ${droppedArea}px｜保留并告警 ${kept.length} 块${kept.length ? `（最大 ${Math.max(...kept.map((b) => b.area))}px）` : ''}`)
  if (o.spill !== 'off') {
    lines.push(`溢色修复：改 ${spillTouch} 像素（其中半透明圈 ${spillSemi}）｜跳过源距>${o.maxdist}px 的 ${spillFar} 个（归碎块那道管）｜用到的最大源距 ${spillDistMax}px`)
    lines.push(`alpha 加权绿色权重：${Math.round(loadBefore)} → ${Math.round(loadAfter)}（降 ${(100 - (loadAfter / Math.max(1, loadBefore)) * 100).toFixed(1)}%）`)
  }
  return { cols, dropped, droppedArea, kept, hist, applied: apply, spillTouch, spillFar, loadBefore, loadAfter, lines }
}

// —— 直接运行时当 CLI 用 ——
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const target = args[0]
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
  const sheetPng = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'f0000.png') : target
  const metaPath = sheetPng.replace(/\.png$/, '.json')
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : {}
  const r = await scrubSheetPng(sheetPng, Number(flag('cols', meta.cols || 16)), {
    apply: args.includes('--apply'),
    smallArea: Number(flag('small', SCRUB_DEFAULTS.smallArea)),
    bigArea: Number(flag('big', SCRUB_DEFAULTS.bigArea)),
    minGap: Number(flag('gap', SCRUB_DEFAULTS.minGap)),
    spill: flag('spill', SCRUB_DEFAULTS.spill),
    radius: Number(flag('radius', SCRUB_DEFAULTS.radius)),
    maxdist: Number(flag('maxdist', SCRUB_DEFAULTS.maxdist)),
    semi: !args.includes('--no-semi'),
    // 特效层表要带这个（整张都是散开的光点，碎块判据会把整圈删光）
    cc: !args.includes('--no-cc'),
  })
  console.log(r.lines.join('\n'))
  const buckets = [[0, 10], [10, 30], [30, 80], [80, 200], [200, 420], [420, 800], [800, 1500], [1500, Infinity]]
  console.log('非本体块面积直方图（阈值定在哪看这个，别拍脑袋）：')
  for (const [lo, hi] of buckets) {
    const n = r.hist.filter((a) => a >= lo && a < hi).length
    if (n) console.log(`  ${String(lo).padStart(5)}~${hi === Infinity ? '  ∞' : String(hi).padStart(4)}：${String(n).padStart(3)} 块 ${'█'.repeat(Math.min(46, n))}`)
  }
  if (r.kept.length) console.log('保留并告警清单（大块是真东西，肉眼确认）：', r.kept.slice(0, 16).map((b) => `格${b.cell}:${b.area}px@(${b.cx},${b.cy})${b.nearBody ? '贴身' : '悬空'}`).join(' '))
}
