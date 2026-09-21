#!/usr/bin/env node
/**
 * check-patches.mjs — 验情绪贴片：真的贴上去了吗、贴对地方了吗
 *
 * 三件事分开验，因为它们坏在不同地方：
 *
 * 1. **合成**：把贴片按槽位 `at` 叠到待机帧上，量「改了多少像素」。
 *    `face_none` 必须改 0 像素（它是恒等元，改了说明贴片画错了）。
 * 2. **落位**：改动的像素必须落在**头部包围盒附近**。贴到尾巴上数字一样好看，
 *    所以这里不只看数量还看位置，并且把结果画成 ASCII——本机读不了图，只能这么看。
 * 3. **绑定前置条件**：渲染器认表情层是靠名字白名单
 *    `EYES_NAMES = ['eyes','eye','expression','face']`，且**只绑第一个命中的**。
 *    所以要么没有任何类别占位、要么我们就是那个。这条是静态检查。
 *
 * ⚠ 最后一步「app 里真的切到了那一档」**本脚本验不了**——那要跑客户端看
 * `[SpridPetRenderer] [setExpression] index=N → face_xxx`。见文件末尾的命令。
 *
 * 用法：node check-patches.mjs <宠物包目录> [...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(REPO, 'package.json'))
const sharp = require('sharp')

/** 与渲染器同源的白名单（`SpritePetRenderer.ts` 的 EYES_NAMES） */
const EYES_NAMES = ['eyes', 'eye', 'expression', 'face']
const ALPHA = 8

async function load(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
  const atlasJson = JSON.parse(fs.readFileSync(path.join(dir, 'atlas.json'), 'utf-8'))
  const png = path.join(dir, atlasJson.meta?.image ?? manifest.atlas)
  const W = manifest.canvas.w
  const H = manifest.canvas.h
  const read = async (name) => {
    const b = atlasJson.frames[name].frame ?? atlasJson.frames[name]
    const { data } = await sharp(png)
      .extract({ left: b.x, top: b.y, width: b.w, height: b.h })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return data
  }
  return { manifest, atlasJson, W, H, read }
}

/** 把 src 按 alpha 叠到 dst 上（src-over），返回新缓冲 */
function over(dst, src) {
  const out = Buffer.from(dst)
  for (let i = 0; i < out.length; i += 4) {
    const a = src[i + 3] / 255
    if (a === 0) continue
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(src[i + c] * a + out[i + c] * (1 - a))
    out[i + 3] = Math.min(255, Math.round(src[i + 3] * a + out[i + 3] * (1 - a)))
  }
  return out
}

const ascii = (buf, W, H, cols = 60) => {
  const rows = Math.round((cols * H) / W / 2)
  const ramp = ' .:-=+*#%@'
  let s = ''
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * W) / cols)
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * W) / cols))
      const y0 = Math.floor((r * H) / rows)
      const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * H) / rows))
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += buf[(y * W + x) * 4 + 3]
          n++
        }
      }
      line += ramp[Math.min(9, Math.floor(((sum / n) / 255) * 10))]
    }
    s += line + '\n'
  }
  return s
}

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('用法：node check-patches.mjs <宠物包目录> ...')
  process.exit(2)
}

let bad = 0
for (const d of dirs) {
  const { manifest, W, H, read } = await load(path.resolve(d))
  const slot = manifest.slots?.face
  if (!slot) {
    console.log(`\n${manifest.id}：没有 face 槽，跳过`)
    continue
  }
  const parts = slot.parts.face ?? []
  const baseName = manifest.animations?.find((a) => a.group === 'Idle')?.frames?.[0]?.base
  const base = await read(baseName)

  const head = (manifest.hitAreas ?? []).find((a) => /head/i.test(a.id))
  const hb = head
    ? {
        x0: Math.min(...head.points.map((p) => p[0])),
        x1: Math.max(...head.points.map((p) => p[0])),
        y0: Math.min(...head.points.map((p) => p[1])),
        y1: Math.max(...head.points.map((p) => p[1])),
      }
    : null

  console.log(`\n===== ${manifest.id}（画布 ${W}×${H}）=====`)

  // ---- 3. 绑定前置条件 ----
  const claimants = []
  for (const [slotName, def] of Object.entries(manifest.slots ?? {})) {
    if (def.kind !== 'layered') continue
    for (const cat of Object.keys(def.parts ?? {})) {
      if (EYES_NAMES.includes(cat.toLowerCase())) claimants.push(`${slotName}.${cat}`)
    }
  }
  const binding = claimants[0] ?? '(无)'
  const isOurs = binding === 'face.face'
  console.log(
    `  绑定：会被认作表情层的是 **${binding}**` +
      (isOurs ? ' ✓ 就是贴片槽' : ' ✗ 不是贴片槽——setExpression 不会切到贴片'),
  )
  if (!isOurs) bad++

  // ---- 1 & 2. 合成与落位 ----
  console.log(`  ${'贴片'.padEnd(16)}${'改动像素'.padStart(9)}${'落在头框内'.padStart(11)}  目视`)
  for (const name of parts) {
    const patch = await read(name)
    const merged = over(base, patch)
    let changed = 0
    let inHead = 0
    let cx = 0
    let cy = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const diff =
          Math.abs(merged[i] - base[i]) +
          Math.abs(merged[i + 1] - base[i + 1]) +
          Math.abs(merged[i + 2] - base[i + 2]) +
          Math.abs(merged[i + 3] - base[i + 3])
        if (diff > ALPHA) {
          changed++
          cx += x
          cy += y
          if (hb && x >= hb.x0 - 4 && x <= hb.x1 + 4 && y >= hb.y0 - 4 && y <= hb.y1 + 4) inHead++
        }
      }
    }
    const isNone = name.endsWith('none')
    const pos = changed ? `重心(${Math.round(cx / changed)},${Math.round(cy / changed)})` : '—'
    if (isNone && changed !== 0) {
      console.log(`  ✗ ${name} 是恒等元却改了 ${changed} 像素`)
      bad++
    }
    if (!isNone && changed === 0) {
      console.log(`  ✗ ${name} 一个像素都没改——贴片是空图或位置全在画布外`)
      bad++
    }
    console.log(
      `  ${name.padEnd(16)}${String(changed).padStart(9)}` +
        `${(changed ? ((inHead / changed) * 100).toFixed(0) + '%' : '—').padStart(11)}  ${pos}`,
    )
    if (!isNone && hb && changed > 0 && inHead / changed < 0.6) {
      console.log(`     ⚠ 只有 ${((inHead / changed) * 100).toFixed(0)}% 落在头框附近——可能贴歪了，看下面的图`)
      bad++
    }
  }

  // 把最"有戏"的那个贴片画出来看落位
  const show = parts.find((p) => !p.endsWith('none'))
  if (show) {
    console.log(`\n  ── 待机帧 + ${show} 的合成（亮=不透明；方框=头框 HitAreaHead）──`)
    const merged = over(base, await read(show))
    const art = ascii(merged, W, H).split('\n')
    const cols = 60
    if (hb) {
      // 画**边框**而不是填充：填充会把要看的角色整个盖住（第一版就是这么干的，
      // 结果屏幕上只剩一块 #，什么都判断不了）。
      const c0 = Math.floor((hb.x0 / W) * cols)
      const c1 = Math.min(cols - 1, Math.ceil((hb.x1 / W) * cols))
      const r0 = Math.floor((hb.y0 / H) * art.length)
      const r1 = Math.min(art.length - 1, Math.ceil((hb.y1 / H) * art.length))
      const grid = art.map((l) => l.padEnd(cols).split(''))
      for (let c = c0; c <= c1; c++) {
        grid[r0][c] = grid[r0][c] === ' ' ? '-' : '+'
        grid[r1][c] = grid[r1][c] === ' ' ? '-' : '+'
      }
      for (let r = r0; r <= r1; r++) {
        grid[r][c0] = grid[r][c0] === ' ' ? '|' : '+'
        grid[r][c1] = grid[r][c1] === ' ' ? '|' : '+'
      }
      for (const row of grid) console.log('  |' + row.join(''))
    } else {
      for (const l of art) console.log('  |' + l)
    }
  }
}

console.log(
  bad
    ? `\n✗ ${bad} 项有问题`
    : '\n✓ 贴片合成、落位、绑定前置条件全部通过',
)
console.log(
  '\n仍未验的一步（要跑客户端）：进宠物模式后看日志里有没有\n' +
    '  [SpritePetRenderer] [setExpression] index=N → face_xxx\n' +
    '渲染器那句日志是「意图 vs 落地」唯一的硬证据，本脚本离线验不了。',
)
if (bad) process.exitCode = 1
