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
 * 只生成 `Idle` 与 `Talk` 两组：没让 Agent 显式给动作设计时，凭空造出的
 * 「跳跃/挥手」只是把同一批帧换个顺序播，语义是假的——那种东西进了控制坞
 * 只会变成噪音。要动作就让 Agent 多出一批姿态并显式声明。
 */
function buildManifest(params, namesByBatch) {
  const slots = {}
  const baseNames = []

  for (const batch of params.batches) {
    const names = namesByBatch.get(batch)
    if (batch.slot === 'base') {
      baseNames.push(...names)
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

  const animations = [
    {
      group: 'Idle',
      index: 0,
      kind: 'loop',
      fps: 4,
      frames: idleFrames,
      params: { bob: params.pixelArt ? 1 : 2, breathe: 1.01 },
    },
    { group: 'Talk', index: 0, kind: 'loop', fps: 8, frames: idleFrames, params: { bob: 1 } },
    ...(Array.isArray(params.animations) ? params.animations : []),
  ]

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
// 主流程
// ---------------------------------------------------------------------------

async function run() {
  const params = readParams()
  const action = params.action ?? 'build'
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

  // ---- 每批：抠底 → 切格 → 按目标名拷进 staging ----
  const namesByBatch = new Map()
  for (const [i, batch] of params.batches.entries()) {
    const cut = path.join(workDir, `cut-${i}.png`)
    const cutResult = await client('cutout', { input: path.resolve(batch.file), output: cut })
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
      cols: batch.cols ?? 1,
      rows: batch.rows ?? 1,
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
  })
  if (normResult.clipped.length > 0) {
    warnings.push(
      `${normResult.clipped.length} 张归一化后被裁：${normResult.clipped.join(', ')}——` +
        `出图里角色贴边了，建议重新生成时让角色离边缘远一点`,
    )
  }

  // ---- 打包 ----
  // **不要再加 align**：上一步的 normalize 已经把每帧摆正（按共同倍率缩放 + 底边落锚点），
  // 再对齐一次只会把它们整体平移、把画布撑大 1px（实测 48×56 变成 48×57），
  // 与清单声明的 canvas 就对不上了。
  const packResult = await client('pack', { dir: normalized, outDir: pkgDir })
  if (!packResult.roundTripOk) throw new Error('图集往返自检失败（工具链产出的索引读不回来）')

  // ---- 写清单与信封 ----
  const manifest = buildManifest(params, namesByBatch)
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
