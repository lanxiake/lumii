#!/usr/bin/env node
/**
 * align-idle-frames.mjs — 把待机帧里"整只角色在左右平移"抹掉（只动图集，不动清单）
 *
 * ## 守的是哪条回归
 *
 * 用户 2026-09-22 报「待机时宠物看起来还是在左右摆动」。清单里 `Idle` 组**没有任何
 * sway/bob**（只有 `breathe` + `blink`），程序化那一层是干净的；线上量屏幕的左右缘
 * 也只动 3px/2px、相关系数 −0.91（对称张缩，不是整体平移）。横向的来源只剩素材本身。
 *
 * 逐帧量出来（`measure-sheet-drift.mjs`）：
 *
 *   · **包围盒中心**帧间只差 1px —— 看着像是对齐好的
 *   · **重心**却差 9.2px，且头/中/脚三条带**同向同幅**一起移动
 *
 * 也就是整只猫在帧间左右平移。这是**当初有意留下的**：管线 `motion-frames.mjs` 的
 * `snap` 步"用第 0 帧标定一个全局变换，应用到整段"，注释写着「逐帧对齐会让画面
 * 一帧一个缩放，播起来抖」。那条顾虑针对的是**缩放**——帧间缩放不一致会抖，
 * 而帧间**平移**不一致就是摇。本工具只消掉平移，不碰缩放。
 *
 * ## 为什么对齐到"组内第 0 帧"而不是重心均值
 *
 * 命中区（`hitAreas`）是**从待机首帧的轮廓**推出来的（见 `patch-hit-areas.mjs`）。
 * 对齐到首帧 ⇒ 首帧一个像素都不动 ⇒ 命中区**始终有效**，而且从此对**每一帧**都有效
 * （原先只有首帧对得上）。对齐到均值反而会让首帧也平移，把命中区推歪。
 *
 * ## 为什么可以只改像素不改清单
 *
 * 每帧占的格子大小不变，只把格**内**的像素整体平移，所以 `atlas.json` 的矩形、
 * `anchor`、`canvas` 全都不用动。命中区最多差 ±5 素材px（≈1.2 屏幕px），
 * 而它本来就是粗轮廓——不值得为这点量去重推多边形。
 *
 * 用法：
 *   node align-idle-frames.mjs <宠物包目录> [--group Idle] [--write]
 * 不加 --write 只报数（默认 dry-run）。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--'))
const write = args.includes('--write')
const groupArg = args.includes('--group') ? args[args.indexOf('--group') + 1] : null
if (!dir) {
  console.error('用法: node align-idle-frames.mjs <宠物包目录> [--group Idle] [--write]')
  process.exit(2)
}

const manifestPath = path.join(dir, 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const atlasJson = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf8'))
const atlasPath = path.join(dir, manifest.atlas ?? 'atlas.png')

/** 要处理的组：默认所有名字像"待机"的组（与 pet-core 的 `stripIdleDrift` 同一套匹配） */
const IDLE_RE = /idle|待机|stand/i
const groups = manifest.animations.filter((a) =>
  groupArg ? a.group === groupArg : IDLE_RE.test(a.group),
)
if (groups.length === 0) {
  console.error(`清单里没有匹配的待机组（--group ${groupArg ?? '(默认 /idle|待机|stand/)'}）`)
  process.exit(2)
}

/** 图集条目名 → 矩形。兼容 {frames:{n:{frame:{x,y,w,h}}}} 与 {n:{x,y,w,h}} 两种写法 */
function rectOf(name) {
  const e = atlasJson.frames?.[name] ?? atlasJson[name]
  if (!e) return null
  const f = e.frame ?? e
  return { x: f.x, y: f.y, w: f.w, h: f.h }
}

const { width, height } = await sharp(atlasPath).metadata()
const raw = await sharp(atlasPath).ensureAlpha().raw().toBuffer()
const CH = 4

/** 某帧的不透明像素水平重心（格内局部坐标）+ 左右可用余量 */
function measure(name) {
  const r = rectOf(name)
  if (!r) return null
  let sum = 0
  let n = 0
  let left = Infinity
  let right = -Infinity
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const a = raw[(y * width + x) * CH + 3]
      if (a <= 16) continue
      sum += x - r.x
      n++
      if (x - r.x < left) left = x - r.x
      if (x - r.x > right) right = x - r.x
    }
  }
  if (n === 0) return null
  return { rect: r, centroid: sum / n, n, left, right }
}

console.log(`宠物包 ${dir}`)
console.log(`图集 ${width}×${height}，待机组 ${groups.map((g) => g.group).join('、')}\n`)

const plan = []
for (const g of groups) {
  const names = g.frames.map((f) => f.base).filter(Boolean)
  const ms = names.map((nm) => ({ name: nm, m: measure(nm) }))
  const valid = ms.filter((x) => x.m)
  if (valid.length < 2) {
    console.log(`[${g.group}] 有效帧不足（${valid.length}），跳过`)
    continue
  }
  // 基准 = 组内第 0 帧（见文件头：命中区是从它推出来的）
  const ref = valid[0].m.centroid
  console.log(`[${g.group}] 基准帧 ${valid[0].name}（重心 ${ref.toFixed(1)}）`)
  console.log('  帧                 重心       dx      格内余量')
  for (const { name, m } of valid) {
    // 位移取负：把偏离的重心搬回基准处
    let dx = Math.round(ref - m.centroid)
    const roomLeft = m.left
    const roomRight = m.rect.w - 1 - m.right
    const clamped = Math.max(-roomLeft, Math.min(roomRight, dx))
    const clipped = clamped !== dx
    dx = clamped
    console.log(
      `  ${name.padEnd(16)}${m.centroid.toFixed(1).padStart(7)}${String(dx).padStart(9)}` +
        `${String(roomLeft).padStart(10)}/${roomRight}${clipped ? '  ⚠️ 被格边界夹住' : ''}`,
    )
    if (dx !== 0) plan.push({ name, rect: m.rect, dx })
  }
  const span = Math.max(...valid.map((v) => v.m.centroid)) - Math.min(...valid.map((v) => v.m.centroid))
  console.log(`  帧间重心极差 ${span.toFixed(1)} 素材px（× 缩放后才是屏幕px）\n`)
}

if (plan.length === 0) {
  console.log('✅ 已经是对齐的，无需改动')
  process.exit(0)
}

const maxDx = Math.max(...plan.map((p) => Math.abs(p.dx)))
console.log(`共 ${plan.length} 帧要移动，最大 ${maxDx} 素材px`)
if (!write) {
  console.log('\n（dry-run。加 --write 才写回图集）')
  process.exit(0)
}

// 先把要改的格子原样拷出来（同一格可能被多个组引用，只改一次）
const patched = raw
for (const { rect, dx } of plan) {
  const cell = Buffer.alloc(rect.w * rect.h * CH)
  for (let y = 0; y < rect.h; y++) {
    raw.copy(
      cell,
      y * rect.w * CH,
      ((rect.y + y) * width + rect.x) * CH,
      ((rect.y + y) * width + rect.x + rect.w) * CH,
    )
  }
  // 清空原格 → 按 dx 平移写回（格外的部分丢弃，前面已按余量夹过）
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const dst = ((rect.y + y) * width + rect.x + x) * CH
      for (let c = 0; c < CH; c++) patched[dst + c] = 0
    }
  }
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const sx = x - dx
      if (sx < 0 || sx >= rect.w) continue
      const src = (y * rect.w + sx) * CH
      const dst = ((rect.y + y) * width + rect.x + x) * CH
      for (let c = 0; c < CH; c++) patched[dst + c] = cell[src + c]
    }
  }
}

const bak = `${atlasPath}.bak`
if (!fs.existsSync(bak)) fs.copyFileSync(atlasPath, bak)
await sharp(patched, { raw: { width, height, channels: CH } }).png().toFile(atlasPath)
console.log(`\n✅ 已写回 ${atlasPath}（原件备份 ${path.basename(bak)}）`)
console.log('  重跑 measure-sheet-drift.mjs 应看到重心极差降到 ≤2px')
