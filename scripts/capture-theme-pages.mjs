/**
 * 多页面 × 三主题截图采集，供像素回归对比。
 * 用法：node scripts/.capture-pages.mjs <outDir>
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const outDir = path.resolve(process.argv[2] ?? 'scripts/.shots')

const cli = (...args) =>
  JSON.parse(execFileSync('node', [CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 覆盖面：概览（图表/卡片）、对话（工具卡/消息）、智能体（大量 fallback 改动）、
// 工具页（悬空修复点）、设置页
const PAGES = [
  { name: 'dashboard', view: 'dashboard' },
  { name: 'chat', view: 'chat' },
  { name: 'agents', view: 'agents' },
  { name: 'tools', view: 'tools' },
  { name: 'settings', view: 'settings' },
]
const THEMES = ['light', 'eye-care', 'dark']

fs.mkdirSync(outDir, { recursive: true })

for (const theme of THEMES) {
  cli('settings', 'set', 'theme.mode', theme)
  await sleep(1200)
  for (const page of PAGES) {
    try {
      cli('goto', '--view', page.view)
    } catch (e) {
      console.error(`goto ${page.view} 失败:`, e.message)
    }
    await sleep(1400)
    const shot = cli('screenshot')
    const dest = path.join(outDir, `${page.name}-${theme}.png`)
    fs.copyFileSync(shot.previewPath, dest)
    console.log(`${page.name}-${theme}.png`)
  }
}

// 回到浅色，避免影响后续
cli('settings', 'set', 'theme.mode', 'light')
console.log(`\n已写入 ${outDir}`)
