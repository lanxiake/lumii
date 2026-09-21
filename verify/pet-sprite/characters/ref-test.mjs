#!/usr/bin/env node
/**
 * ref-test.mjs — 一次对照：**同一段提示词，挂不挂 Shimeji 参考图**
 *
 * ## 它要回答什么
 *
 * 「加入参考图，生图是否更好」。链路里其实**已经在用参考图**了——挥手批与表情批
 * 都挂着待机图当锚点（`drive-gen.mjs`），但那是**自己生成的图**，作用只是保住角色长相。
 * 这里换一种：挂**真人逐帧画的动作循环**当参考，看它能不能改善**动作分解**——
 * 相邻格之间腿部姿态是不是真的在变、四格能不能连成一段步子。
 *
 * ## 两条必须一样的提示词
 *
 * 只有「参考图那一段」不同，其余逐字相同。否则比出来的差异说不清是谁带来的。
 * 参考图那段按 `drive-gen.mjs` 的教训**单独强调一句**：只写成项目符号时，
 * Agent 会照传 filename / modelId / width 却把它漏掉，那一轮就跟没挂一样。
 *
 * ## 判不出的事
 *
 * 实测过「参考图压过文字提示」（§3.2 验证点 D，3 跳后 IoU 73%）。提示词里写着
 * "画一只全新的角色、不要照抄画风"，但**照不照抄由模型说了算**——所以出来的图
 * 得自己看：是"学步态"还是"临摹了那只猫"，这两件事这个脚本分不开。
 *
 * 用法：
 *   node ref-test.mjs --ref outputs/pet-raw/ref-shimeji_caneko-walk.png   # 实验组
 *   node ref-test.mjs                                                     # 对照组
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { command, createSession, send, findProduced } from './drive-gen.mjs'

const WORKSPACE = path.join(os.homedir(), '.lumii/workspace')
const OUT = path.join(WORKSPACE, 'outputs/pet-raw')

const args = process.argv.slice(2)
const ri = args.indexOf('--ref')
const ref = ri === -1 ? null : args[ri + 1]
const tag = ref ? 'r' : 'n'
const token = `refwalk-${tag}`
const TIMEOUT_MS = Number(args[args.indexOf('--timeout') + 1]) || 8 * 60 * 1000

/** 除参考图那段外，两组逐字相同——差异必须只有一个来源 */
function buildPrompt() {
  return [
    `请用 image_generate 工具生成一张精灵图集，\`filename\` 用 \`${token}\`。`,
    '',
    ...(ref
      ? [
          `**这一轮必须把参考图一起传进去**（参数名 \`referenceImagePaths\`，取下面给出的那个字符串）——` +
            '漏掉它这一轮就白跑了：',
          `- \`referenceImagePaths\`: \`["${ref}"]\`  ← 原样用这个字符串`,
          '',
          '参考图画的是「同一只猫走路循环的四个关键瞬间」，按阅读顺序（左→右、上→下）排成 2×2。',
          '**只借它的动作分解**：每一格里身体与四条腿的相对位置、前腿后腿的先后关系。',
          '**要画的是一只全新的角色，不要照抄参考图里的角色、配色或画风。**',
          '',
        ]
      : []),
    'FORMAT: 一张图，等分为二行二列的方格。每格尺寸完全相同、严格对齐、无间隙、无重叠。',
    '',
    'FORBIDDEN: 图中任何位置都不得出现文字、数字、字母、标点、编号、标签、水印、签名、',
    'UI 元素、网格线、边框、分隔线。整张图里只有角色本身。',
    '',
    'CONSISTENCY: 所有格子必须是同一只角色。体型、配色、画风、细节程度完全一致。',
    '角色在每格里的位置和大小完全相同——脚踩在同一条水平线上，身体中线对齐格子的竖直中线。',
    '角色完整落在格内，任何部位都不得碰到或越过格子边界。',
    '',
    'CAMERA: 正视角，角色**侧身朝向画面右侧**，全身可见（头顶到脚底）。机位固定，不俯视、不仰视。',
    '',
    'BACKGROUND: 整张图的背景是纯色 #00ffff，无渐变、无纹理、无图案、无阴影、无地面、无投影。',
    '',
    'MOTION: 格子按阅读顺序排列，代表**走路循环**的四个关键瞬间：',
    '左前腿向前迈出 → 四腿收拢的过渡 → 右前腿向前迈出 → 再次收拢的过渡。',
    '相邻格之间必须有**一眼就能看出**的腿部姿态变化，否则连起来播像是没动。',
    '最末一格要能无缝接回最初一格。全部四格合起来只表现一个动作：走路。',
    '',
    'CHARACTER: 一只橘白相间的短毛猫，圆脸，大眼睛，粗黑描边，扁平卡通上色，颜色干净明快。',
  ].join('\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 建会话 → 发提示词 → 等产物。等法与 `drive-gen.mjs` 一致：文件大小连续两次不变才算落定。 */
async function run() {
  console.log(`\n=== 参考图实验：${ref ? '实验组（挂参考图）' : '对照组（不挂）'} ===`)
  if (ref) console.log(`参考图：${ref}`)

  const since = Date.now()
  const sessionKey = await createSession(`参考图实验 ${tag}`)
  console.log(`会话 ${sessionKey}`)
  await send(sessionKey, buildPrompt())
  console.log('提示词已发出，等出图…')

  let lastSize = -1
  let hit = null
  for (let i = 0; i * 3000 < TIMEOUT_MS; i++) {
    await sleep(3000)
    const f = findProduced(token, since)
    if (!f) continue
    const size = fs.statSync(f).size
    if (size === 0 || size !== lastSize) {
      lastSize = size
      continue
    }
    hit = f
    break
  }

  if (!hit) {
    console.log('✗ 超时没落地')
    return null
  }
  fs.mkdirSync(OUT, { recursive: true })
  const dest = path.join(OUT, `${token}.png`)
  fs.copyFileSync(hit, dest)
  console.log(`✓ → outputs/pet-raw/${token}.png（源 ${path.relative(WORKSPACE, hit).replace(/\\/g, '/')}）`)
  return dest
}

const out = await run()
if (!out) process.exit(1)
console.log(`产物：${out}`)
