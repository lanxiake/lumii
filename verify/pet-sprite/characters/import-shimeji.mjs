#!/usr/bin/env node
/**
 * import-shimeji.mjs — 把一张 Shimeji 精灵表导成 Lumii 宠物包
 *
 * ## 为什么用它来做技术验证
 *
 * 之前三只示范宠物全是 AI 直出的 4 格图，问题很集中：**帧太少、过不了闸门、
 * 也没有 ground truth**——「这段动作读起来顺不顺」没有正确答案可比。
 * Shimeji 表是**真人逐帧画的多帧动画**，一行一个动作、格 = 128×128，
 * 于是「加帧 / 逐帧时长 / Idle Pin / 姿态差异度 QA」这些题目第一次有了**正确的参照物**。
 *
 * ## 行语义不靠猜
 *
 * 行的含义取自 `AI-desktop-pets` 的 `PetState` 枚举与 `SpriteConfig.DEFAULT_STATES`
 * （`spriteLine` 从 1 起）：
 *
 *   | row | 状态  | 帧数 | loop | fps |
 *   |-----|-------|------|------|-----|
 *   | 0   | STAND | 1    | ✓    | 9   |
 *   | 1   | WALK  | 4    | ✓    | 9   |
 *   | 2   | SIT   | 1    | ✓    | 9   |
 *   | 3   | GREET | 8    | ✗    | 9   |
 *   | 4   | JUMP  | 1    | ✓    | 9   |
 *   | 5   | FALL  | 3    | ✗    | 9   |
 *   | 6   | DRAG  | 1    | ✓    | 9   |
 *   | 7   | CRAWL | 8    | ✓    | 9   |
 *   | 8   | CLIMB | 8    | ✓    | 9   |
 *
 * `sheet-rows.mjs` 独立量出来的帧数**九行全部对上**（1/4/1/8/1/3/1/8/8），
 * 所以这份语义是验证过的，不是照抄的。
 *
 * ## 这条链路**跳过 normalize**，这是有意的
 *
 * `normalize` 是为「AI 直出图集」准备的：那种图各格取景与尺度都不统一，必须逐格对齐。
 * Shimeji 表**本来就共用同一个坐标系**（画师就是按同一画布画的），再对齐一次只会
 * 把地线 127 这种有效信息抹掉，还可能因为共同倍率把角色缩掉一圈。
 * 所以这里只做**裁剪**（把用到的帧的并集包围盒裁出来，像素一个不缩放），
 * 这本身也是一条判据：**已经规整的输入不该过归一化**。
 *
 * 用法：node import-shimeji.mjs <表文件名> [--id <宠物id>] [--margin 2] [--no-install]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runPetAssetOp, describeRoots } from './_ipc.built.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const require = createRequire(path.join(REPO, 'package.json'))
const sharp = require('sharp')

const SHEET_DIR =
  process.env.SHEET_DIR ??
  'C:/myself/projects/my/open-source/AI-desktop-pets/app/src/main/res/drawable-nodpi'
const CELL = 128
const RESOURCES = path.join(REPO, 'apps/windows/resources/pet-models')

const args = process.argv.slice(2)
const sheetName = args.find((a) => !a.startsWith('--'))
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? dflt : args[i + 1]
}
const has = (name) => args.includes(`--${name}`)

const id = opt('id', `demo_${path.basename(sheetName, '.png')}`)
const MARGIN = Number(opt('margin', '2'))

/** `PetState` 的行语义（0 起，与 `spriteLine - 1` 对应） */
const ROWS = {
  STAND: 0,
  WALK: 1,
  SIT: 2,
  GREET: 3,
  JUMP: 4,
  FALL: 5,
  DRAG: 6,
  CRAWL: 7,
  CLIMB: 8,
}

/**
 * 每行的**声明帧数**，取自 `AI-desktop-pets` 的 `PetState` / `DEFAULT_STATES`。
 *
 * ⚠ 为什么不能只按「这一行有几格有内容」数帧——**踩过**：
 * `shimeji_nekojapan.png` 的第 0 行有 9 格，但 9 格的包围盒全等（45×36）、
 * 两两姿态差异 0.0，也就是**把同一帧复制填满了整行**。
 * 按内容数会得出「待机有 9 帧」，而它声明的 `frameMax` 是 1。
 * 所以这里以声明值为准，内容只用来**交叉校验**：少了报缺帧，多了当填充丢掉。
 */
const DECLARED = { STAND: 1, WALK: 4, SIT: 1, GREET: 8, JUMP: 1, FALL: 3, DRAG: 1, CRAWL: 8, CLIMB: 8 }

/**
 * 出哪些动作组。
 *
 * `Idle` 用**单帧 STAND** 而不是某个循环行：单帧正好把「角色动不动」全部交给
 * 程序化原语（`bob`/`breathe`），这是 Lumii 的一条核心下注，值得单独验。
 * `WALK` 那 4 帧则提供一条**真·多帧循环**，用来验逐帧时长与循环衔接。
 */
const GROUPS = [
  { group: 'Idle', from: 'STAND', kind: 'loop', fps: 9, clip: (id) => `${id}_stand_00` },
  { group: 'Walk', from: 'WALK', kind: 'loop', fps: 9, clip: (id, i) => `${id}_walk_${p2(i)}` },
  { group: 'Talk', from: 'STAND', kind: 'loop', fps: 9, clip: (id) => `${id}_stand_00` },
  // 一次性动作的两端会由 idlePin 换成待机首帧（见下）
  { group: 'Wave', from: 'GREET', kind: 'once', next: 'Idle', fps: 9, pin: true, clip: (id, i) => `${id}_greet_${p2(i)}` },
]
const p2 = (i) => String(i).padStart(2, '0')

async function op(name, a) {
  const r = await runPetAssetOp({ op: name, args: a })
  if (!r.ok) throw new Error(`${name} 失败：${r.error}`)
  return r.result
}

// ---------------------------------------------------------------------------

const file = path.join(SHEET_DIR, sheetName)
const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width: W, height: H, channels: C } = info
if (W % CELL || H % CELL) throw new Error(`${sheetName} 的 ${W}×${H} 不是 ${CELL} 的整数倍`)
const cols = W / CELL
const rows = H / CELL
console.log(`${sheetName}  ${W}×${H} → ${cols}×${rows} 格（格 ${CELL}）`)

/** 一格的不透明像素数与包围盒（格内坐标） */
function cellStat(c, r) {
  let n = 0
  let x0 = 1e9
  let x1 = -1
  let y0 = 1e9
  let y1 = -1
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const px = c * CELL + x
      const py = r * CELL + y
      if (data[(py * W + px) * C + (C - 1)] > 8) {
        n++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return { n, x0, x1, y0, y1 }
}

// 每个用到的行「有几帧」= min(声明值, 实际有内容的格数)
//
// 少了（实际 < 声明）说明这张表缺帧，报出来但不拦——缺一帧照样能播；
// 多了（实际 > 声明）几乎总是「把单帧复制填满整行」（nekojapan 的第 0 行就是这样），
// 取声明值即可，多出来的当填充丢掉。
const rowFrames = {}
for (const from of new Set(GROUPS.map((g) => g.from))) {
  const r = ROWS[from]
  let last = -1
  for (let c = 0; c < cols; c++) if (cellStat(c, r).n > 0) last = c
  if (last < 0) throw new Error(`行 ${r}（${from}）整行是空的，${sheetName} 可能不是这套排布`)
  const measured = last + 1
  const declared = Number(opt('frames-' + from, DECLARED[from]))
  if (measured < declared) {
    console.log(`    ⚠ ${from}：声明 ${declared} 帧，这一行只画了 ${measured} 格，按 ${measured} 帧出`)
  } else if (measured > declared) {
    console.log(`    · ${from}：这一行有 ${measured} 格但声明 ${declared} 帧——多出的 ${measured - declared} 格是填充，丢掉`)
  }
  rowFrames[from] = Math.min(declared, measured)
}
console.log(
  '  行帧数：' +
    Object.entries(rowFrames)
      .map(([k, v]) => `${k}(${ROWS[k]})=${v}`)
      .join('  '),
)

// 用到的帧的并集包围盒 —— 所有动作共用一条地线，裁剪必须**一起**算
let ux0 = 1e9
let ux1 = -1
let uy0 = 1e9
let uy1 = -1
for (const g of GROUPS) {
  const r = ROWS[g.from]
  for (let c = 0; c < rowFrames[g.from]; c++) {
    const s = cellStat(c, r)
    if (s.n === 0) continue
    if (s.x0 < ux0) ux0 = s.x0
    if (s.x1 > ux1) ux1 = s.x1
    if (s.y0 < uy0) uy0 = s.y0
    if (s.y1 > uy1) uy1 = s.y1
  }
}
// 地线：所有帧里最大的 y1。它必须留在画布里，锚点就落在它上面
const groundY = uy1

const left = Math.max(0, ux0 - MARGIN)
const top = Math.max(0, uy0 - MARGIN)
const cropW = Math.min(CELL, ux1 + MARGIN + 1) - left
const cropH = Math.min(CELL, uy1 + MARGIN + 1) - top
const canvas = { w: cropW, h: cropH }
const anchor = [Math.round(cropW / 2), groundY - top]
console.log(
  `  并集包围盒 x${ux0}..${ux1} y${uy0}..${uy1}（地线 ${groundY}）→ 画布 ${cropW}×${cropH}，锚点 (${anchor})`,
)

const work = path.join(os.homedir(), '.lumii', 'workspace', 'outputs', `shimeji-${id}`)
fs.rmSync(work, { recursive: true, force: true })
const parts = path.join(work, 'parts')
fs.mkdirSync(parts, { recursive: true })

/** 把某一行的前 n 格裁进公共画布，写到 parts/ */
async function emitRow(g) {
  const r = ROWS[g.from]
  const n = rowFrames[g.from]
  const names = []
  for (let c = 0; c < n; c++) {
    const name = g.clip(id, c)
    names.push(name)
    await sharp(data, { raw: { width: W, height: H, channels: C } })
      .extract({ left: c * CELL + left, top: r * CELL + top, width: cropW, height: cropH })
      .png()
      .toFile(path.join(parts, `${name}.png`))
  }
  return names
}

const namesByGroup = {}
for (const g of GROUPS) {
  if (namesByGroup[g.from]) continue // Idle 与 Talk 共用 STAND，只裁一次
  namesByGroup[g.from] = await emitRow(g)
  console.log(`  ${g.from} → ${namesByGroup[g.from].length} 帧`)
}

// ---- pack ----
const pkgDir = path.join(work, 'pkg')
fs.rmSync(pkgDir, { recursive: true, force: true })
const packed = await op('pack', { dir: parts, outDir: pkgDir, name: 'atlas' })
console.log(`  图集 ${packed.size.w}×${packed.size.h}，${packed.entryCount} 条`)

// ---- 清单 ----
const dur = (fps) => Math.round(1000 / fps)
const standNames = namesByGroup.STAND
const idleFrame = { base: standNames[0], durationMs: dur(9) }

const animations = []
for (const g of GROUPS) {
  const names = namesByGroup[g.from]
  let frames = names.map((n, i) => ({ base: n, durationMs: dur(g.fps) }))
  if (g.pin) {
    // Idle Pin：一次性动作的首末格按名引用待机首帧。
    // Shimeji 的 GREET 首帧**本来就是站姿**（它是一段从站姿出发又回到站姿的动作），
    // 所以这里钉的是「同一张图」而不是「看起来差不多的两张」——正好是判据要的形态。
    const pinned = await op('idlePin', {
      frames,
      idleFrame,
      group: g.group,
      next: g.next,
    })
    for (const w of pinned.warnings) console.log(`    ⚠ Idle Pin：${w}`)
    console.log(`    Idle Pin：${g.group} ${frames.length} → ${pinned.frames.length} 帧`)
    frames = pinned.frames
  }
  animations.push({
    group: g.group,
    index: 0,
    kind: g.kind,
    ...(g.next ? { next: g.next } : {}),
    fps: g.fps,
    frames,
    // 单帧待机靠程序化原语活起来——这是设计里「运行时做动画」那条下注的落点
    ...(g.group === 'Idle'
      ? { params: { bob: Math.max(1, Math.round(cropH * 0.06)), breathe: 1.02, sway: 1.5 } }
      : {}),
  })
}

// ---- 命中区 ----
const ha = await op('hitAreas', { dir: parts, base: standNames[0] })
console.log(`  命中区 ${ha.hitAreas.map((a) => a.id + '(' + a.points.length + '顶点)').join(' ')}`)
for (const w of ha.warnings) console.log(`    ⚠ ${w}`)

const manifest = {
  id,
  rendererType: 'sprite',
  canvas,
  anchor,
  atlas: 'atlas.png',
  atlasJson: 'atlas.json',
  ...(ha.hitAreas.length > 0 ? { hitAreas: ha.hitAreas } : {}),
  animations,
}
fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
fs.writeFileSync(
  path.join(pkgDir, 'pet.json'),
  JSON.stringify(
    {
      name: id,
      scale: 2.2,
      idleMotionGroup: 'Idle',
      talkMotionGroup: 'Talk',
      emotionMap: {},
      tapMotions: {},
      personaAddon: '你是一只安静的小猫。',
    },
    null,
    2,
  ),
)

// `validate` 的返回**就是** `PetPackageValidation` 本体（`{ok, errors, warnings}`），
// 不像别的 op 外面还包一层 —— 这里踩过一次「读 `.result.ok` 读到 undefined」。
const v = await op('validate', { dir: pkgDir })
if (!v.ok) throw new Error(`校验不过：${JSON.stringify(v.errors)}`)
for (const w of v.warnings ?? []) console.log(`    ⚠ ${w}`)
console.log('  ✓ validate 通过')

const dest = path.join(RESOURCES, id)
fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(dest, { recursive: true })
for (const f of ['manifest.json', 'atlas.png', 'atlas.json', 'pet.json']) {
  fs.copyFileSync(path.join(pkgDir, f), path.join(dest, f))
}
console.log(`  已写入 ${path.relative(REPO, dest)}`)

if (!has('no-install')) {
  const inst = await op('install', { dir: pkgDir })
  if (!inst.ok || !inst.result.ok) throw new Error(`安装失败：${inst.error ?? inst.result?.error}`)
  console.log(`  已装到 ${describeRoots().userPetDir}`)
}
console.log(`\n✓ ${id}：${animations.reduce((a, g) => a + g.frames.length, 0)} 帧，${animations.length} 组`)
