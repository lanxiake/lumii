// 共享：解析 Playwright、打开 posters.html、收集页面报错。
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 从当前目录解析 playwright。依次尝试：
 * PLAYWRIGHT_MODULE → 当前目录 node_modules → node_modules/.pnpm/playwright@*
 */
export async function loadPlaywright() {
  const tried = []
  const env = process.env.PLAYWRIGHT_MODULE?.trim()
  if (env) {
    try {
      const abs = resolve(env)
      return await import(existsSync(abs) ? pathToFileURL(abs).href : env)
    } catch (err) {
      tried.push(`PLAYWRIGHT_MODULE: ${err.message}`)
    }
  }
  try {
    const require = createRequire(join(process.cwd(), 'package.json'))
    return require('playwright')
  } catch (err) {
    tried.push(`require('playwright'): ${err.message}`)
  }
  const pnpm = join(process.cwd(), 'node_modules', '.pnpm')
  if (existsSync(pnpm)) {
    for (const dir of readdirSync(pnpm)) {
      if (!dir.startsWith('playwright@')) continue
      const entry = join(pnpm, dir, 'node_modules', 'playwright', 'index.mjs')
      if (existsSync(entry)) return import(pathToFileURL(entry).href)
    }
  }
  throw new Error(
    `找不到 playwright。在含 node_modules 的目录运行，或设置 PLAYWRIGHT_MODULE=<playwright/index.mjs 绝对路径>\n${tried.join('\n')}`,
  )
}

export async function openPage(htmlPath) {
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1120, height: 1120 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const errors = []
  const warnings = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    // 底图缺失是支持的兜底路径，不应让整批渲染失败
    if (m.text().includes('ERR_FILE_NOT_FOUND')) warnings.push(m.text())
    else errors.push(`console: ${m.text()}`)
  })
  await page.goto(pathToFileURL(htmlPath).href)
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  return { browser, page, errors, warnings }
}
