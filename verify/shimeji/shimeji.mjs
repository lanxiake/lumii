/**
 * shimeji.mjs — 把「一个动作一批」的产出打成 Shimeji 精灵表
 *
 * 目标格式（AI-desktop-pets 的 `SpriteConfig` / `SpriteAnimationView`）：
 *   - 单张 PNG，**128px 等分网格**
 *   - **行 = 状态**（`spriteLine - 1`），**列 = 该状态第几帧**
 *   - 加载器就一句 `srcX = col * 128; srcY = row * 128`，不裁剪、不找锚点
 *
 * 最小三状态（用户 2026-09-21 指定）：STAND 1 帧 / WALK 4 帧 / SIT 1 帧
 * → 表是 4 列 × 3 行 = 512×384，第 0 行只有 1 格有内容，其余留空（透明）。
 *
 * **出图侧一行不改**：提示词与闸门直接复用 `packages/pet-asset`。
 * 差别只在落地：这边要的是「按行号摆进固定网格」，不是图集 + 清单。
 *
 * 用法：
 *   node shimeji.mjs plan              # 打印三批提示词
 *   node shimeji.mjs build <角色前缀>   # 抠底 → 切格 → 归一化 → 合成表
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { readRgba, writeRgbaPng } from '../../packages/pet-asset/src/image.ts'
import { op } from '../pet-sprite/lib/control.mjs'

/** Shimeji 的帧边长；`SpriteConfig.frameSize` 默认就是 128 */
export const FRAME = 128

/**
 * 最小三状态。`line` 是 `spriteLine` 的值（**从 1 起**，加载器减 1 当行号）。
 *
 * `frames` 用的是 `SpriteConfig.DEFAULT_STATES` 里的 `frameMax`：STAND 1、WALK 4、SIT 1。
 */
export const STATES = [
  { name: 'STAND', line: 1, frames: 1, cols: 1, rows: 1 },
  { name: 'WALK', line: 2, frames: 4, cols: 2, rows: 2 },
  { name: 'SIT', line: 3, frames: 1, cols: 1, rows: 1 },
]

/**
 * 表的总列数 = **帧数最多的那个状态有几帧**，不是源网格有几列。
 *
 * 这两者不是一回事：走路的源图是 2×2（两列），但它是 4 帧，按读序拉平后要占
 * **4 列**。取成 `cols` 的话第 3、4 帧会写到画布外面——`Buffer.copy` 只截断不报错，
 * 于是那两帧**静默消失**，走路变成只播两帧。实测踩过。
 */
export const SHEET_COLS = Math.max(...STATES.map((s) => s.frames))
export const SHEET_ROWS = Math.max(...STATES.map((s) => s.line))

const WORKSPACE = path.join(os.homedir(), '.lumii/workspace')
export const SHIMEJI_RAW = path.join(WORKSPACE, 'outputs/shimeji-raw')

/**
 * 表落在**消费方**的资源目录里。
 *
 * 工具链在 Lumii 这边（`packages/pet-asset`），所以脚本放这边跑；但产物是
 * AI-desktop-pets 的 `drawable-nodpi/`。两个仓库在同一层，写死绝对路径最省事
 * ——脚本本来就是这个工作区里的一次性工具，不值得为可移植性加一层配置。
 */
const ANDROID_RES =
  'C:/myself/projects/my/open-source/AI-desktop-pets/app/src/main/res/drawable-nodpi'

export function outPath(prefix) {
  return path.join(ANDROID_RES, `${prefix}_shimeji.png`)
}

export const CHARACTERS = {
  cat: {
    label: '团子（儿童向卡通猫咪）',
    // 每一批都要重新完整描述角色——不同批次之间没有记忆
    character:
      '一只适合儿童观看的卡通猫咪，圆滚滚的身体配大脑袋，橘黄与奶白相间的毛色，' +
      '又大又圆的黑色眼睛，粉色内耳与肉垫，粗而圆润的深棕色描边，简洁明快的扁平配色',
    colors: ['#f5a33c', '#fdf6e8', '#f2a8b8', '#4a2f1c'],
  },
}

/** 三批的批次描述。`kind` 留空 = 动作批（走读序即时间序的那套模板） */
export function batchesFor() {
  return [
    {
      action: '站立',
      motion: '正面站直，两只前爪自然放在身体两侧，重心稳定，身体不动',
      cols: 1,
      rows: 1,
    },
    {
      action: '走路',
      motion:
        '左前爪向前迈出、右后爪跟上 → 四肢在身体正下方并拢 → ' +
        '右前爪向前迈出、左后爪跟上 → 再次并拢，回到第一步的姿势',
      cols: 2,
      rows: 2,
    },
    {
      action: '坐下',
      motion: '后腿弯曲坐下，前爪撑在身前，尾巴绕到身体一侧，坐稳后身体不动',
      cols: 1,
      rows: 1,
    },
  ]
}

export async function planFor(prefix) {
  const c = CHARACTERS[prefix]
  if (!c) throw new Error(`未知角色 ${prefix}，可选：${Object.keys(CHARACTERS).join(', ')}`)
  // 走控制口而不是直接 import：技能脚本与这里的 .mjs 都解析不到 workspace 包的
  // `./x.js` 指代 `.ts` 那套说明符，控制口是唯一两条路都通的入口
  const r = await op('sheetPlan', {
    character: c.character,
    characterColors: c.colors,
    batches: batchesFor(),
  })
  if (!r.ok) throw new Error('sheetPlan 失败：' + r.error)
  return r.result
}

/**
 * 把出好的三批打成一张 Shimeji 表。
 *
 * 复用现有工具链，只多一步「摆进网格」：
 *   sheetCheck 闸门 → cutout 抠底 → slice 切格 → 六帧**一起** normalize 到 128×128
 *   → 按行号摆进 512×384 的画布
 *
 * 六帧必须**一起**归一化：`normalize` 用的是全体帧共同的一个倍率，
 * 分开跑会让站着的那一帧和坐着的那一帧各自撑满，走起来像在抽搐。
 */
export async function buildSheet(prefix) {
  const W = path.join(os.homedir(), '.lumii/workspace/outputs')
  const work = path.join(W, `shimeji-${prefix}`)
  fs.rmSync(work, { recursive: true, force: true })
  const parts = path.join(work, 'parts')
  fs.mkdirSync(parts, { recursive: true })

  for (const st of STATES) {
    const file = path.join(SHIMEJI_RAW, `${prefix}-${st.name.toLowerCase()}.png`)
    if (!fs.existsSync(file)) throw new Error(`缺少出图：${file}（先跑 gen.mjs）`)

    const gate = await op('sheetCheck', { input: file, cols: st.cols, rows: st.rows })
    if (!gate.ok) throw new Error(`sheetCheck 失败：${gate.error}`)
    if (gate.result.verdict === 'unusable') {
      throw new Error(
        `${st.name} 没通过出图闸门：${gate.result.problems.join('；')}——重出这一批`,
      )
    }
    for (const p of gate.result.problems) console.log(`  ⚠ ${st.name}：${p}`)

    const cut = path.join(work, `cut-${st.name}.png`)
    const c = await op('cutout', { input: file, output: cut })
    if (!c.ok) throw new Error(`cutout 失败：${c.error}`)

    const sliced = await op('slice', {
      input: cut,
      outDir: path.join(work, `cells-${st.name}`),
      cols: st.cols,
      rows: st.rows,
      prefix: 'c',
    })
    if (!sliced.ok) throw new Error(`slice 失败：${sliced.error}`)
    for (const [i, cell] of sliced.result.cells.entries()) {
      fs.copyFileSync(cell.file, path.join(parts, `${st.name}_${i}.png`))
    }
  }

  const norm = await op('normalize', {
    dir: parts,
    outDir: path.join(work, 'normalized'),
    canvas: { w: FRAME, h: FRAME },
    // 脚底中心：Shimeji 的加载器不找锚点，帧里的角色位置就是屏幕上看到的位置
    anchor: [FRAME / 2, FRAME - 4],
  })
  if (!norm.ok) throw new Error(`normalize 失败：${norm.error}`)
  if (norm.result.clipped.length > 0) {
    console.log(`  ⚠ ${norm.result.clipped.length} 帧被裁：${norm.result.clipped.join(', ')}`)
  }

  const sheetW = SHEET_COLS * FRAME
  const sheetH = SHEET_ROWS * FRAME
  const sheet = Buffer.alloc(sheetW * sheetH * 4)
  for (const st of STATES) {
    for (let i = 0; i < st.frames; i++) {
      const x0 = i * FRAME
      const y0 = (st.line - 1) * FRAME
      // 越界必须**抛**：`Buffer.copy` 对超出的部分是静默截断的，
      // 那样坏掉的是一整段动作，而日志里什么都看不到
      if (x0 + FRAME > sheetW || y0 + FRAME > sheetH) {
        throw new Error(
          `${st.name} 第 ${i} 帧落在画布外（x=${x0} y=${y0}，画布 ${sheetW}×${sheetH}）` +
            `——SHEET_COLS 要按**帧数**算，不是源网格的列数`,
        )
      }
      const src = await readRgba(path.join(work, 'normalized', `${st.name}_${i}.png`))
      for (let y = 0; y < FRAME; y++) {
        src.data.copy(sheet, ((y0 + y) * sheetW + x0) * 4, y * FRAME * 4, (y + 1) * FRAME * 4)
      }
    }
  }

  await writeRgbaPng(outPath(prefix), sheet, sheetW, sheetH)
  console.log(
    `✓ ${prefix}：${sheetW}×${sheetH}（${SHEET_COLS} 列 × ${SHEET_ROWS} 行 @${FRAME}）` +
      ` → ${outPath(prefix)}`,
  )
  for (const st of STATES) {
    console.log(`   行 ${st.line - 1} = ${st.name}，${st.frames} 帧`)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

/** 让 Agent 出一批图。名字扁平且唯一——出图工具会清洗文件名再拼日期与随机后缀 */
export function genPrompt(prefix, plan) {
  const parts = [
    `请用 image_generate 工具为「${CHARACTERS[prefix].label}」生成 ${STATES.length} 张图，` +
      `每张调一次 image_generate，都在这一轮里做完。\n`,
    `**模型统一用 \`modelId: "gpt-image-2.5"\`，width/height 都传 1024。**\n`,
  ]
  for (const [i, st] of STATES.entries()) {
    const b = plan.batches[i]
    parts.push(
      `\n## ${st.name}（${b.cols} 列 × ${b.rows} 行）\n` +
        `- \`prompt\`：**逐字节原样使用**下面这段，不要改写、不要翻译、不要增删：\n\n` +
        '```\n' +
        b.prompt +
        '\n```\n' +
        `- \`filename\`: \`${prefix}-${st.name.toLowerCase()}.png\`（**扁平文件名，不要带斜杠**）\n` +
        `- \`modelId\`: \`gpt-image-2.5\`\n- \`width\`: 1024，\`height\`: 1024\n`,
    )
  }
  parts.push(`\n生成完之后只回复每张图的 filePath，不要做别的处理。失败就如实说哪张失败。`)
  return parts.join('')
}

if (isMain) {
  const [, , action, prefix = 'cat'] = process.argv
  if (action === 'plan') {
    const plan = await planFor(prefix)
    console.log(`底色 ${plan.background.hex}（离角色色最近 ${plan.background.minDistance}）`)
    for (const [i, b] of plan.batches.entries()) {
      const st = STATES[i]
      console.log(`\n=== ${st.name}（行 ${st.line - 1}，${b.cols}×${b.rows} → ${st.frames} 帧）`)
      console.log(`filename: ${prefix}-${st.name.toLowerCase()}.png`)
      console.log(b.prompt)
    }
  } else if (action === 'prompt') {
    console.log(genPrompt(prefix, await planFor(prefix)))
  } else if (action === 'build') {
    await buildSheet(prefix)
  } else {
    console.log('用法：node shimeji.mjs plan|prompt|build [角色前缀]')
  }
}
