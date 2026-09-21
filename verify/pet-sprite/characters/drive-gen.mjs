#!/usr/bin/env node
/**
 * drive-gen.mjs — 驱动真实 Agent 轮次出图，并把产物收编到稳定的路径
 *
 * 为什么不直连生图 API：密钥与模型槽配置在运行中的 App 里，
 * 控制口没有生图路由，唯一合法路径是让 Agent 自己调 `image_generate`
 * （见记忆「生图能力调用路径与实测结论」）。
 *
 * 会话走底层 `command {type:'user:send'}` 并补 msgId —— `lumii-ui send`
 * 不带 msgId 会跳过分段管线（见记忆「CLI 驱动真实 Agent 轮次」）。
 *
 * ## 文件名不是你要什么就是什么（踩过）
 *
 * `image_generate` 的 `filename` 会被**清洗**再拼日期与随机后缀
 * （`bridge-image-services.ts`：非 `[\w一-鿿-]` 的字符全变 `_`，再截到 40 字符，
 * 落成 `outputs/<YYYYMMDD>/<name>_<YYYYMMDD>_<uuid8>.<ext>`）。
 * 所以传 `pet-raw/girl-wave.png` 得到的是
 * `outputs/20260921/pet-raw_girl-wave_png_20260921_78709203.png`——
 * **等在原路径上会一直等到超时**。这里改成：给一个扁平且唯一的名字去等通配，
 * 落地后再拷到 `outputs/pet-raw/<角色>-<批>.png` 这个稳定路径上，
 * 后续步骤与参考图都只认它。
 *
 * 用法：
 *   node drive-gen.mjs <characterId> [--idle|--wave]   # 动作批
 *   node drive-gen.mjs --expression                    # 三只的表情批（带参考图）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lumii/runtime/app-ui.json'), 'utf-8'))
const BASE = `http://127.0.0.1:${cfg.port}`
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` }

const WORKSPACE = path.join(os.homedir(), '.lumii/workspace')
export const RAW_DIR = path.join(WORKSPACE, 'outputs/pet-raw')
/** 记下每次出图**真实**落到的 workspace 相对路径（参考图要用它） */
const GENERATED = new URL('./generated.json', import.meta.url)

const plans = JSON.parse(fs.readFileSync(new URL('./plans.json', import.meta.url), 'utf-8'))

/** 每只角色出图文件名前缀（避免三只互相覆盖） */
export const PREFIX = {
  anime_girl: 'girl',
  cartoon_cat: 'cat',
  mecha_gundam: 'mecha',
}

/**
 * 每批的模型与尺寸。统一走 A/B 里综合最好的那个。
 *
 * 可用 `PET_MODEL=<id>` 覆盖：provider 侧会整批失败（实测一次
 * `gpt-image-2.5` 跑了 232 秒后回 `generate image failed`），
 * 换模型重试要比死磕同一家便宜得多。
 */
const MODEL = process.env.PET_MODEL || 'gpt-image-2.5'
const SIZE = { width: 1024, height: 1024 }

function readGenerated() {
  try {
    return JSON.parse(fs.readFileSync(GENERATED, 'utf-8'))
  } catch {
    return {}
  }
}
function writeGenerated(map) {
  fs.writeFileSync(GENERATED, JSON.stringify(map, null, 2) + '\n', 'utf-8')
}

async function command(payload) {
  const res = await fetch(`${BASE}/command`, { method: 'POST', headers: H, body: JSON.stringify(payload) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应原样返回 */
  }
  return { status: res.status, json, text }
}

async function createSession(title) {
  const r = await command({ type: 'conversation:create', title })
  const key = r.json?.sessionKey ?? r.json?.result?.sessionKey ?? r.json?.result?.id
  if (!key) throw new Error(`建会话失败：HTTP ${r.status} ${r.text.slice(0, 300)}`)
  return key
}

async function send(sessionKey, content) {
  const r = await command({ type: 'user:send', sessionKey, content, msgId: randomUUID() })
  if (r.status !== 200) throw new Error(`发送失败：HTTP ${r.status} ${r.text.slice(0, 300)}`)
  return r.json
}

/**
 * 在 outputs/<日期>/ 下找 `<token>_*.png`（出图工具清洗过名字，只能通配）。
 *
 * `since` 是**必须**的：重出同一批时旧文件还躺在同一个目录里，名字形如
 * `<token>_<日期>_<uuid>.png`——只按前缀找会立刻命中上一轮那张，
 * 于是脚本「成功」退出、根本没等新图（实测踩过：重跑的表情批被认成旧文件）。
 */
function findProduced(token, since) {
  const root = path.join(WORKSPACE, 'outputs')
  if (!fs.existsSync(root)) return null
  const hits = []
  for (const day of fs.readdirSync(root)) {
    const dir = path.join(root, day)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(token + '_') || !/\.(png|jpg|webp)$/i.test(f)) continue
      const abs = path.join(dir, f)
      if (since && fs.statSync(abs).mtimeMs < since) continue
      hits.push(abs)
    }
  }
  if (hits.length === 0) return null
  // 取最新的一张：同一轮里可能有多次落盘
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return hits[0]
}

/**
 * 等若干批落图，并把它们拷到 `outputs/pet-raw/<角色>-<批>.png`。
 *
 * 判据是**文件出现且连续两次尺寸不变**（出图落盘不是原子的，可能读到半张），
 * 而不是等助手把话说完——出图要几十秒，措辞不可靠。
 */
async function collect(jobs, { timeoutMs = 900_000, settleMs = 5000, since = 0 } = {}) {
  const t0 = Date.now()
  const done = new Map()
  const lastSize = new Map()
  while (Date.now() - t0 < timeoutMs) {
    let all = true
    for (const job of jobs) {
      if (done.has(job.token)) continue
      const hit = findProduced(job.token, since)
      if (!hit) {
        all = false
        continue
      }
      const size = fs.statSync(hit).size
      if (lastSize.get(job.token) !== size || size === 0) {
        lastSize.set(job.token, size)
        all = false
        continue
      }
      done.set(job.token, hit)
    }
    if (all && done.size === jobs.length) break
    await new Promise((r) => setTimeout(r, settleMs))
  }

  const map = readGenerated()
  for (const job of jobs) {
    const hit = done.get(job.token)
    if (!hit) {
      console.log(`  ✗ ${job.token} 超时没落地`)
      continue
    }
    fs.mkdirSync(RAW_DIR, { recursive: true })
    const dest = path.join(RAW_DIR, job.stable)
    fs.copyFileSync(hit, dest)
    const rel = path.relative(WORKSPACE, hit).replace(/\\/g, '/')
    map[job.key] = rel
    console.log(`  ✓ ${job.token} → outputs/pet-raw/${job.stable}（源 ${rel}）`)
  }
  writeGenerated(map)
  return map
}

// ---------------------------------------------------------------------------
// 提示词构造
// ---------------------------------------------------------------------------

const MOTION_LABELS = [
  [0, 'idle', '待机呼吸'],
  [1, 'wave', '挥手'],
]

/** 动作批的指令。`only` 可以只出其中一张——重试时没必要连成功的那张一起重出。 */
export function motionPrompt(characterId, only = null) {
  const c = plans[characterId]
  const p = PREFIX[characterId]
  const wanted = only ? MOTION_LABELS.filter(([, k]) => k === only) : MOTION_LABELS
  const parts = []
  parts.push(
    `请用 image_generate 工具为「${c.name}」这只新宠物生成${wanted.length > 1 ? '两' : '一'}张精灵图集。` +
      `${wanted.length > 1 ? '两张图各自调一次 image_generate，都在这一轮里做完。' : ''}\n`,
  )
  parts.push(`**模型统一用 \`modelId: "${MODEL}"\`，width/height 都传 ${SIZE.width}。**\n`)

  for (const [i, key, label] of wanted) {
    const batch = c.plan.batches[i]
    parts.push(
      `\n## ${wanted.length > 1 ? `第 ${i + 1} 张：` : ''}${label}（${batch.cols} 列 × ${batch.rows} 行）\n` +
        `- \`prompt\`：**逐字节原样使用**下面这段，不要改写、不要翻译、不要增删、不要加你自己的解释：\n\n` +
        '```\n' +
        batch.prompt +
        '\n```\n' +
        `- \`filename\`: \`${p}-${key}.png\`（**扁平文件名，不要带斜杠**）\n` +
        `- \`modelId\`: \`${MODEL}\`\n` +
        `- \`width\`: ${SIZE.width}，\`height\`: ${SIZE.height}\n`,
    )
  }
  parts.push(
    `\n生成完之后，只回复我每个文件的 filePath，不要做别的处理（不要调 pet-creator、不要跑任何脚本）。` +
      `失败就如实告诉我错误是什么，**不要自动重试**。`,
  )
  return parts.join('')
}

/** 表情批：三只角色各一张，都要把各自的待机图集当参考图带上 */
export function expressionPrompt(ids) {
  const gen = readGenerated()
  const parts = [
    `请用 image_generate 工具生成 ${ids.length} 张宠物表情图集，每张调一次 image_generate，都在这一轮里做完。\n`,
    `**模型统一用 \`modelId: "${MODEL}"\`，width/height 都传 ${SIZE.width}。**\n`,
    `\n这几张图是「在已有角色图的基础上只换眼睛」。**必须**把对应的参考图一起传进去，` +
      `否则机位对不上，后面的差分取层会失败。参考图路径是**工作区相对**路径，就是下面给出的字符串。\n`,
  ]
  for (const id of ids) {
    const c = plans[id]
    const batch = c.plan.batches[2]
    const ref = gen[`${id}-idle`]
    parts.push(
      `\n## ${c.name} 的表情差分（${batch.cols} 列 × ${batch.rows} 行）\n` +
        `- \`prompt\`：**逐字节原样使用**下面这段：\n\n` +
        '```\n' +
        batch.prompt +
        '\n```\n' +
        (ref
          ? `- \`referenceImagePaths\`: \`["${ref}"]\`  ← 原样用这个字符串\n`
          : `- ⚠ 没有参考图记录，跳过这一张\n`) +
        `- \`filename\`: \`${PREFIX[id]}-face.png\`（扁平文件名）\n` +
        `- \`modelId\`: \`${MODEL}\`\n` +
        `- \`width\`: ${SIZE.width}，\`height\`: ${SIZE.height}\n`,
    )
  }
  parts.push(`\n全部生成完之后，只回复每张图的 filePath，不要做别的处理。哪张失败就如实说哪张失败。`)
  return parts.join('')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  if (argv.includes('--expression')) {
    // 可以让位置参数限定只重出某几只——**别把已经成立的那批一起重出**：
    // 覆盖掉一个成功的结果，换来的是一次纯运气的重掷。
    const only = argv.filter((a) => !a.startsWith('--'))
    const ids = (only.length > 0 ? only : Object.keys(plans)).filter((id) => plans[id])
    const gen = readGenerated()
    for (const id of ids) {
      if (!gen[`${id}-idle`]) console.error(`⚠ ${id} 的待机图集还没出，它的表情批没有参考图可用`)
    }
    const usable = ids.filter((id) => gen[`${id}-idle`])
    if (usable.length === 0) throw new Error('没有任何待机图集，先跑动作批')
    // 记下发送时刻：只认这之后落盘的文件，否则会认成上一轮的旧图
    const since = Date.now()
    const key = await createSession('精灵图生成 · 表情批')
    console.log('sessionKey =', key)
    await send(key, expressionPrompt(usable))
    console.log('已发送，等待出图…')
    await collect(usable.map((id) => ({
      token: `${PREFIX[id]}-face`,
      stable: `${PREFIX[id]}-face.png`,
      key: `${id}-face`,
    })), { since })
  } else {
    const id = argv.find((a) => !a.startsWith('--')) ?? 'anime_girl'
    if (!plans[id]) throw new Error(`未知角色 ${id}，可选：${Object.keys(plans).join(', ')}`)
    const only = argv.includes('--idle') ? 'idle' : argv.includes('--wave') ? 'wave' : null
    const wanted = only ? MOTION_LABELS.filter(([, k]) => k === only) : MOTION_LABELS
    const since = Date.now()
    const key = await createSession(`精灵图生成 · ${plans[id].name}${only ? ` · ${only}` : ''}`)
    console.log('sessionKey =', key)
    await send(key, motionPrompt(id, only))
    console.log('已发送，等待出图…')
    await collect(wanted.map(([, k]) => ({
      token: `${PREFIX[id]}-${k}`,
      stable: `${PREFIX[id]}-${k}.png`,
      key: `${id}-${k}`,
    })), { since })
  }
}
