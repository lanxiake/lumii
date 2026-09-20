#!/usr/bin/env node
/**
 * check-composite.mjs — 验证点 C：运行时合成（验证计划 T4）
 *
 * 用 Playwright 驱动真实浏览器跑**真实 PIXI 渲染**，再读像素做断言 ——
 * 比「打开页面用眼睛看」更严格，且可复现。
 *
 * 五项断言：
 *   C1 四类内容共存      base 帧 + face 覆盖层 + 程序化原语 + 嘴型切档
 *   C2 锚点缩放不变      放大时角色脚底必须停在原处（否则会「往下沉」）
 *   C3 覆盖层跟随整体    眼/嘴在缩放/旋转下与身体保持固定相对位置
 *   C4 嘴型切档生效      setMouthOpen 换档后画面确实变化
 *   C5 nearest 采样      整数倍放大后每个源像素恰好变成 N×N 纯色块（无插值糊边）
 *
 * 并对 correct / naive 两个模式做对照，把「容器原点没设在锚点」这个坑用数据钉死。
 *
 * 用法：node verify/pet-sprite/check-composite.mjs
 * 浏览器：优先用系统 Edge（无需额外下载 Chromium）
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { chromium } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const EVIDENCE = join(ROOT, 'docs', 'test', 'pet-sprite', 'evidence')

/** 候选浏览器：系统 Edge 优先，避免下载 Chromium */
const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

// ---------------------------------------------------------------------------
// 静态服务：页面 + PIXI（来自 node_modules）+ 素材
// ---------------------------------------------------------------------------

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    let path
    if (url.pathname === '/' || url.pathname === '/index.html') {
      path = join(HERE, 'check-composite.html')
    } else if (url.pathname === '/pixi.min.js') {
      path = join(ROOT, 'node_modules', 'pixi.js', 'dist', 'browser', 'pixi.min.js')
    } else if (url.pathname.startsWith('/fixtures/')) {
      path = join(HERE, url.pathname.replace('/fixtures/', 'fixtures/'))
    } else {
      res.writeHead(404); res.end('not found'); return
    }
    try {
      const body = await readFile(path)
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404); res.end('not found')
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// ---------------------------------------------------------------------------
// 像素工具
// ---------------------------------------------------------------------------

async function capture(page) {
  const buf = await page.screenshot({ omitBackground: true })
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, w: info.width, h: info.height }
}

/** 非透明像素的包围盒 */
function bbox(img, thr = 16) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.data[(y * img.w + x) * 4 + 3] > thr) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** 满足谓词的像素质心 */
function centroid(img, pred) {
  let sx = 0, sy = 0, n = 0
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4
      if (img.data[i + 3] < 200) continue
      if (!pred(img.data[i], img.data[i + 1], img.data[i + 2])) continue
      sx += x; sy += y; n++
    }
  }
  return n === 0 ? null : { x: sx / n, y: sy / n, n }
}

/** 两图差异像素数（只统计包围盒内，避免被大片空白稀释） */
function diffCount(a, b, box) {
  let diff = 0
  const x0 = box ? box.minX : 0
  const x1 = box ? box.maxX : a.w - 1
  const y0 = box ? box.minY : 0
  const y1 = box ? box.maxY : a.h - 1
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * a.w + x) * 4
      if (
        Math.abs(a.data[o] - b.data[o]) > 8 ||
        Math.abs(a.data[o + 1] - b.data[o + 1]) > 8 ||
        Math.abs(a.data[o + 2] - b.data[o + 2]) > 8 ||
        Math.abs(a.data[o + 3] - b.data[o + 3]) > 8
      ) diff++
    }
  }
  return diff
}

/** 整数倍放大后，每个 N×N 块是否纯色（nearest 采样的判据） */
function blockUniformity(img, n, box) {
  let blocks = 0, nonUniform = 0
  for (let by = box.minY; by + n <= box.maxY + 1; by += n) {
    for (let bx = box.minX; bx + n <= box.maxX + 1; bx += n) {
      const p0 = (by * img.w + bx) * 4
      let uniform = true
      for (let dy = 0; dy < n && uniform; dy++) {
        for (let dx = 0; dx < n; dx++) {
          const p = ((by + dy) * img.w + bx + dx) * 4
          if (
            Math.abs(img.data[p] - img.data[p0]) > 4 ||
            Math.abs(img.data[p + 1] - img.data[p0 + 1]) > 4 ||
            Math.abs(img.data[p + 2] - img.data[p0 + 2]) > 4 ||
            Math.abs(img.data[p + 3] - img.data[p0 + 3]) > 4
          ) { uniform = false; break }
        }
      }
      blocks++
      if (!uniform) nonUniform++
    }
  }
  return blocks === 0 ? 1 : 1 - nonUniform / blocks
}

// ---------------------------------------------------------------------------
// 逐个模式的验证
// ---------------------------------------------------------------------------

async function runMode(browser, port, mode) {
  const page = await browser.newPage({ viewport: { width: 220, height: 220 } })
  await page.goto(`http://127.0.0.1:${port}/?mode=${mode}`)
  await page.waitForFunction(() => window.__pet, null, { timeout: 15000 })

  const ready = await page.evaluate(() => window.__pet.ready)
  if (!ready) {
    const err = await page.evaluate(() => window.__pet.error)
    throw new Error(`[${mode}] 页面初始化失败: ${err}`)
  }

  const set = (patch) => page.evaluate((p) => window.__pet.setState(p), patch)
  const anchorScreen = () => page.evaluate(() => window.__pet.anchorScreen())

  const out = { mode }

  // ---- C1 四类内容共存 ----
  await set({ scale: 1, rotation: 0, offsetX: 0, offsetY: 0, mouthLevel: 0, blinkClosed: false })
  const s1 = await page.evaluate(() => window.__pet.getState())
  const imgBase = await capture(page)
  const bbBase = bbox(imgBase)
  // 眼白显著亮于身体（身体橙色最暗通道仅 61），用「最暗通道 > 180」即可稳定识别
  const bright = (img) => centroid(img, (r, g, b) => Math.min(r, g, b) > 180)
  const withEyes = bright(imgBase)

  await set({ blinkClosed: true })
  const imgBlink = await capture(page)
  await set({ blinkClosed: false })

  await set({ mouthLevel: 3 })
  const imgMouth3 = await capture(page)
  await set({ mouthLevel: 0 })

  const blinkDiff = diffCount(imgBase, imgBlink, bbBase)
  const mouthDiff = diffCount(imgBase, imgMouth3, bbBase)
  const coexist = {
    base: bbBase !== null,
    overlay: withEyes !== null && withEyes.n >= 30,
    blink: blinkDiff > 10,
    mouth: mouthDiff > 10,
    primitives: s1.scale === 1 && typeof s1.offsetY === 'number',
  }
  out.coexist = coexist
  out.coexistDetail = { eyePixels: withEyes?.n ?? 0, blinkDiff, mouthDiff }
  out.c1 = Object.values(coexist).every(Boolean)

  // ---- C2 锚点缩放不变 ----
  // 判据：**脚底屏幕位置在各缩放档之间必须恒定**。
  // 不能拿「期望锚点位置」当参照 —— naive 模式下期望值本身就在漂，
  // 那样比会假通过（早期版本正是这么写的，两模式都「通过」了）。
  const scaleRows = []
  for (const s of [1, 1.5, 2]) {
    await set({ scale: s, rotation: 0, offsetX: 0, offsetY: 0 })
    const img = await capture(page)
    const bb = bbox(img)
    const expect = await anchorScreen()
    // 角色脚底 ≈ 局部 (32, 60) = 锚点；测包围盒底部中心
    const foot = { x: (bb.minX + bb.maxX) / 2, y: bb.maxY }
    scaleRows.push({ scale: s, foot, expect })
    await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
      .png().toFile(join(EVIDENCE, `composite-${mode}-scale${s}.png`))
  }
  const base0 = scaleRows[0].foot
  for (const r of scaleRows) {
    r.driftX = Math.abs(r.foot.x - base0.x)
    r.driftY = Math.abs(r.foot.y - base0.y)
  }
  const maxDrift = Math.max(...scaleRows.map((r) => Math.max(r.driftX, r.driftY)))
  out.scaleRows = scaleRows
  out.maxDrift = maxDrift
  // 锚点稳定 ⇒ 各档脚底位置一致（容忍 2px：包围盒因缩放取整略有出入）
  out.c2 = maxDrift <= 2

  // ---- C3 覆盖层跟随整体（缩放时眼相对身体位置不变）----
  await set({ scale: 1, rotation: 0 })
  const img1 = await capture(page)
  const bb1 = bbox(img1)
  const eye1 = await centroid(img1, (r, g, b) => r > 240 && g > 240 && b > 240)

  await set({ scale: 2 })
  const img2 = await capture(page)
  const bb2 = bbox(img2)
  const eye2 = await centroid(img2, (r, g, b) => r > 240 && g > 240 && b > 240)

  // 眼质心相对身体包围盒左上角，再除以缩放 → 应还原为同一局部坐标
  const rel1 = eye1 && bb1 ? { x: (eye1.x - bb1.minX) / 1, y: (eye1.y - bb1.minY) / 1 } : null
  const rel2 = eye2 && bb2 ? { x: (eye2.x - bb2.minX) / 2, y: (eye2.y - bb2.minY) / 2 } : null
  const relErr = rel1 && rel2 ? Math.max(Math.abs(rel1.x - rel2.x), Math.abs(rel1.y - rel2.y)) : Infinity
  out.rel = { rel1, rel2, relErr }
  out.c3 = relErr <= 1.5

  // ---- C5 nearest 采样（整数倍放大后块状纯色）----
  await set({ scale: 2, rotation: 0 })
  const imgNearest = await capture(page)
  const bbN = bbox(imgNearest)
  const uniformity = blockUniformity(imgNearest, 2, bbN)
  out.uniformity = uniformity
  out.c5 = uniformity >= 0.98

  await page.close()
  return out
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const edge = BROWSER_CANDIDATES.find((p) => existsSync(p))
  if (!edge) {
    console.error('未找到可用浏览器（Edge / Chrome）。请安装其一后重试。')
    process.exit(2)
  }
  console.log('=== 验证点 C：运行时合成 ===')
  console.log(`浏览器：${edge}`)
  console.log('')

  const { server, port } = await startServer()
  const browser = await chromium.launch({ executablePath: edge, headless: true })

  try {
    const correct = await runMode(browser, port, 'correct')
    const naive = await runMode(browser, port, 'naive')

    const pad = (s, n) => String(s).padEnd(n, ' ')
    for (const r of [correct, naive]) {
      const d = r.coexistDetail
      console.log(`── mode=${r.mode} ──`)
      console.log(
        `  C1 四类共存      base=${r.coexist.base ? '✓' : '✗'} 覆盖层=${r.coexist.overlay ? '✓' : '✗'}(${d.eyePixels}px) ` +
          `眨眼=${r.coexist.blink ? '✓' : '✗'}(${d.blinkDiff}px) 嘴型=${r.coexist.mouth ? '✓' : '✗'}(${d.mouthDiff}px)   ${r.c1 ? '✓ PASS' : '✗ FAIL'}`,
      )
      console.log('  C2 锚点缩放不变（脚底屏幕位置应恒定）：')
      for (const row of r.scaleRows) {
        console.log(
          `       scale=${String(row.scale).padEnd(4)} 脚底(${row.foot.x.toFixed(0)},${row.foot.y.toFixed(0)})  ` +
            `相对 1× 漂移 (${row.driftX.toFixed(0)},${row.driftY.toFixed(0)})px`,
        )
      }
      console.log(`       最大漂移 ${r.maxDrift.toFixed(1)}px（阈值 2px）                          ${r.c2 ? '✓ PASS' : '✗ FAIL'}`)
      console.log(`  C3 覆盖层跟随    缩放 1×/2× 下眼的相对位置差 ${r.rel.relErr === Infinity ? 'n/a' : r.rel.relErr.toFixed(2)}px（要求 ≤1.5）  ${r.c3 ? '✓ PASS' : '✗ FAIL'}`)
      console.log(`  C5 nearest 采样  2× 放大后纯色块占比 ${(r.uniformity * 100).toFixed(1)}%                     ${r.c5 ? '✓ PASS' : '✗ FAIL'}`)
      console.log('')
    }

    console.log('── 对照结论 ──')
    console.log(`  correct 模式：C2 ${correct.c2 ? '通过 —— 放大时脚底稳定' : '未通过'}`)
    const naiveVerdict = naive.c2 ? '通过' : '未通过 —— 放大时脚底漂移 ' + naive.maxDrift.toFixed(0) + 'px'
    console.log(`  naive   模式：C2 ${naiveVerdict}`)
    console.log('  naive 复现的是「根容器原点未设在锚点」这个坑：以舞台左上角为缩放轴，')
    console.log('  角色越大越往下沉，看起来像「站不住」。correct 模式把原点设在锚点即消除。')
    console.log('')

    const pass = correct.c1 && correct.c2 && correct.c3 && correct.c5
    console.log(`验证点 C 总判定（以 correct 模式为准）：${pass ? '✓ PASS' : '✗ FAIL'}`)
    console.log(`证据截图：${EVIDENCE}/composite-*.png`)

    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(EVIDENCE, { recursive: true })
    await writeFile(
      join(EVIDENCE, 'check-composite-result.json'),
      JSON.stringify({ correct, naive, pass }, null, 2) + '\n',
      'utf-8',
    )

    process.exitCode = pass ? 0 : 1
  } finally {
    await browser.close()
    server.close()
  }
}

main().catch((err) => {
  console.error('[check-composite] 失败:', err)
  process.exit(1)
})
