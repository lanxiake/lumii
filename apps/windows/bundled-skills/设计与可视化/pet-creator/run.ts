#!/usr/bin/env node
/**
 * pet-creator — 宠物制作流水线（可执行技能入口）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §3.2 / §5.1
 *
 * ## 职责边界（重要）
 *
 * **本脚本不做判断**，只做确定性的像素操作：
 *   抠底 → 切格 → 按地线对齐 → 打包图集 → 写清单 → 校验 → 安装
 *
 * 「出几张图、每张几格、每格叫什么、哪些是待机哪些是动作」全部由 SKILL.md 编排的
 * Agent 决定，通过 SKILL_PARAMS 传进来。把判断塞进脚本会让它在遇到没见过的情况时
 * 只能猜，而猜错的代价是整批素材报废。
 *
 * ## 为什么走 HTTP 而不是 import 工具链
 *
 * 技能目录是 Agent 可写区，且本脚本由宿主用子进程执行、**解析不到 workspace 包**。
 * 工具链（sharp + pet-core）在客户端主进程里已经打包好了，控制口 `/pet/asset`
 * 是 dev 与打包**同一条**路径——详见解说见 main/pet/pet-asset-ipc.ts。
 *
 * ## 协议
 *
 * 参数来自 `process.env.SKILL_PARAMS`（JSON）；结果以 `__SKILL_RESULT__:{json}` 打到 stdout。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RESULT_PREFIX = '__SKILL_RESULT__:'

// ---------------------------------------------------------------------------
// 入参
// ---------------------------------------------------------------------------

function readParams() {
  const raw = process.env.SKILL_PARAMS
  if (!raw) throw new Error('缺少 SKILL_PARAMS')
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`SKILL_PARAMS 不是合法 JSON：${err.message}`)
  }
}

function dataRoot() {
  return process.env.LUMII_CLIENT_DATA_DIR || path.join(os.homedir(), '.lumii')
}

/** 控制口的端口与令牌 */
function readControlConfig() {
  const p = path.join(dataRoot(), 'runtime', 'app-ui.json')
  if (!fs.existsSync(p)) {
    throw new Error(`找不到控制口配置 ${p}——客户端没在运行？`)
  }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'))
  if (typeof cfg.port !== 'number' || typeof cfg.token !== 'string') {
    throw new Error('控制口配置格式不对（缺 port / token）')
  }
  return cfg
}

// ---------------------------------------------------------------------------
// 控制口调用
// ---------------------------------------------------------------------------

function makeClient(cfg) {
  return async function call(op, args) {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/pet/asset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ op, args }),
    })
    if (!res.ok) throw new Error(`控制口 ${op} 返回 HTTP ${res.status}`)
    const body = await res.json()
    if (!body.ok) throw new Error(`${op} 失败：${body.error}`)
    return body.result
  }
}

// ---------------------------------------------------------------------------
// 清单构造
// ---------------------------------------------------------------------------

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * 由批次描述推出槽位结构与动画组。
 *
 * **`base` 批次可以带 `group`**：带了就生成对应的动作组，不带就当作待机帧。
 * 早先的版本把**所有** base 批次的帧一律拼进 `Idle`——在「一个动作一批」的契约下
 * （见 SKILL.md 第 3 步）那等于把挥手帧混进待机循环里播。
 *
 * 只自动生成 `Idle` 与 `Talk`：没声明动作组时，凭空造出的「跳跃/挥手」只是把同一批帧
 * 换个顺序播，语义是假的。额外动作要显式声明（批次上给 `group`，或用 `params.animations`）。
 */
function buildManifest(params, namesByBatch, warnings) {
  const slots = {}
  const baseNames = []
  /** 带 group 的 base 批次：先记下来，等 slots 齐了再建帧（首帧要显式声明面部部件） */
  const grouped = []

  for (const batch of params.batches) {
    const names = namesByBatch.get(batch)
    if (batch.slot === 'base') {
      if (batch.group) grouped.push({ batch, names })
      else baseNames.push(...names)
      continue
    }
    const slot = (slots[batch.slot] ??= { kind: 'layered', at: [0, 0], parts: {} })
    const cat = batch.category
    if (!cat) throw new Error(`批次 slot="${batch.slot}" 必须给 category（部件类别名）`)
    slot.parts[cat] = names
  }

  const framesFrom = (ns) =>
    ns.map((n, i) => (i === 0 ? { base: n, ...firstFace(slots) } : { base: n }))

  const idleFrames = baseNames.length > 0 ? framesFrom(baseNames) : framesFrom(firstBaseOf(slots))
  if (idleFrames.length === 0 && grouped.length > 0) {
    throw new Error(
      '没有待机批次：所有 base 批次都带了 group，Idle 没有帧可播。' +
        '至少留一个**不带 group** 的 base 批次当待机（Idle 与 Talk 都播它）',
    )
  }

  const declared = grouped.map(({ batch, names }) => {
    const kind = batch.kind === 'once' ? 'once' : 'loop'
    if (kind === 'once' && !batch.next) {
      throw new Error(`批次「${batch.group}」是 once，必须给 next（播完接回哪个组）`)
    }
    return {
      group: batch.group,
      index: 0,
      kind,
      ...(kind === 'once' ? { next: batch.next } : {}),
      fps: Number.isFinite(batch.fps) ? batch.fps : 6,
      frames: framesFrom(names),
    }
  })

  // 原语振幅随画布高度走：写死 2px 对 56 高的像素模型够用，对 168 高的 2D 模型
  // 就几乎看不见（2 × 0.65 缩放 ≈ 1.3px）。breathe 是倍率，与尺寸无关，不用调。
  const bob = Math.max(1, Math.round(params.canvas.h * 0.02))

  const animations = [
    {
      group: 'Idle',
      index: 0,
      kind: 'loop',
      fps: 4,
      frames: idleFrames,
      // blink 是「平均间隔 ms」。模型没有闭眼部件时渲染器会自动忽略，
      // 所以这里可以无条件声明。
      params: { bob, breathe: 1.01, blink: 3200 },
    },
    { group: 'Talk', index: 0, kind: 'loop', fps: 8, frames: idleFrames, params: { bob: 1 } },
    ...declared,
    ...(Array.isArray(params.animations) ? params.animations : []),
  ]

  // 多个 base 批次却不给 group ⇒ 它们的帧会被拼进同一个 Idle 循环。
  // 这正是 real_dog 那批「待机里冒出抬爪低头」的成因，得让人看见。
  const ungroupedBaseCount = params.batches.filter((b) => b.slot === 'base' && !b.group).length
  if (ungroupedBaseCount > 1 && declared.length === 0) {
    warnings.push(
      `有 ${ungroupedBaseCount} 个 base 批次都没给 group，它们的帧会被拼进同一个 Idle 循环——` +
        `每一段动作应当带 group（如 "Wave"）单独成组`,
    )
  }

  const manifest = {
    id: params.id,
    rendererType: 'sprite',
    ...(params.pixelArt ? { pixelArt: true } : {}),
    canvas: params.canvas,
    anchor: params.anchor,
    atlas: 'atlas.png',
    atlasJson: 'atlas.json',
    ...(Object.keys(slots).length > 0 ? { slots } : {}),
    animations,
    ...(Array.isArray(params.mouthLevels) && params.mouthLevels.length > 0
      ? { mouthLevels: params.mouthLevels }
      : {}),
  }
  return manifest
}

/** 第一批面部部件的首个值，作为首帧的显式声明 */
function firstFace(slots) {
  const out = {}
  for (const [slotName, def] of Object.entries(slots)) {
    const cats = Object.keys(def.parts)
    if (cats.length === 0) continue
    out[slotName] = Object.fromEntries(cats.map((c) => [c, def.parts[c][0]]))
  }
  return out
}

/** 没有 base 批次时（纯分层模型），退回用某个槽位的首批部件当"帧" */
function firstBaseOf(slots) {
  const first = Object.values(slots)[0]
  return first ? Object.values(first.parts)[0] ?? [] : []
}

// ---------------------------------------------------------------------------
// action: "plan" —— 只渲染出图计划，不碰盘、不出图
// ---------------------------------------------------------------------------

/**
 * 把「一个动作一批」的清单渲染成每批一条的完整提示词，并推好底色。
 *
 * 为什么这一步要存在：提示词必须是**代码**（`packages/pet-asset/src/sheet-prompt.ts`），
 * 而本脚本是宿主起的子进程、解析不到 workspace 包，只能经控制口去取。
 * 提示词写进代码而不是留在 SKILL.md 散文里，是因为它是这条线上唯一决定出图质量的东西，
 * 而散文会与实现各自漂移、且没有任何东西能测它。
 *
 * **Agent 拿到 prompt 要原样交给 image_generate，别自己改写。** 技术段里那些约束
 * （同一只角色、同机位、不越格、首尾闭合、不许出现数字）都是实测换来的。
 */
async function runPlan(params: Record<string, unknown>) {
  const character = params.character
  if (typeof character !== 'string' || !character.trim()) {
    throw new Error('action="plan" 需要 character（角色与画风的描述）')
  }
  const raw = Array.isArray(params.batches) ? params.batches : []
  if (raw.length === 0) {
    throw new Error('action="plan" 需要 batches：每一段动作一个批次 { action, cols, rows }')
  }

  const plan = await makeClient(readControlConfig())('sheetPlan', {
    character,
    characterColors: params.characterColors ?? [],
    background: params.background,
    batches: raw.map((b: { action?: unknown; cols?: unknown; rows?: unknown }) => ({
      action: b.action,
      cols: b.cols ?? 2,
      rows: b.rows ?? 2,
    })),
  })

  return { ok: true, action: 'plan', ...(plan as Record<string, unknown>) }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function run() {
  const params = readParams()
  const action = params.action ?? 'build'
  if (action === 'plan') return runPlan(params)
  if (action !== 'build') throw new Error(`未知 action：${action}`)

  if (!SAFE_ID.test(params.id ?? '')) {
    throw new Error(`id 不合法："${params.id}"（只能用小写字母/数字/下划线/短横线，且以字母数字开头）`)
  }
  if (!Array.isArray(params.batches) || params.batches.length === 0) {
    throw new Error('缺少 batches（至少要有一批出图）')
  }
  for (const b of params.batches) {
    if (!b.file || !fs.existsSync(b.file)) throw new Error(`批次文件不存在：${b.file}`)
    if (!Array.isArray(b.names) || b.names.length === 0) throw new Error(`批次 ${b.file} 缺少 names`)
    const expected = (b.cols ?? 1) * (b.rows ?? 1)
    if (b.names.length !== expected) {
      throw new Error(
        `批次 ${path.basename(b.file)} 的 names 数量 ${b.names.length} 与网格 ${b.cols}×${b.rows}（${expected} 格）不符`,
      )
    }
  }

  const client = makeClient(readControlConfig())
  const roots = await client('roots')
  const pkgDir = path.join(roots.outputs, `pet-${params.id}`)
  const workDir = path.join(roots.outputs, `pet-${params.id}-work`)
  const staging = path.join(workDir, 'parts')
  const warnings = []

  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  // ---- 每批：出图闸门 → 抠底 → 切格 → 按目标名拷进 staging ----
  const namesByBatch = new Map()
  for (const [i, batch] of params.batches.entries()) {
    const file = path.resolve(batch.file)
    const cols = batch.cols ?? 1
    const rows = batch.rows ?? 1

    // 出图闸门：判**画**，不判包。放在最前面是有意的——出一次图要一分钟和一次真金白银，
    // 等到装进用户目录才发现坏图，返工代价不对等。判据见 packages/pet-asset/src/sheetcheck.ts。
    const gate = await client('sheetCheck', { input: file, cols, rows })
    if (gate.verdict === 'unusable') {
      throw new Error(
        `批次 ${path.basename(batch.file)} 没通过出图闸门：${gate.problems.join('；')}` +
          `——**不要**放宽判据或手改清单去凑，重出这一批`,
      )
    }
    warnings.push(...gate.problems.map((p) => `批次 ${path.basename(batch.file)}：${p}`))

    const cut = path.join(workDir, `cut-${i}.png`)
    const cutResult = await client('cutout', { input: file, output: cut })
    if (cutResult.residualRatio > 0.05) {
      warnings.push(
        `批次 ${path.basename(batch.file)} 残留背景 ${(cutResult.residualRatio * 100).toFixed(1)}%——` +
          `底色可能离角色太近，建议换底色重新生成`,
      )
    }
    if (!cutResult.bbox) {
      throw new Error(`批次 ${path.basename(batch.file)} 抠完没有任何内容——网格行列数是不是填错了？`)
    }

    const partsDir = path.join(workDir, `parts-${i}`)
    const sliceResult = await client('slice', {
      input: cut,
      outDir: partsDir,
      cols,
      rows,
      prefix: `b${i}`,
    })
    if (sliceResult.cells.length !== batch.names.length) {
      throw new Error(`批次 ${path.basename(batch.file)} 切出 ${sliceResult.cells.length} 格，与 names 数量不符`)
    }

    // 按目标名拷进同一个 staging 目录 → 图集条目名就是作者给的名字
    for (const [ci, cell] of sliceResult.cells.entries()) {
      fs.copyFileSync(cell.file, path.join(staging, `${batch.names[ci]}.png`))
    }
    namesByBatch.set(batch, batch.names)
  }

  // ---- 归一化到目标画布 ----
  //
  // **这一步不能省**：切片格子是模型自由取景的（实测 256×256 的 2×2 出图切出来是
  // 128×128 一格），而清单声明的 canvas 是渲染时的坐标空间。不归一化就直接打包，
  // 角色在画布里既不沾地、尺寸也与 canvas 差着量级——桌面上会变成一大坨。
  const normalized = path.join(workDir, 'normalized')
  const normResult = await client('normalize', {
    dir: staging,
    outDir: normalized,
    canvas: params.canvas,
    anchor: params.anchor,
    // 像素画走 nearest、2D 高清走 lanczos——由清单里的 pixelArt 决定，见 NormalizeOptions
    pixelArt: params.pixelArt === true,
  })
  if (normResult.clipped.length > 0) {
    warnings.push(
      `${normResult.clipped.length} 张归一化后被裁：${normResult.clipped.join(', ')}——` +
        `出图里角色贴边了，建议重新生成时让角色离边缘远一点`,
    )
  }

  // ---- 差分取层（表情批）----
  //
  // 表情批出的是「同机位全身、除眼睛外完全一致」的图集。与基准帧做差分，
  // 差异区域就是眼睛——**不需要知道眼睛在哪、不需要估位置**。
  // 必须在 normalize 之后做：差分要求两张图落在同一画布上。
  // 判据：差异铺满大半张画布 ⇒ 两次出图机位/体型没对齐，这一层会把身体盖掉。
  //
  // **产物先写到 diffed/，判定通过再挪回 normalized/**：这一步是**原地覆盖**，
  // 而失败时那批帧已经被图层替换掉了——于是「重出这一批」变成重出整个模型的
  // 所有批次，调试时量到的也不再是「表情帧与基准帧差多少」而是「图层与基准帧差多少」。
  // 实测被这个坑骗过两轮。
  for (const batch of params.batches) {
    if (!batch.diffBase) continue
    const diffDir = path.join(workDir, `diffed-${params.batches.indexOf(batch)}`)
    const diff = await client('diffLayer', {
      base: path.join(normalized, `${batch.diffBase}.png`),
      dir: normalized,
      outDir: diffDir,
      names: batch.names,
    })
    warnings.push(...diff.warnings.map((w) => `批次 ${path.basename(batch.file)}：${w}`))
    // 空图层是**合法**的：表情批的第一格往往就是中性表情，与基准帧一致、抠出来当然全透明，
    // 渲染时「什么都不画」正好等于「保持身体原本的脸」。只有「抠出来了但铺得太开」才是失败。
    const bad = diff.frames.filter((f) => f.changed > 0 && !f.usable)
    if (bad.length > 0) {
      throw new Error(
        `批次 ${path.basename(batch.file)} 的差分取层没成立：${bad.map((f) => f.name).join('、')}` +
          `——重出这一批，并确认生成时带上基准帧当参考图（否则机位对不上）。` +
          `归一化后的原帧仍在 ${normalized}，${diffDir} 里是这次抠出来的层`,
      )
    }
    for (const name of batch.names) {
      fs.copyFileSync(path.join(diffDir, `${name}.png`), path.join(normalized, `${name}.png`))
    }
  }

  // ---- 打包 ----
  // **不要再加 align**：上一步的 normalize 已经把每帧摆正（按共同倍率缩放 + 底边落锚点），
  // 再对齐一次只会把它们整体平移、把画布撑大 1px（实测 48×56 变成 48×57），
  // 与清单声明的 canvas 就对不上了。
  const packResult = await client('pack', { dir: normalized, outDir: pkgDir })
  if (!packResult.roundTripOk) throw new Error('图集往返自检失败（工具链产出的索引读不回来）')

  // ---- 写清单与信封 ----
  const manifest = buildManifest(params, namesByBatch, warnings)
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(
    path.join(pkgDir, 'pet.json'),
    JSON.stringify(
      {
        name: params.name ?? params.id,
        scale: params.scale ?? 1,
        idleMotionGroup: 'Idle',
        talkMotionGroup: 'Talk',
        emotionMap: params.emotionMap ?? {},
        tapMotions: params.tapMotions ?? {},
        personaAddon: params.personaAddon,
      },
      null,
      2,
    ),
  )

  // ---- 校验 → 安装（两段式，校验不过绝不写用户目录） ----
  const validation = await client('validate', { dir: pkgDir })
  if (!validation.ok) {
    const detail = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
    throw new Error(`产出未通过校验，未安装：${detail}`)
  }

  const install = await client('install', { dir: pkgDir })
  if (!install.ok) throw new Error(`校验通过但安装失败：${install.error ?? '未知原因'}`)

  const idleFrames = manifest.animations.find((a) => a.group === 'Idle')?.frames.length ?? 0
  return {
    ok: true,
    id: params.id,
    name: params.name ?? params.id,
    installedDir: install.install?.installedDir,
    packageDir: pkgDir,
    frames: packResult.entryCount,
    idleFrames,
    atlasSize: packResult.size,
    slots: Object.keys(manifest.slots ?? {}),
    animationGroups: manifest.animations.map((a) => a.group),
    warnings: [...warnings, ...(validation.warnings ?? []).map((w) => w.message)],
  }
}

// ---------------------------------------------------------------------------
// 出口
// ---------------------------------------------------------------------------

run()
  .then((result) => {
    console.log(RESULT_PREFIX + JSON.stringify(result))
  })
  .catch((err) => {
    // 失败也要走同一条出口：调用方只看这个前缀，抛栈出去等于没有结果
    console.log(
      RESULT_PREFIX +
        JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
    process.exitCode = 1
  })
