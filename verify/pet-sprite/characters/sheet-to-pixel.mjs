#!/usr/bin/env node
/**
 * sheet-to-pixel.mjs — 高清精灵表 → 像素精灵表
 *
 * ## 两步，顺序不能反
 *
 * `pixel-downsample.mjs` 的众数降采样**要求输入已经量化过**：没量化的图里
 * 每个像素颜色都不同，众数没有意义（全是 1 票）。所以永远是
 * **先量化、再降采样**。
 *
 * ## 量化为什么用 sharp 而不是 Pixelorama 技能
 *
 * 项目里原来的量化走 Pixelorama 技能（`action: "clean"`），那要驱动一轮
 * Agent 会话才能拿到结果。sharp 的 `png({palette:true, colors:N})` 是同一件事
 * 的本地实现（median-cut 到 N 色），几毫秒出结果，也不用起外部进程。
 * 两者都不是"随便减色"——输出严格落在它自己选的调色板里，这正是众数降采样
 * 需要的前提。
 *
 * ## 降采样为什么不能直接用 sharp
 *
 * 最近邻只采样块里**一个**像素，角色边缘那一圈抗锯齿过渡色采到谁全看运气；
 * 面积平均会混出**不在调色板里的新颜色**。众数问的是"这块主要是什么颜色"，
 * 答案永远落在原调色板内——那是像素画的降采样方式，所以这一步交给
 * `pixel-downsample.mjs`。
 *
 * 用法：
 *   node sheet-to-pixel.mjs <表.png 或 目录> <输出目录> [--colors 12] [--height 128]
 *
 * `--height 128` 表示输出高 128（格 128 → 64）。宽度按原比例自动算，
 * 所以格子宽必须**是偶数**才能整除（见 motion-frames.mjs sheet 里的注释）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import sharp from 'sharp'

const argv = process.argv.slice(2)
const src = argv[0]
const dst = argv[1]
if (!src || !dst) {
  console.error('用法：node sheet-to-pixel.mjs <表.png 或 目录> <输出目录> [--colors 12] [--height 128]')
  process.exit(1)
}
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
/**
 * 默认 8 色。实测（橘猫 idle 表）：
 *   12 色 → 落地 15 色、flat 58%（色块细碎，放大后像"缩小图"而不是像素画）
 *    8 色 → 落地  3 色、flat 76%（接近项目里手工像素猫的 4 色 / 86%）
 * 两者之间没有连续过渡——libvips 的调色板量化会跳到解上，6 色和 8 色产出**完全相同**。
 */
const COLORS = Number(opt('colors', 8))
const HEIGHT = Number(opt('height', 128))
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const files = fs.statSync(src).isDirectory()
  ? fs
      .readdirSync(src)
      .filter((f) => /-sheet\.png$/.test(f))
      .sort()
      .map((f) => path.join(src, f))
  : [src]
if (!files.length) throw new Error(`${src} 下没有 *-sheet.png`)

fs.mkdirSync(dst, { recursive: true })
console.log(`量化 ${COLORS} 色 → 降采样到高 ${HEIGHT}px，共 ${files.length} 张\n`)

for (const f of files) {
  const base = path.basename(f).replace(/-sheet\.png$/, '')
  const out = path.join(dst, `${base}.png`)
  const tmp = path.join(dst, `.${base}.quant.png`)

  const meta = await sharp(f).metadata()
  await sharp(f).png({ palette: true, colors: COLORS, effort: 10 }).toFile(tmp)

  const line = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['pixel-downsample.mjs', tmp, out, '--height', String(HEIGHT)], {
      cwd: HERE,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    p.stdout.on('data', (d) => (buf += d))
    p.stderr.on('data', (d) => (buf += d))
    p.on('exit', (code) => (code === 0 ? resolve(buf.trim().split('\n').pop()) : reject(new Error(buf))))
  })
  fs.unlinkSync(tmp)

  const m2 = await sharp(out).metadata()
  const cellW = m2.width / 4
  console.log(`✓ ${base.padEnd(24)} ${meta.width}×${meta.height} → ${m2.width}×${m2.height}（格 ${cellW}×${HEIGHT / 2}）`)
}
console.log(`\n→ ${dst}`)
