#!/usr/bin/env node
/**
 * compose-review.mjs — 跳过闸门，直接用同一套算子合成一份给人工检查的模型
 *
 * ## 为什么要有这个
 *
 * `run.ts` 会在出图闸门判 `unusable` 时拒绝构建。那是**对的**——流水线不该产出
 * 明知有瑕疵的包。但闸门判的是「切出来会不会缺一块」这类**几何**风险，
 * 判不了「这段动作读起来像不像挥手」——后者只有人眼能判。
 *
 * 所以这里用**完全相同的算子**（cutout → slice → normalize → pack）组一份，
 * 唯一区别是不跑闸门。产物明确标成检查版，不要当正式素材用。
 *
 * 用法：node compose-review.mjs <角色id> <出图前缀> <批名:网格> ...
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { op } from '../lib/control.mjs'
import { DEMO_ID } from './build.mjs'

const WORKSPACE = path.join(os.homedir(), '.lumii/workspace')
const RAW = path.join(WORKSPACE, 'outputs/pet-raw')
const REPO = path.resolve(import.meta.dirname, '../../..')
const RESOURCES = path.join(REPO, 'apps/windows/resources/pet-models')

const [charId, prefix, ...specs] = process.argv.slice(2)
const plans = JSON.parse(fs.readFileSync(new URL('./plans.json', import.meta.url), 'utf-8'))
const plan = plans[charId]
if (!plan) throw new Error(`未知角色 ${charId}`)

const work = path.join(WORKSPACE, 'outputs', `review-${charId}`)
fs.rmSync(work, { recursive: true, force: true })
const parts = path.join(work, 'parts')
fs.mkdirSync(parts, { recursive: true })

/** 批次名 → 帧名前缀，与 build.mjs 保持一致 */
const NAMES = {
  idle: (i) => `${prefix}_body_${String(i).padStart(2, '0')}`,
  wave: (i) => `${prefix}_wave_${String(i).padStart(2, '0')}`,
  face: (i) => ['eye_open', 'eye_shut', 'eye_happy', 'eye_sad'][i],
}

for (const spec of specs) {
  const [name, grid] = spec.split(':')
  const [cols, rows] = grid.split('x').map(Number)
  const cut = path.join(work, `${name}-cut.png`)
  const c = await op('cutout', { input: path.join(RAW, `${prefix}-${name}.png`), output: cut })
  if (!c.ok) throw new Error(`${name} cutout 失败：${c.error}`)
  const s = await op('slice', {
    input: cut, outDir: path.join(work, `${name}-cells`), cols, rows, prefix: name,
  })
  if (!s.ok) throw new Error(`${name} slice 失败：${s.error}`)
  for (const [i, cell] of s.result.cells.entries()) {
    fs.copyFileSync(cell.file, path.join(parts, `${NAMES[name](i)}.png`))
  }
  console.log(`  ${name} ${cols}×${rows} → ${s.result.cells.length} 帧`)
}

const normalized = path.join(work, 'normalized')
const n = await op('normalize', {
  dir: parts, outDir: normalized, canvas: plan.canvas,
  anchor: [Math.round(plan.canvas.w / 2), plan.canvas.h - 6],
})
if (!n.ok) throw new Error(`normalize 失败：${n.error}`)
if (n.result.clipped.length) console.log(`  ⚠ ${n.result.clipped.length} 帧被裁：${n.result.clipped.join(', ')}`)

// 差分取层（有表情批时）
for (const spec of specs) {
  const name = spec.split(':')[0]
  if (name !== 'face') continue
  const d = await op('diffLayer', {
    base: path.join(normalized, `${prefix}_body_00.png`),
    dir: normalized, outDir: normalized, names: ['eye_open', 'eye_shut', 'eye_happy', 'eye_sad'],
  })
  if (!d.ok) throw new Error(`diffLayer 失败：${d.error}`)
  for (const f of d.result.frames) console.log(`  表情层 ${f.name}: ${f.changed}px ${f.usable ? '✓' : '✗（铺得太开，检查用）'}`)
}

const pkgDir = path.join(work, 'pkg')
fs.rmSync(pkgDir, { recursive: true, force: true })
const pk = await op('pack', { dir: normalized, outDir: pkgDir, name: 'atlas' })
if (!pk.ok) throw new Error(`pack 失败：${pk.error}`)

const baseNames = ['idle'].flatMap((nm) =>
  Array.from({ length: 4 }, (_, i) => NAMES[nm](i)),
)
// 逐帧时长：首尾停得久、中间走得快（见 build.mjs 的 DURATIONS，理由相同）
const DUR = { idle: [420, 200, 420, 200], wave: [300, 200, 460, 240] }
const frame = (n2, first, dur) => ({
  ...(first ? { base: n2, ...(hasFace ? { face: { eyes: 'eye_open' } } : {}) } : { base: n2 }),
  ...(Number.isFinite(dur) ? { durationMs: dur } : {}),
})
const hasFace = specs.some((s) => s.startsWith('face:'))

// Idle Pin：把挥手的两端锚到待机首帧。
//
// 实测过为什么必须钉：待机四帧的重心都在 x≈191、包围盒 106–111 宽；挥手四帧的
// 包围盒是 128→169、重心右移 5–20px——**挥手首帧离待机很远**，
// 从待机进挥手、以及挥手播完回待机，两头都会跳。
//
// 钉法是**按名引用待机首帧**，不是让模型把待机姿势重画一遍：重画必然有漂移，
// 端点只是"看起来差不多"，接上去仍会顿一下。
const waveFrames = Array.from({ length: 4 }, (_, i) =>
  frame(`${prefix}_wave_${String(i).padStart(2, '0')}`, false, DUR.wave[i]),
)
const pin = await op('idlePin', {
  frames: waveFrames,
  idleFrame: frame(baseNames[0], true),
  group: 'Wave',
  next: 'Idle',
})
if (!pin.ok) throw new Error(`idlePin 失败：${pin.error}`)
for (const w of pin.result.warnings) console.log(`  ⚠ Idle Pin：${w}`)
/** 钉好的帧序列——**清单里用的是它，不是 `waveFrames`** */
const pinnedWave = pin.result.frames
console.log(`  Idle Pin：Wave ${waveFrames.length} → ${pinnedWave.length} 帧（两端锚到 ${baseNames[0]}）`)

// 点击命中区：从**待机首帧的轮廓**推。与 `pet-creator/run.ts` 里那一步同一件事，
// 只是这里直接调 op 而不是走技能。
//
// 不推的后果是静默的：渲染器的 `hitTestPolygons` 在 `hitAreas` 为空时恒返回 null，
// 而注册表里的 `tapMotions` 按 `HitAreaHead` / `HitAreaBody` 索引——两边对不上，
// 点击一路走到 return。实测日志里从头到尾没有过 `[playMotion] group="Wave"`。
const ha = await op('hitAreas', { dir: normalized, base: `${prefix}_body_00` })
if (!ha.ok) throw new Error(`hitAreas 失败：${ha.error}`)
console.log(`  命中区 ${ha.result.hitAreas.map((a) => a.id + '(' + a.points.length + '顶点)').join(' ')}`)
for (const w of ha.result.warnings) console.log(`  ⚠ ${w}`)

const manifest = {
  id: DEMO_ID[charId],
  rendererType: 'sprite',
  canvas: plan.canvas,
  anchor: [Math.round(plan.canvas.w / 2), plan.canvas.h - 6],
  atlas: 'atlas.png',
  atlasJson: 'atlas.json',
  ...(hasFace ? { slots: { face: { kind: 'layered', at: [0, 0], parts: { eyes: ['eye_open', 'eye_shut', 'eye_happy', 'eye_sad'] } } } } : {}),
  ...(ha.result.hitAreas.length > 0 ? { hitAreas: ha.result.hitAreas } : {}),
  animations: [
    { group: 'Idle', index: 0, kind: 'loop', fps: 4, frames: baseNames.map((n2, i) => frame(n2, i === 0, DUR.idle[i])), params: { bob: Math.max(1, Math.round(plan.canvas.h * 0.02)), breathe: 1.01, blink: 3200 } },
    { group: 'Talk', index: 0, kind: 'loop', fps: 8, frames: baseNames.map((n2, i) => frame(n2, i === 0)), params: { bob: 1 } },
    // Idle Pin：首末格按名引用待机首帧（见 pet-core 的 `model/idle-pin.ts`）。
    // 走 op 而不是在这里手写一遍——算法与判据只有一份。
    { group: 'Wave', index: 0, kind: 'once', next: 'Idle', fps: 8, frames: pinnedWave },
  ],
}
fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
fs.writeFileSync(path.join(pkgDir, 'pet.json'), JSON.stringify({ name: plan.name, scale: plan.scale, idleMotionGroup: 'Idle', talkMotionGroup: 'Talk', emotionMap: {}, tapMotions: {}, personaAddon: plan.persona }, null, 2))

const v = await op('validate', { dir: pkgDir })
if (!v.ok || !v.result.ok) throw new Error(`校验不过：${JSON.stringify(v.result?.errors ?? v.error)}`)
const inst = await op('install', { dir: pkgDir })
if (!inst.ok || !inst.result.ok) throw new Error(`安装失败：${inst.error ?? inst.result?.error}`)

const dest = path.join(RESOURCES, DEMO_ID[charId])
fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(dest, { recursive: true })
for (const f of ['manifest.json', 'atlas.png', 'atlas.json', 'pet.json']) {
  fs.copyFileSync(path.join(pkgDir, f), path.join(dest, f))
}
console.log(`\n✓ 检查版已合入 ${DEMO_ID[charId]}：图集 ${pk.result.size.w}×${pk.result.size.h}，${pk.result.entryCount} 帧`)
console.log(`  ⚠ 这是**跳过出图闸门**的检查版，不要当正式素材`)
