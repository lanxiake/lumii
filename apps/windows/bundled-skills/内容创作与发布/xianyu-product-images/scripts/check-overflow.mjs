#!/usr/bin/env node
// 找出会被裁切的区域：scrollHeight/scrollWidth 超过 client 超过 1px 就报。
// 用法：node check-overflow.mjs [posters.html]
// 退出码 1 = 有溢出（2–4px 且画面不可见的可以人工判断后接受）
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { openPage } from './page.mjs'

const html = resolve(process.argv[2] ?? 'posters.html')
if (!existsSync(html)) {
  console.error(`找不到源文件: ${html}`)
  process.exit(1)
}

// 不查 .stage：它常放 position:absolute 的装饰性标注，负偏移会制造假阳性；
// 真正的裁切由 .poster 自身的 scrollHeight 兜住。
const CONTAINERS = '.win-body,.bd,.doc,.assist,.pane,.side,.panes,.cmp,.flow'

const { browser, page, errors, warnings } = await openPage(html)

const issues = await page.$$eval(
  '[data-out]',
  (posters, selectors) => {
    const found = []
    for (const poster of posters) {
      const out = poster.dataset.out
      const dh = poster.scrollHeight - poster.clientHeight
      const dw = poster.scrollWidth - poster.clientWidth
      if (dh > 1 || dw > 1) found.push({ out, sel: '.poster', dh, dw })
      for (const el of poster.querySelectorAll(selectors)) {
        const h = el.scrollHeight - el.clientHeight
        const w = el.scrollWidth - el.clientWidth
        if (h > 1 || w > 1) {
          found.push({ out, sel: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`, dh: h, dw: w })
        }
      }
    }
    return found
  },
  CONTAINERS,
)

await browser.close()

if (warnings.length) {
  console.warn(`注意：${warnings.length} 个资源没加载（底图缺失会自动用 CSS 渐变兜底）`)
}
if (errors.length) {
  console.error(`页面报错 ${errors.length} 条：\n${errors.join('\n')}`)
}
if (issues.length === 0) {
  console.log('✓ 没有检测到溢出')
  process.exit(errors.length ? 1 : 0)
}

console.log('溢出：')
for (const i of issues) {
  console.log(`  ${i.out.padEnd(24)} ${i.sel.padEnd(28)} h+${i.dh}px w+${i.dw}px`)
}
console.log('\n修法：优先删重复内容 / 缩短文案，再用 [data-out="产品/编号"] 前缀做单图微调。')
process.exit(1)
