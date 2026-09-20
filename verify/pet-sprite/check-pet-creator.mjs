/**
 * pet-creator 端到端验证：用**合成出图**跑完整创作链路
 *
 * 设计依据：docs/plans/客户端UI/2026-09-20-宠物自制系统P1实施计划.md §2.1 / §6.5
 *
 * 真实的 pet-creator 流程要调 image_generate（产生费用）。这里用一张程序化造的
 * 「合成出图」走同样的下游：抠底 → 切格 → 归一化 → 打包 → 写清单 → 校验 → 安装。
 * 于是**整条链路可以在零成本下反复验证**，只有「生图」那一环是假的。
 *
 * 前置：客户端必须在运行（工具链走控制口 /pet/asset）。
 *
 * 用法：
 *   node verify/pet-sprite/check-pet-creator.mjs                     合成夹具（零成本）
 *   node verify/pet-sprite/check-pet-creator.mjs --file <出图> --hires  真实 AI 出图
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const DATA_ROOT = process.env.LUMII_CLIENT_DATA_DIR || path.join(os.homedir(), '.lumii')
const OUTPUTS = path.join(DATA_ROOT, 'workspace', 'outputs')
const RAW_DIR = path.join(OUTPUTS, 'pet-raw-test')
const SKILL = 'apps/windows/bundled-skills/设计与可视化/pet-creator/run.ts'

/**
 * 造一张 2×2 出图：洋红底 + 四格里各一个深色方块，垂直位置各不相同。
 * 洋红（#D9218F）与角色深色描边距离很远 —— 符合 SKILL.md 里那条硬约束。
 */
async function makeSheet(file, positions) {
  const W = 256
  const H = 256
  const buf = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = 217
    buf[i * 4 + 1] = 33
    buf[i * 4 + 2] = 143
    buf[i * 4 + 3] = 255
  }
  const put = (x, y, rgb) => {
    const i = (y * W + x) * 4
    buf[i] = rgb[0]
    buf[i + 1] = rgb[1]
    buf[i + 2] = rgb[2]
    buf[i + 3] = 255
  }
  positions.forEach((p, idx) => {
    const col = idx % 2
    const row = Math.floor(idx / 2)
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 40; x++) {
        put(col * 128 + 44 + x, row * 128 + p + y, [40, 40, 48])
      }
    }
  })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(file)
  return file
}

/**
 * 真实出图模式：`--file <路径> [--id <id>] [--name <名字>] [--hires]`
 *
 * 给一张真的 AI 出图（2×2 四格）走完整流水线。**这一步会用到已经花掉的生图费用**，
 * 脚本本身不再调生图——生图只能经 Agent 的 image_generate，本脚本只处理它的产物。
 */
function parseRealFileArgs() {
  const argv = process.argv.slice(2)
  const get = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const file = get('--file')
  if (!file || !fs.existsSync(file)) {
    console.error(`--file 指定的文件不存在：${file}`)
    process.exit(2)
  }
  const hires = argv.includes('--hires')
  const id = get('--id') ?? 'real_dog'
  return {
    action: 'build',
    id,
    name: get('--name') ?? id,
    // 2D 高清：出图是 1024 级别的写实卡通，落到 48×56 的像素画布上会糊成一团
    canvas: hires ? { w: 144, h: 168 } : { w: 48, h: 56 },
    anchor: hires ? [72, 162] : [24, 54],
    pixelArt: !hires,
    scale: hires ? 0.65 : 2,
    batches: [
      {
        file,
        cols: 2,
        rows: 2,
        slot: 'base',
        names: ['body_00', 'body_01', 'body_02', 'body_03'],
      },
    ],
    personaAddon: '你是这只小狗，活泼亲人。',
  }
}

const REAL_FILE = process.argv.includes('--file')
const params = REAL_FILE
  ? parseRealFileArgs()
  : {
      action: 'build',
      id: 'test_pet_creator',
      name: '流水线测试宠物',
      canvas: { w: 48, h: 56 },
      anchor: [24, 54],
      pixelArt: true,
      scale: 2,
      batches: [
        {
          file: await makeSheet(path.join(RAW_DIR, 'body.png'), [40, 36, 44, 40]),
          cols: 2,
          rows: 2,
          slot: 'base',
          names: ['body_00', 'body_01', 'body_02', 'body_03'],
        },
        {
          file: await makeSheet(path.join(RAW_DIR, 'eyes.png'), [50, 54, 46, 52]),
          cols: 2,
          rows: 2,
          slot: 'face',
          category: 'eyes',
          names: ['eye_open', 'eye_shut', 'eye_happy', 'eye_sad'],
        },
      ],
      personaAddon: '你是流水线测试宠物。',
    }


console.log('=== 跑 pet-creator run.ts ===')
const r = spawnSync('node', [SKILL], {
  env: { ...process.env, SKILL_PARAMS: JSON.stringify(params) },
  encoding: 'utf-8',
  windowsHide: true,
})

const out = (r.stdout || '').split('\n').find((l) => l.startsWith('__SKILL_RESULT__:'))
if (!out) {
  console.log('stdout:', r.stdout)
  console.log('stderr:', r.stderr)
  process.exit(1)
}
const result = JSON.parse(out.slice('__SKILL_RESULT__:'.length))
console.log(JSON.stringify(result, null, 2))
if (!REAL_FILE) fs.rmSync(RAW_DIR, { recursive: true, force: true })
