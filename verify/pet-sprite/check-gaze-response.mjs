#!/usr/bin/env node
/**
 * 注视联动验证：宠物会不会「看」光标，看得对不对
 *
 * 设计依据：docs/plans/客户端UI/2026-09-20-宠物自制系统P2-b实施计划.md §五
 *
 * 为什么必须量化：这个效果的上限只有 ±6°，**肉眼分辨不出来**——第一轮手测就是
 * 因为"看着没反应"而误判成功能没做（实际是满量程定得太远，输出被压到 0.14°）。
 * 所以判据一律用像素：设光标位置 → 截宠物窗口 → 量**宠物连通域重心**的位移。
 *
 * 判据（都相对本次实测的满量程摆幅，避免把模型尺寸写死进阈值）：
 *   1. 有响应       ±300px 时倾斜摆幅 > 3°（上限是 ±6°）
 *   2. 方向正确     光标偏右 → 宠物**顺时针**倾（tiltDeg 为正，与 gazeOffset 同号）
 *   3. 死区平       死区（±18px）内倾斜变化 < 1°
 *   4. 一个身位可见 ±88px 摆幅 > 3.5°（满量程 0.8 倍宠高，此时约 82%）
 *   5. 到顶不再涨   +300 与 +150 之差 < 1.5°
 *
 * 量的是**倾斜角**而不是「重心位移」：实测宠物会在测量期间自己挪位置
 * （一次跑动里右移 800px、下移 350px），任何依赖绝对坐标的量都会整个作废；
 * 行重心对 y 的回归斜率只反映姿态，站在哪儿都一样。
 *
 * ⚠️ 读数的两个性质，判据据此设计：
 *   · **有形状偏置**：宠物自身左右不对称（尾巴/耳朵），静止时斜率就不为 0
 *     （实测 −1.9°）。所以判据一律用**位置之间之差**，偏置自动抵消。
 *   · **与真实旋转角有系统偏差**（斜率代理量，实测约为真值的 0.5~0.8 倍）。
 *     所以不声称绝对角度，只看相对变化——"死区平、方向对、到顶不涨"这三条不受影响。
 *
 * ⚠️ **这个脚本会接管鼠标**（真的移动系统光标），跑的时候别动鼠标，也别在忙别的。
 * 它会记住进来时的模式，跑完还原。
 *
 * ⚠️ 「关掉 `enableGazeTracking` 就不跟随」这条**不在本脚本里**：它要改
 * `%APPDATA%/lumii-windows/pet-mode-store.json` 并重启客户端。手工做：
 * 把该字段改 false → `pnpm dev:stop && pnpm dev:start` → 再跑本脚本，
 * 此时 1/4 两条应当**失败**（Δ≈0），据此确认开关有效。
 *
 * 用法：node verify/pet-sprite/check-gaze-response.mjs [--model demo_pixel_cat] [--samples 9]
 *   --model    用哪个宠物（默认 demo_pixel_cat：唯一全功能的 sprite 模型，见计划 §七）
 *   --samples  每个光标位置采样几次（默认 9；交错采样，抖动抵消动画相位）
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  makeAppUiPost,
  petBlob,
  readAppUiConfig,
  shootPet,
  sleep,
  startCursorServer,
  stats,
} from './lib/pet-frame.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const EVIDENCE = join(REPO, 'docs', 'test', 'pet-sprite', 'evidence')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const MODEL = argOf('--model', 'demo_pixel_cat')
const SAMPLES = Number(argOf('--samples', '9'))

/** 光标相对锚点的偏移（屏幕像素）。−18/+18 落在死区内，±150/±300 都已饱和 */
const OFFSETS = [-300, -150, -88, -18, 18, 88, 150, 300]
/** 分析窗口：半尺寸整屏。取最大连通域，所以坞与角落装饰会被自动排除 */
const WINDOW = { x0: 0, x1: 1280, y0: 0, y1: 700 }

const post = makeAppUiPost(readAppUiConfig())

/** 找宠物：连续两次定位一致才算落定（进宠物模式后它会落到地面，位置要等） */
async function waitForPet(maxTries = 15) {
  let prev = null
  for (let i = 0; i < maxTries; i++) {
    const blob = await petBlob(await shootPet(post), WINDOW)
    if (blob && prev && Math.abs(blob.gy1 - prev.gy1) <= 2 && Math.abs(blob.gx0 - prev.gx0) <= 2) {
      return blob
    }
    prev = blob
    await sleep(1500)
  }
  return null
}

async function main() {
  const before = await post('/ipc/pet/getMode')
  const initialMode = before?.mode === 'pet' ? 'pet' : 'desktop'

  console.log(`模型 ${MODEL}，每个位置采样 ${SAMPLES} 次（会接管鼠标，请勿操作）`)
  await post('/ipc/pet/switchMode', { mode: 'desktop' })
  await sleep(1200)
  await post('/ipc/pet/switchMode', { mode: 'pet', modelId: MODEL })
  console.log('已进宠物模式，等它落定…')

  const pet = await waitForPet()
  if (!pet) {
    console.log('✗ 找不到稳定的宠物 —— 渲染没起来（看日志的 [loadModel]/[setup] 那几行）')
    process.exitCode = 1
    return
  }
  const AX = Math.round(pet.gcx * 2)
  const AY = (pet.gy1 + 4) * 2
  console.log(
    `宠物：屏幕 x[${pet.gx0 * 2},${pet.gx1 * 2}] y[${pet.gy0 * 2},${pet.gy1 * 2}]` +
      `（${pet.n} 像素，${(pet.gx1 - pet.gx0 + 1) * 2}x${(pet.gy1 - pet.gy0 + 1) * 2}px），锚点(${AX},${AY})\n`,
  )

  const cursor = startCursorServer()
  const samples = new Map(OFFSETS.map((o) => [o, []]))
  try {
    for (let i = 0; i < SAMPLES; i++) {
      // 交错采样：同一轮里把每个位置都采一次，慢漂移（动画周期、环境）对各位影响相同
      for (const off of OFFSETS) {
        await cursor.move(AX + off, AY)
        await sleep(170 + Math.random() * 40)
        const blob = await petBlob(await shootPet(post), WINDOW)
        samples.get(off).push(blob?.tiltDeg ?? NaN)
      }
    }
  } finally {
    cursor.close()
  }

  const at = (off) => stats(samples.get(off))
  const delta = (a, b) => at(b).mean - at(a).mean
  const sem = (a, b) => Math.hypot(at(a).sem, at(b).sem)

  // 判据用**倾斜角**（正=顺时针，与 gazeOffset 同号）：宠物会在测量期间自己挪位置，
  // 绝对坐标类的量（重心位移）会整个作废，倾斜只跟姿态有关，站在哪儿都一样。
  console.log('偏移(px)   倾斜(度)    ±SEM')
  const base = at(-300).mean
  for (const off of OFFSETS) {
    const s = at(off)
    console.log(
      `${String(off).padStart(7)}   ${s.mean.toFixed(2).padStart(8)}   ±${s.sem.toFixed(2)}` +
        `   Δ=${(s.mean - base >= 0 ? '+' : '') + (s.mean - base).toFixed(2)}`,
    )
  }
  const swing = delta(-300, 300) // 满量程摆幅（度）

  const checks = []
  const check = (ok, label, detail) => {
    checks.push({ label, ok, detail })
    console.log(`  ${ok ? '✓' : '✗'} ${label}：${detail}`)
  }

  console.log('\n判据：')
  check(Math.abs(swing) > 3, '有响应', `满量程倾斜摆幅 ${swing.toFixed(2)}°（需 > 3°）`)
  check(swing > 0, '方向正确', `光标从 −300 移到 +300，宠物${swing > 0 ? '顺时针' : '逆时针'}倾（应顺时针）`)

  const dead = delta(-18, 18)
  check(
    Math.abs(dead) < Math.max(1, 3 * sem(-18, 18)),
    '死区内不动',
    `Δ=${dead.toFixed(2)}°（上限 1°）`,
  )

  const atBodyLength = delta(-88, 88)
  check(
    Math.abs(atBodyLength) > 3.5,
    '一个身位内有响应',
    `±88px 摆幅 ${Math.abs(atBodyLength).toFixed(2)}°（需 > 3.5°）`,
  )

  const overRange = delta(150, 300)
  check(
    Math.abs(overRange) < 1.5,
    '到顶不再涨',
    `+300 与 +150 之差 ${Math.abs(overRange).toFixed(2)}°（上限 1.5°）`,
  )

  mkdirSync(EVIDENCE, { recursive: true })
  const payload = {
    generatedAt: new Date().toISOString(),
    modelId: MODEL,
    samplesPerOffset: SAMPLES,
    anchor: { x: AX, y: AY },
    petBox: { x0: pet.gx0 * 2, x1: pet.gx1 * 2, y0: pet.gy0 * 2, y1: pet.gy1 * 2, pixels: pet.n },
    metric: 'tiltDeg（行重心对 y 的回归斜率；顺时针为正，与 gazeOffset 同号）',
    curve: OFFSETS.map((off) => ({
      offsetPx: off,
      tiltDeg: at(off).mean,
      sem: at(off).sem,
      samples: at(off).n,
    })),
    swingDeg: swing,
    checks,
  }
  writeFileSync(
    join(EVIDENCE, 'check-gaze-response-result.json'),
    JSON.stringify(payload, null, 2),
  )

  // 还原进来时的模式
  await post('/ipc/pet/switchMode', { mode: initialMode })
  console.log(`\n证据：docs/test/pet-sprite/evidence/check-gaze-response-result.json（已还原为 ${initialMode} 模式）`)

  const failed = checks.filter((c) => !c.ok)
  if (failed.length) {
    console.log(`\n✗ ${failed.length} 条判据未过：${failed.map((c) => c.label).join('、')}`)
    process.exitCode = 1
  } else {
    console.log('\n✓ 注视联动五条判据全部通过')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
