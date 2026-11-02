/**
 * P2 真机验收探针：控件卡「对照预览」→ 双栏 webview 各自加载。
 *
 * 走裸 CDP（playwright-core 的 connectOverCDP），不经过 app-ui-control 的快照 refs：
 * 那套 refs 与截图有时序漂移，滚动后用 refs 点击会点到上一屏的元素。
 */
import { chromium } from 'playwright-core'

const cdp = process.argv[2] ?? 'http://127.0.0.1:9222'
const browser = await chromium.connectOverCDP(cdp)
const pages = browser.contexts().flatMap((c) => c.pages())
// 9223 上还会有 DevTools 自己的页面；只认应用渲染层
const page = pages.find((p) => p.url().startsWith('http://127.0.0.1:5174') && !p.url().includes('mode=pet'))
if (!page) {
  console.error('找不到主窗口页面；现有:', pages.map((p) => p.url()))
  process.exit(1)
}
console.log('page:', page.url())

// 上一次运行可能留着对照弹窗（模态遮罩会挡住一切点击）
const stale = page.getByRole('button', { name: '关闭复刻对照' })
if (await stale.count()) {
  await stale.first().click({ force: true })
  await page.waitForTimeout(500)
}

// 切到验收会话
await page.getByRole('button', { name: 'P2真机验收' }).first().click()
await page.waitForTimeout(1500)

// 找到产物卡上的「对照预览」（可能不在视口内，scrollIntoView 即可）
const btn = page.getByRole('button', { name: '对照预览' }).first()
await btn.scrollIntoViewIfNeeded()
await page.waitForTimeout(500)
const cardText = await btn.evaluate((el) => el.closest('[data-testid="pipeline-artifact-card"]')?.innerText ?? '')
console.log('--- 产物卡文本 ---')
console.log(cardText)

await btn.click()
await page.waitForTimeout(6000)

const panes = await page.evaluate(() =>
  Array.from(document.querySelectorAll('webview')).map((w) => ({
    src: w.getAttribute('src'),
    w: w.clientWidth,
    h: w.clientHeight,
  })),
)
console.log('--- webview ---')
console.log(JSON.stringify(panes, null, 2))

const alert = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent ?? null)
if (alert) console.log('--- 加载失败提示 ---\n' + alert)

await page.screenshot({ path: 'verify/p2-compare.png' })
console.log('截图: verify/p2-compare.png')

// 空格不能被当成「加载成功」：两个 webview 都要有非零尺寸
const ok = panes.length === 2 && panes.every((p) => p.w > 100 && p.h > 100)
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(ok ? 0 : 1)
