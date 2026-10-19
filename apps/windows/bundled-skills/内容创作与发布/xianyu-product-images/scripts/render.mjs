#!/usr/bin/env node
// 把 posters.html 里每个 [data-out] 截成 PNG。
// 用法：node render.mjs [posters.html] [输出目录]
// 输出：<输出目录>/<data-out>.png，例如 images/demo-product/01.png（2048×2048）
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { openPage } from './page.mjs'

const html = resolve(process.argv[2] ?? 'posters.html')
const outDir = resolve(process.argv[3] ?? 'images')
if (!existsSync(html)) {
  console.error(`找不到源文件: ${html}`)
  process.exit(1)
}

const { browser, page, errors, warnings } = await openPage(html)
if (warnings.length) console.warn(`注意：${warnings.length} 个资源没加载（底图缺失会自动用 CSS 渐变兜底）\n`)
const wanted = await page.$$eval('[data-out]', (els) => els.map((e) => e.dataset.out))
if (wanted.length === 0) {
  console.error('页面里没有 [data-out] 元素')
  await browser.close()
  process.exit(1)
}

for (const out of wanted) {
  const el = await page.$(`[data-out="${out}"]`)
  if (!el) {
    errors.push(`missing element: ${out}`)
    continue
  }
  const target = join(outDir, `${out}.png`)
  mkdirSync(dirname(target), { recursive: true })
  await el.screenshot({ path: target })
  console.log(`✓ ${out} → ${target}`)
}

await browser.close()

if (errors.length) {
  console.error(`\n页面报错 ${errors.length} 条：\n${errors.join('\n')}`)
  process.exit(1)
}
console.log(`\n完成：${wanted.length} 张，2048×2048`)
