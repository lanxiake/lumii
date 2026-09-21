#!/usr/bin/env node
/**
 * make-preview.mjs — 给「精灵宠物预览页」出素材和数据
 *
 * ## 它补的是哪一段
 *
 * 链路是 `plans.json`（计划）→ `drive-gen.mjs`（AI 出图，落 pet-raw/）→
 * `build.mjs`（抠底→切格→归一→差分→打包）→ `pet-models/`（产物）。
 * 已有的 `make-viewer.mjs` 只读**最后一段**——它看得到图集，看不到**出图**。
 *
 * 而"生成图片的质量"恰恰只能在这一段之间看：AI 出的那张网格图，格子画歪了、
 * 串格了、背景没抠净，到了图集里都已经成了"事实"，看不出来源。
 * 所以本脚本把**三层摆到同一页**：
 *
 *   原始出图（大图 + 网格）→ 切好的关键帧（逐帧缩略图 + 包围盒）→ 合成播放
 *
 * ## 为什么数据和页面分家
 *
 * 页面 `review/index.html` 是**手写**的，本脚本只产 `review/models.js` 和 `assets/`。
 * 理由是踩过的：`make-viewer.mjs` 把整页塞进模板字符串，注释里一个反引号就把
 * 字符串截断，`node` 只抛语法错、产物不更新，而校验脚本照样把**上一次的旧页面**
 * 验通过。手写的页面在编辑器里就能看见语法错，生成器只管数据，各司其职。
 *
 * ## 名字的唯一来源是**产物**，不是计划
 *
 * "哪一格对应哪个帧"不去猜规则，而是拿 `plans.json` 的网格 × `build.mjs` 的命名
 * 拼出名字，再**逐个到 manifest 里核对**。对不上就报出来——build 侧换了命名法，
 * 这里立刻红灯，而不是静默显示一张错位的图。
 *
 * 用法：node make-preview.mjs [--keep]      --keep 保留 assets 里已有的图（不重拷）
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PREFIX, RAW_DIR } from './drive-gen.mjs'
import { DEMO_ID } from './build.mjs'
import { SHEET_DIR, CELL, ROWS, DECLARED, GROUPS } from './shimeji-sheet.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const require = createRequire(path.join(REPO, 'package.json'))
const sharp = require('sharp')

const MODELS = path.join(REPO, 'apps/windows/resources/pet-models')
const REVIEW = path.join(REPO, 'verify/pet-sprite/review')
const ASSETS = path.join(REVIEW, 'assets')
const KEEP = process.argv.includes('--keep')

const plans = JSON.parse(fs.readFileSync(path.join(HERE, 'plans.json'), 'utf-8'))
/** 目录名（= 宠物 id）→ 计划键。`DEMO_ID` 是正向的，这里反过来用，避免第二份映射 */
const AI_CHAR = Object.fromEntries(Object.entries(DEMO_ID).map(([k, v]) => [v, k]))

/** 不透明阈值，与 `import-shimeji.mjs` / `qa-animation.mjs` 取同一个 */
const ALPHA = 8

const p2 = (i) => String(i).padStart(2, '0')

// ---------------------------------------------------------------------------
// 素材搬运
// ---------------------------------------------------------------------------

let copied = 0
let skipped = 0

/** 把一张图拷进 assets/，返回页面用的相对路径；源不存在时返回 null */
function copyAsset(src, name) {
  if (!src || !fs.existsSync(src)) return null
  const dest = path.join(ASSETS, name)
  if (KEEP && fs.existsSync(dest)) {
    skipped++
    return `assets/${name}`
  }
  fs.copyFileSync(src, dest)
  copied++
  return `assets/${name}`
}

// ---------------------------------------------------------------------------
// 图集：读一次到内存，逐帧量包围盒
// ---------------------------------------------------------------------------

/**
 * 一张图集的像素与逐帧统计。
 *
 * 包围盒是**逐帧单独**量的，不共用：切图流水线已经做过对齐，这里要量的是
 * 「对齐之后还剩多少抖动」。共用包围盒会把抖动平均掉，那就白量了。
 */
async function readAtlas(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, W: info.width, H: info.height, C: info.channels }
}

/**
 * 一帧的不透明包围盒（画布坐标系）与像素数。
 * 空帧返回 null——它本身就是一条判据：图集里有整帧透明，说明切图或抠底出了事。
 */
function frameStats(atlas, box) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  let n = 0
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const px = box.x + x
      const py = box.y + y
      if (atlas.data[(py * atlas.W + px) * atlas.C + (atlas.C - 1)] > ALPHA) {
        n++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return n === 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, n }
}

/**
 * 每一格的**内容占比**——"这格里有多少像素是画了东西的"。
 *
 * 用来区分两种"没被引用的格"：本来就没画东西的与**画了却没进任何动作**的。
 * 后者是真问题：它意味着这一批出了图、切了格，但没被 build 采用
 * （实测 `demo_cartoon_cat` 的表情批就是这样——4 格画满了猫脸，
 * manifest 里却一个 face 槽都没有）。只看网格线，这两种长得一模一样。
 *
 * **判据按图源分两路**：有 alpha 通道的（Shimeji 表）直接看 alpha；
 * 没有的（AI 直出的图是纯色背景、RGB 三通道）拿**背景色距离**判——
 * 那个色号是 `plans.json` 里声明过的，距离阈值取 90，远低于它对角色颜色算出的
 * `minDistance`（实测 234），所以不会把角色自身的像素误判成背景。
 */
async function cellFills(file, cols, rows, bgHex) {
  const meta = await sharp(file).metadata()
  const byAlpha = !!meta.hasAlpha
  const bg = bgHex && !byAlpha ? hexRgb(bgHex) : null
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  const out = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * W) / cols)
      const x1 = Math.floor(((c + 1) * W) / cols)
      const y0 = Math.floor((r * H) / rows)
      const y1 = Math.floor(((r + 1) * H) / rows)
      let n = 0
      let tot = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * W + x) * C
          tot++
          if (byAlpha) {
            if (data[o + 3] > ALPHA) n++
          } else {
            const dr = data[o] - bg[0]
            const dg = data[o + 1] - bg[1]
            const db = data[o + 2] - bg[2]
            if (Math.sqrt(dr * dr + dg * dg + db * db) > BG_DIST) n++
          }
        }
      }
      out.push(tot ? n / tot : 0)
    }
  }
  return out
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const BG_DIST = 90

// ---------------------------------------------------------------------------
// 原始出图：格子 → 帧名
// ---------------------------------------------------------------------------

/**
 * 一只 AI 直出宠物的三批原始图。
 *
 * 批次顺序与 `build.mjs` 的 `buildParams` **逐位对应**（它是唯一写死这件事的地方）：
 * 0 待机 → 1 挥手 → 2 表情。命名法也来自那里（`{prefix}_body_{NN}` / `{prefix}_wave_{NN}`）。
 * 这层耦合没法消除——原始图没有内嵌任何元数据，谁切的图只有切图的人知道。
 * 所以这里配一道**核对**：拼出来的名字必须逐个在 manifest 里找得到，找不到就抛。
 */
async function aiSources(charId, manifest, prefix) {
  const b = plans[charId].plan.batches
  const eyes = manifest.slots?.face?.parts?.eyes ?? []
  const groups = manifest.animations ?? []

  /** 该名字出现在哪些组里——页面用它做「选中动作组 → 高亮原图格子」 */
  const usesOf = (name) =>
    name ? groups.filter((g) => g.frames.some((f) => (f.base ?? f) === name)).map((g) => g.group) : []
  const inFace = (name) => Object.values(manifest.slots ?? {}).some((s) =>
    Object.values(s.parts ?? {}).some((arr) => arr.includes(name)),
  )

  const spec = [
    { key: 'idle', tag: 'body', label: '待机批', batch: b[0], names: (n) => Array.from({ length: n }, (_, i) => `${prefix}_body_${p2(i)}`) },
    { key: 'wave', tag: 'wave', label: '挥手批', batch: b[1], names: (n) => Array.from({ length: n }, (_, i) => `${prefix}_wave_${p2(i)}`) },
    { key: 'face', tag: 'face', label: '表情批', batch: b[2], names: () => eyes },
  ]

  const out = []
  const missing = []
  for (const s of spec) {
    if (!s.batch) continue // 计划里没有这一批（--no-face 构建过）
    const cols = s.batch.cols
    const rows = s.batch.rows
    const cells = s.names(cols * rows)
    const file = copyAsset(
      path.join(RAW_DIR, `${prefix}-${s.key}.png`),
      `${manifest.id}.raw-${s.key}.png`,
    )
    if (!file) {
      console.log(`    · ${s.label}：原始图不在（${prefix}-${s.key}.png），只显示关键帧`)
      continue
    }
    const assetPath = path.join(ASSETS, path.basename(file))
    const meta = await sharp(assetPath).metadata()
    const fills = await cellFills(assetPath, cols, rows, plans[charId].plan.background.hex)
    const cellList = []
    for (let i = 0; i < cols * rows; i++) {
      const name = cells[i] ?? null
      const known = name && (groups.some((g) => g.frames.some((f) => (f.base ?? f) === name)) || inFace(name))
      if (name && !known) missing.push(`${s.label} 第 ${i} 格 → "${name}" 在 manifest 里找不到`)
      cellList.push({
        col: i % cols,
        row: Math.floor(i / cols),
        name: known ? name : null,
        uses: known ? usesOf(name) : [],
        fill: fills[i],
      })
    }
    out.push({
      label: `${s.label}（${cols}×${rows}）`,
      kind: 'grid',
      file,
      size: { w: meta.width, h: meta.height },
      cols,
      rows,
      cells: cellList,
    })
  }

  if (missing.length > 0) {
    throw new Error(
      `${manifest.id}：出图命名与 manifest 对不上——\n  ${missing.join('\n  ')}\n` +
        'build.mjs 的命名法改过了？先去核对再继续，别让页面显示一张错位的图。',
    )
  }
  return out
}

/**
 * Shimeji 原表：**整张表**当一张原始出图，每个格子按行归到对应的动作组。
 *
 * 表名是拼出来的（`shimeji_{短名}.png`）。这是约定不是保证，所以找不到就**静默降级**
 * 成"没有原始图"——这五只是对照组，源表在另一个仓库里，缺了不该让整套预览跑不起来。
 *
 * 格子归属由 `shimeji-sheet.mjs` 的行语义给出，**用的是 `DECLARED` 而不是数出来的**：
 * 表和帧的对应关系就是"画师按那 9 行画的"，声明帧数是这套关系的定义。
 * 真画的格数少了（缺帧），`import-shimeji.mjs` 会报出来；这里按声明走，
 * 最多是把不存在的格画成高亮，不会指错行。
 */
async function shimejiSources(id, manifest) {
  const file = path.join(SHEET_DIR, `shimeji_${id.replace(/^demo_shimeji_/, '')}.png`)
  if (!fs.existsSync(file)) {
    console.log(`    · 找不到原表 ${path.basename(file)}，只显示关键帧`)
    return []
  }
  const meta = await sharp(file).metadata()
  const cols = Math.floor(meta.width / CELL)
  const rows = Math.floor(meta.height / CELL)

  // (row,col) → 格。Idle 与 Talk 共用 STAND 行，所以同名帧会被写两次，
  // 要**合并**而不是覆盖——漏掉的话选中 Talk 时原图不高亮。
  const byCell = new Map()
  const groups = manifest.animations ?? []
  const missing = []
  for (const g of GROUPS) {
    const row = ROWS[g.from]
    for (let i = 0; i < DECLARED[g.from]; i++) {
      const key = row + ',' + i
      let c = byCell.get(key)
      if (!c) {
        const name = g.clip(id, i)
        if (!groups.some((x) => x.frames.some((f) => (f.base ?? f) === name))) missing.push(`${g.group} 第 ${i} 格 → "${name}"`)
        c = { row, col: i, name, uses: [] }
        byCell.set(key, c)
      }
      if (!c.uses.includes(g.group)) c.uses.push(g.group)
    }
  }
  if (missing.length > 0) {
    throw new Error(`${id}：原表的行语义与 manifest 对不上——\n  ${missing.join('\n  ')}`)
  }

  const asset = copyAsset(file, `${id}.sheet.png`)
  const fills = await cellFills(path.join(ASSETS, path.basename(asset)), cols, rows)
  const cells = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hit = byCell.get(r + ',' + c)
      cells.push(hit ? { ...hit, fill: fills[r * cols + c] } : { row: r, col: c, name: null, uses: [], fill: fills[r * cols + c] })
    }
  }
  return [
    {
      label: `整表（${cols}×${rows} 格，用 ${byCell.size} 格）`,
      kind: 'grid',
      file: asset,
      size: { w: cols * CELL, h: rows * CELL },
      cols,
      rows,
      cells,
      note: 'Crawl 行在切图时做过垂直翻转（表里是正着横躺的）',
    },
  ]
}

/**
 * 组内**不同名却逐像素完全相同**的帧对。
 *
 * 同名重复不算——那是 Idle Pin 有意为之（一次性动作的首末帧都按名引用待机首帧），
 * 是设计不是毛病。要抓的是"两个不同的帧名画的是同一张图"：
 *
 * · 真人素材也会这样。实测 `demo_shimeji_nekojapan` 的 Walk 第 0 格与第 2 格
 *   **逐字节相同**（在原表里就已经相同，不是切图切错），4 帧其实只有 3 个姿势。
 * · AI 更常这样——那是"四格看起来没区别"的静默版本，
 *   比 `qa-animation` 的 `poseMax`（最不像的两帧有多像）更细一层：
 *   一堆帧里只要有两帧撞了，`poseMax` 照样很大，看不出来。
 */
function duplicateFrames(atlas, animations, frames, boxes) {
  const same = (na, nb) => {
    const a = frames[na]
    const b = frames[nb]
    if (!a || !b || a.w !== b.w || a.h !== b.h) return false
    const ba = boxes[na]
    const bb = boxes[nb]
    // 先比包围盒与像素数——不同就直接出局，省掉逐像素那一趟
    if (!ba || !bb || ba.n !== bb.n || ba.w !== bb.w || ba.h !== bb.h) return false
    const { data, W, C } = atlas
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        const oa = ((a.y + y) * W + a.x + x) * C
        const ob = ((b.y + y) * W + b.x + x) * C
        for (let k = 0; k < C; k++) if (data[oa + k] !== data[ob + k]) return false
      }
    }
    return true
  }

  const out = {}
  for (const anim of animations) {
    const pairs = []
    for (let i = 0; i < anim.frames.length; i++) {
      for (let j = i + 1; j < anim.frames.length; j++) {
        const ni = anim.frames[i].base
        const nj = anim.frames[j].base
        if (!ni || !nj || ni === nj) continue
        if (same(ni, nj)) pairs.push({ i, j, a: ni, b: nj })
      }
    }
    if (pairs.length) out[anim.group] = pairs
  }
  return out
}

// ---------------------------------------------------------------------------
// 组装一只模型
// ---------------------------------------------------------------------------

async function buildModel(id) {
  const dir = path.join(MODELS, id)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
  const atlasJson = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf-8'))
  const pet = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf-8'))
  const atlasFile = atlasJson.meta?.image ?? manifest.atlas ?? 'atlas.png'

  const atlasAsset = copyAsset(path.join(dir, atlasFile), `${id}.atlas.png`)
  const atlas = await readAtlas(path.join(ASSETS, path.basename(atlasAsset)))

  // 帧矩形 + 包围盒
  const boxes = {}
  const frames = {}
  for (const [name, e] of Object.entries(atlasJson.frames ?? {})) {
    const b = e.frame ?? e
    frames[name] = { x: b.x, y: b.y, w: b.w, h: b.h }
    boxes[name] = frameStats(atlas, b)
  }

  // 动作组：把帧引用统一成 `base` + `durationMs`，**其余键原样留着**——
  // 槽位引用（`face.eyes`）就在其余键里，页面要按它叠表情层。
  // 槽位是**差分**语义：某帧没声明就沿用上一帧的部件，页面得自己维护这个状态。
  const animations = (manifest.animations ?? []).map((a) => ({
    group: a.group,
    kind: a.kind,
    next: a.next ?? null,
    fps: a.fps ?? 6,
    params: a.params ?? null,
    frames: (a.frames ?? []).map((f) => ({
      ...f,
      base: f.base ?? null,
      durationMs: f.durationMs ?? (a.fps > 0 ? Math.round(1000 / a.fps) : 100),
    })),
  }))

  const charId = AI_CHAR[id]
  const sources = charId ? await aiSources(charId, manifest, PREFIX[charId]) : await shimejiSources(id, manifest)

  const empty = Object.entries(boxes).filter(([, v]) => !v).map(([k]) => k)
  if (empty.length > 0) console.log(`    ⚠ ${id}：图集里有整帧透明——${empty.join(' ')}`)

  return {
    id,
    name: pet.name ?? id,
    family: charId ? 'ai' : 'shimeji',
    // 缩放采样：Shimeji 是逐像素画的，放大要用 nearest 保住方块；
    // AI 直出的是平滑插画，nearest 会在缩小时把描边打成锯齿。
    pixelated: !charId,
    scale: pet.scale ?? 1,
    canvas: manifest.canvas,
    anchor: manifest.anchor,
    perchGaps: manifest.perchGaps ?? null,
    slots: manifest.slots ?? {},
    hitAreas: (manifest.hitAreas ?? []).map((h) => h.id),
    atlas: { file: atlasAsset, size: { w: atlas.W, h: atlas.H } },
    frames,
    boxes,
    animations,
    duplicates: duplicateFrames(atlas, animations, frames, boxes),
    sources,
  }
}

// ---------------------------------------------------------------------------

// 只重建 assets/——`review/index.html` 是**手写**的，脚本不碰它。
if (!KEEP) fs.rmSync(ASSETS, { recursive: true, force: true })
fs.mkdirSync(ASSETS, { recursive: true })

const ids = fs
  .readdirSync(MODELS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
  .map((d) => d.name)
  .filter((d) => fs.existsSync(path.join(MODELS, d, 'manifest.json')))
  .sort()

const models = []
for (const id of ids) {
  console.log(`\n### ${id}`)
  const m = await buildModel(id)
  console.log(
    `  ${m.animations.length} 组 · 图集 ${m.atlas.size.w}×${m.atlas.size.h} · ` +
      `${Object.keys(m.frames).length} 帧 · 原始图 ${m.sources.length} 张 · ` +
      `画布 ${m.canvas.w}×${m.canvas.h} scale ${m.scale}`,
  )
  models.push(m)
}

const data = {
  generatedAt: new Date().toISOString(),
  models,
}
fs.writeFileSync(
  path.join(REVIEW, 'models.js'),
  `// 由 make-preview.mjs 生成，不要手改。页面是 index.html。\nwindow.PET_REVIEW = ${JSON.stringify(data, null, 1)}\n`,
)

console.log(
  `\n✓ ${models.length} 只模型 · 图 ${copied} 张已拷${skipped ? `、${skipped} 张复用` : ''}\n` +
    `  ${path.relative(REPO, path.join(REVIEW, 'index.html'))}  （双击即可打开）`,
)
