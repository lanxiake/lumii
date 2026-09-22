#!/usr/bin/env node
/**
 * pixel-pipeline.mjs — 「AI 出角色图 → Pixelorama 技能做成像素精灵图」的驱动段
 *
 * ## 它只负责出图，不做像素处理
 *
 * 像素处理全部交给 `bundled-skills/设计与可视化/pixelorama` 那个技能
 * （`SKILL_PARAMS={"action":"clean",...}` → `__SKILL_RESULT__:{...}`）。
 * 这里跑一遍的意义是证明那条链真的能接上：AI 出图 → 技能 → 可用的动作帧。
 *
 * ## 两步走，不是一步
 *
 * 1. `base`  —— 一张**基础角色图**（单姿态、全身、纯色底）。
 * 2. `move`  —— 挂 base 当参考图的 **2×2 动作图集**，四格是同一段动作的四个瞬间。
 *
 * 为什么不直接出图集：`drive-gen.mjs` 实测过，不挂参考图时模型会把角色**一格一格
 * 重画**（挥手批相邻帧 84~109% 的像素在变，比角色自身面积还多）。基础图就是那个锚。
 *
 * ## 底色为什么写 cyan 却必须自动估计
 *
 * 提示词写死 `#00ffff`，实际产出每张都偏（实测同批波动 ±8/255）。
 * `pixelorama_cli.gd` 的 `_estimate_bg` 取最外圈逐通道中位数，所以这里只求"接近"，
 * 不求精确——**别把底色写进后处理脚本**，那是记忆「生图能力调用路径」里
 * 记过的坑（写死底色 → 抠不干净或啃掉描边）。
 *
 * 用法：
 *   node pixel-pipeline.mjs base
 *   node pixel-pipeline.mjs move [--action walk]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { command, createSession, send, findProduced } from './drive-gen.mjs'

const WORKSPACE = path.join(os.homedir(), '.lumii/workspace')
const OUT = path.join(WORKSPACE, 'outputs/pet-raw')
const MODEL = process.env.PET_MODEL || 'gpt-image-2.5'
const SIZE = { width: 1024, height: 1024 }

const args = process.argv.slice(2)
const mode = args[0]
const opt = (n, d) => (args.indexOf(`--${n}`) === -1 ? d : args[args.indexOf(`--${n}`) + 1])

/**
 * 角色的**逐字**描述。基础图与动作图集必须用同一段——
 * 换个说法（"橘猫" → "橙色虎斑"）模型就会当成两只不同的猫。
 */
const CHARACTER =
  '一只橘白相间的短毛猫，圆脸，大眼睛，粗黑描边，扁平卡通上色，颜色干净明快，' +
  '色块分明、边界锐利，无渐变、无纹理、无写实光影。'

const BG = '#00ffff'

/** 动作图集的四格分解。四格要连成**一段**动作，不能是四个无关姿势。 */
const ACTIONS = {
  walk: {
    label: '走路',
    frames: '左前腿向前迈出 → 四腿收拢的过渡 → 右前腿向前迈出 → 再次收拢的过渡',
  },
  wave: {
    label: '挥手',
    frames: '前爪抬起至胸前 → 前爪举到耳边 → 前爪向外挥出 → 收回胸前',
  },
}

function basePrompt(token) {
  return [
    `请用 image_generate 工具生成一张角色立绘。\n`,
    `- \`filename\`: \`${token}\`（**扁平文件名，不要带斜杠**）`,
    `- \`modelId\`: \`${MODEL}\``,
    `- \`width\`: ${SIZE.width}，\`height\`: ${SIZE.height}`,
    `- \`prompt\`: **逐字节原样使用**下面这段，不要改写、不要翻译、不要增删：\n`,
    '```',
    `CHARACTER: ${CHARACTER}`,
    'POSE: 正面站立，四条腿着地，尾巴自然上翘，头部朝向正前方，全身完整可见。',
    'STYLE: 干净的扁平卡通插画，像矢量图标那样色块分明。',
    `BACKGROUND: 整张图背景是纯色 ${BG}，无渐变、无纹理、无图案、无阴影、无地面、无投影。`,
    'FRAMING: 角色居中，全身完整落在画面内，四周留出足够空白，角色高度约占画面的 55%。',
    'FORBIDDEN: 图中任何位置都不得出现文字、数字、字母、标点、编号、标签、水印、签名、',
    'UI 元素、边框、分隔线。整张图里只有角色本身。',
    '```\n',
    `生成完之后，只回复我这个文件的 filePath，不要做别的处理（不要调 pet-creator、不要跑任何脚本）。`,
    `失败就如实告诉我错误是什么，**不要自动重试**。`,
  ].join('\n')
}

function movePrompt(token, ref, action) {
  const A = ACTIONS[action]
  return [
    `请用 image_generate 工具生成一张精灵图集，\`filename\` 用 \`${token}\`。\n`,
    `**这一轮必须把参考图一起传进去**（参数名 \`referenceImagePaths\`，取下面给出的那个字符串）——`,
    `不传的话模型会把角色一格一格重画，动作接不上：`,
    `- \`referenceImagePaths\`: \`["${ref}"]\`  ← 原样用这个字符串\n`,
    `参考图画的是这个角色的**基础形象**。照它画同一只猫，配色、比例、描边粗细、画风完全一致。\n`,
    `- \`modelId\`: \`${MODEL}\``,
    `- \`width\`: ${SIZE.width}，\`height\`: ${SIZE.height}`,
    `- \`prompt\`: **逐字节原样使用**下面这段：\n`,
    '```',
    'FORMAT: 一张图，等分为二行二列的方格。每格尺寸完全相同、严格对齐、无间隙、无重叠。',
    '',
    `CHARACTER: ${CHARACTER} 与参考图里的猫是同一只。`,
    '',
    'FORBIDDEN: 图中任何位置都不得出现文字、数字、字母、标点、编号、标签、水印、签名、',
    'UI 元素、网格线、边框、分隔线。整张图里只有角色本身。',
    '',
    'CONSISTENCY: 所有格子必须是同一只角色。体型、配色、画风、细节程度完全一致。',
    '角色在每格里的位置和大小完全相同——脚踩在同一条水平线上，身体中线对齐格子的竖直中线。',
    '角色完整落在格内，任何部位都不得碰到或越过格子边界。',
    '',
    'CAMERA: 正视角，角色**侧身朝向画面右侧**，全身可见。机位固定，不俯视、不仰视。',
    '',
    `BACKGROUND: 整张图的背景是纯色 ${BG}，无渐变、无纹理、无图案、无阴影、无地面、无投影。`,
    '',
    `MOTION: 格子按阅读顺序排列，代表**${A.label}**的四个关键瞬间：`,
    `${A.frames}。`,
    '相邻格之间必须有**一眼就能看出**的姿态变化，否则连起来播像是没动。',
    `全部四格合起来只表现一个动作：${A.label}。`,
    '```\n',
    `生成完之后，只回复我这个文件的 filePath，不要做别的处理（不要调 pet-creator、不要跑任何脚本）。`,
  ].join('\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等产物落地。判据与 `drive-gen.mjs` 一致：文件大小连续两次不变（落盘不是原子的）。 */
async function waitFor(token, since, timeoutMs = 8 * 60 * 1000) {
  let lastSize = -1
  for (let i = 0; i * 3000 < timeoutMs; i++) {
    await sleep(3000)
    const f = findProduced(token, since)
    if (!f) continue
    const size = fs.statSync(f).size
    if (size === 0 || size !== lastSize) {
      lastSize = size
      continue
    }
    return f
  }
  return null
}

async function run() {
  const since = Date.now()
  let token, prompt, title

  if (mode === 'base') {
    token = 'pixel-base'
    prompt = basePrompt(token)
    title = '像素流水线 · 基础角色图'
  } else if (mode === 'move') {
    const action = opt('action', 'walk')
    const A = ACTIONS[action]
    if (!A) throw new Error(`未知动作 ${action}，可选：${Object.keys(ACTIONS).join(' ')}`)
    // 参考图必须是**工作区相对**路径——image_generate 的 referenceImagePaths 认这个。
    const refRel = `outputs/pet-raw/pixel-base.png`
    if (!fs.existsSync(path.join(WORKSPACE, refRel))) {
      throw new Error(`基础角色图还没出：${refRel}。先跑 \`node pixel-pipeline.mjs base\``)
    }
    token = `pixel-${action}`
    prompt = movePrompt(token, refRel, action)
    title = `像素流水线 · ${A.label}帧`
  } else {
    throw new Error('用法：node pixel-pipeline.mjs base | move [--action walk|wave]')
  }

  const key = await createSession(title)
  console.log(`会话 ${key}`)
  await send(key, prompt)
  console.log('提示词已发出，等出图…')

  const hit = await waitFor(token, since)
  if (!hit) {
    console.log('✗ 超时没落地')
    return false
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.copyFileSync(hit, path.join(OUT, `${token}.png`))
  console.log(`✓ → outputs/pet-raw/${token}.png`)
  return true
}

if (!(await run())) process.exit(1)
