/**
 * 主题实测探针：逐主题截图并统计整图色彩特征。
 *
 * 数据源是 lumii-ui CLI 的 screenshot.jpg（真实运行的客户端渲染结果）。
 * 用整图平均色 + 色相倾向判断主题是否真的生效，比固定坐标采样稳健
 * （页面布局/滚动位置会变，固定点容易落在光斑或文字上）。
 *
 * 用法：node scripts/probe-theme-colors.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const require = createRequire(path.join(ROOT, 'apps/windows/package.json'))
const sharp = require('sharp')

function cli(...args) {
  return JSON.parse(
    execFileSync('node', [CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  )
}

/** 整图统计：平均 RGB、亮度、暖冷倾向（R-B） */
async function stats(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]
    g += data[i + 1]
    b += data[i + 2]
    n++
  }
  r /= n
  g /= n
  b /= n
  const hex = (v) => Math.round(v).toString(16).padStart(2, '0')
  return {
    avg: `#${hex(r)}${hex(g)}${hex(b)}`,
    luminance: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b),
    /** 正=偏暖（红多于蓝），负=偏冷 */
    warmth: Math.round(r - b),
  }
}

async function setTheme(mode) {
  cli('settings', 'set', 'theme.mode', mode)
  await new Promise((r) => setTimeout(r, 1500))
}

async function main() {
  cli('goto', '--view', 'dashboard')
  await new Promise((r) => setTimeout(r, 1500))

  const results = {}
  for (const theme of ['light', 'eye-care', 'dark']) {
    await setTheme(theme)
    const shot = cli('screenshot')
    results[theme] = await stats(shot.previewPath)
    console.log(theme.padEnd(9), JSON.stringify(results[theme]))
  }
  await setTheme('light')
  fs.writeFileSync(path.join(ROOT, 'scripts/.theme-probe.json'), JSON.stringify(results, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
