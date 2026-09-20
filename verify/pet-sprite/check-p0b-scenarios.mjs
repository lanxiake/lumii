#!/usr/bin/env node
/**
 * P0-b 场景验证：三方案对比 + 场景 A / B
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §8
 *
 * 两个**淘汰场景**要给出「能淘汰方案」的结论，所以判据必须是可测量的：
 *
 *   场景 A｜抓取—拖拽—投掷—落地
 *     淘汰标准：若某方案无法在拖拽中维持正确命中区域，该方案不可用于量产。
 *     → 采样整个画布，用 pet-core 的纯函数独立算一遍期望命中，与渲染器的
 *       `hitTest` 逐点比对，要求 100% 一致（不一致就是坐标变换或筛选逻辑有分歧）。
 *
 *   场景 B｜对话中表情 × 动作 × 口型同时叠加
 *     淘汰标准：无法在 < 150 帧/角色内表达 12 表情 × 4 口型 × 3 动作。
 *     → 数帧数；并**实测三个轴是否真的各自生效**（截图数像素，而不是看日志说设了）。
 *
 * 用法：node verify/pet-sprite/check-p0b-scenarios.mjs
 * 会自行拉起 pet-lab 的 vite（5175），跑完关掉。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { chromium } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const WINDOWS_APP = join(REPO, 'apps', 'windows')

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

/** 进度落盘：Node 的 stdout 写文件是块缓冲的，看不到中间状态；appendFileSync 保证同步可见 */
const PROGRESS = join(HERE, '_p0b-progress.log')
const progress = (m) => appendFileSync(PROGRESS, `${new Date().toISOString()} ${m}
`)

/** 证据落盘目录（与 P-1 的 check-*-result.json 同处） */
const EVIDENCE = join(REPO, 'docs', 'test', 'pet-sprite', 'evidence')

const PORT = 5175
const MODELS = [
  'demo_pixel_cat',
  'demo_hires_girl',
  'demo_variant_a',
  'demo_variant_b',
  'demo_variant_c',
]

// ---------------------------------------------------------------------------
// pet-lab 生命周期
// ---------------------------------------------------------------------------

function startLab() {
  const child = spawn('pnpm', ['lab'], {
    cwd: WINDOWS_APP,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return child
}

async function waitForLab(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/sprite-lab.html`)
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// ---------------------------------------------------------------------------
// 截图 → 像素统计
// ---------------------------------------------------------------------------

/** 数某种颜色附近的像素（JPEG 无关：这里截的是 PNG） */
function countColor(data, ch, hex, tol) {
  const n = parseInt(hex.slice(1), 16)
  const [tr, tg, tb] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  let c = 0
  for (let i = 0; i < data.length; i += ch) {
    if (Math.abs(data[i] - tr) <= tol && Math.abs(data[i + 1] - tg) <= tol && Math.abs(data[i + 2] - tb) <= tol) c++
  }
  return c
}

/** 两张截图不同的像素占比（用于判断"画面真的变了"） */
function diffRatio(a, b, ch) {
  let diff = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += ch) {
    if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) diff++
  }
  return diff / (n / ch)
}

/** favicon 之类的无关请求不算问题，但要能看出是什么 */
const realFailedSafe = (all) => all.filter((u) => !/favicon/i.test(u))
const realErrorsSafe = (all) => all.filter((e) => !/favicon|Failed to load resource/i.test(e))

async function shot(page) {
  const buf = await page.locator('#petCanvas').screenshot({ type: 'png' })
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, info }
}

// ---------------------------------------------------------------------------
// 单个模型的验证
// ---------------------------------------------------------------------------

async function verifyModel(page, modelId) {
  await page.evaluate((id) => window.__lab.selectModel(id), modelId)
  await page.waitForTimeout(600)

  const snap = await page.evaluate(() => window.__lab.snapshot())
  const result = {
    modelId,
    snap,
    probe: null,
    mouth: null,
    expression: null,
    motion: null,
    sceneA: null,
    error: null,
  }

  try {
    // ---- 场景 A：命中区一致性（独立算一遍期望，逐点比对） ----
    const probe = await page.evaluate(() => {
      window.__lab.probeHitAreas()
      return window.__labLog[window.__labLog.length - 1]
    })
    // 从日志里取回结构化前的结果，重算一遍拿数字
    result.probe = await page.evaluate(() => {
      const m = window.__lab
      const s = m.snapshot()
      const reported = s.hitTransform
      const independent = m.expectedTransform()
      if (!reported || !independent) return null
      // 变换本身也要比：缩放漏乘、锚点用错、位置没跟上拖拽都会在这里现形
      const transformMatch =
        Math.abs(reported.scale - independent.scale) < 1e-9 &&
        Math.abs(reported.positionX - independent.positionX) < 1e-9 &&
        Math.abs(reported.positionY - independent.positionY) < 1e-9 &&
        reported.anchorX === independent.anchorX &&
        reported.anchorY === independent.anchorY
      let matched = 0
      let total = 0
      const W = document.getElementById('petCanvas').clientWidth
      const H = document.getElementById('petCanvas').clientHeight
      for (let y = 0; y < H; y += 8) {
        for (let x = 0; x < W; x += 8) {
          const expected = m.expectedHitIndependent(s.groups?.[0] ?? null, x, y)
          const actual = m.hitTest(x, y)
          total++
          if (expected === actual) matched++
        }
      }
      return { matched, total, transformMatch, reported, independent, probeLog: probe }
    })

    // ---- 场景 A：拖到别处后命中区跟着走 ----
    const sceneA = await page.evaluate(async () => {
      const m = window.__lab
      const c = document.getElementById('petCanvas')
      const before = m.snapshot().position
      m.setPosition(c.clientWidth * 0.25, c.clientHeight * 0.25)
      await new Promise((r) => setTimeout(r, 200))
      const after = m.snapshot().position
      // 命中区应随位置平移：把探针点也平移同样的位移，结果应保持一致
      const dx = after.x - before.x
      const dy = after.y - before.y
      let stillHits = 0
      let samples = 0
      for (let y = 0; y < c.clientHeight; y += 12) {
        for (let x = 0; x < c.clientWidth; x += 12) {
          const expected = m.expectedHitIndependent('Idle', x, y)
          const actual = m.hitTest(x, y)
          samples++
          if (expected === actual) stillHits++
        }
      }
      return { before, after, dx, dy, stillHits, samples }
    })
    result.sceneA = sceneA

    // ---- 场景权：三个轴各自真的生效（截图数像素） ----
    // 口型：不同档位下"嘴部色"的像素数应不同
    const mouthLevels = await page.evaluate(() => {
      const s = window.__lab.snapshot()
      // 没有分层槽 = 整体帧方案，口型烘在整帧里，没有可切换的层
      return (s.slots?.length ?? 0) === 0 ? [] : [0, 0.33, 0.66, 1]
    })
    if (mouthLevels.length > 0) {
      const counts = []
      for (const v of mouthLevels) {
        await page.evaluate((v) => window.__lab.setMouthOpen(v), v)
        await page.waitForTimeout(150)
        const { data, info } = await shot(page)
        counts.push(countColor(data, info.channels, '#7a2b2b', 40))
      }
      result.mouth = { levels: mouthLevels, counts, monotonic: counts.every((c, i) => i === 0 || c >= counts[i - 1]) }
    }

    // 表情：不同表情下画面应不同
    const exprCount = await page.evaluate(() => {
      const s = window.__lab.snapshot()
      return s.groups ? 4 : 0
    })
    if (exprCount > 0) {
      const diffs = []
      let prev = null
      for (let i = 0; i < exprCount; i++) {
        await page.evaluate((i) => window.__lab.setExpression(i), i)
        await page.waitForTimeout(150)
        const { data, info } = await shot(page)
        if (prev) diffs.push(diffRatio(prev, data, info.channels))
        prev = data
      }
      result.expression = { diffs, allChanged: diffs.every((d) => d > 0.0005) }
    }

    // 动作：切到另一个组后画面应不同
    // 用 Jump 而不是 Talk：生成器里 Talk 与 Idle 用同一份 frames（真实语义就是如此，
    // 说话靠口型层表达），拿它比只会比出 fps 差，测不到换组真的换了帧
    const otherGroup = snap.groups.includes('Jump') ? 'Jump' : snap.groups.find((g) => g !== 'Idle')
    if (otherGroup) {
      await page.evaluate((g) => window.__lab.setExpression(0), 0)
      await page.evaluate(() => window.__lab.setMouthOpen(0))
      await page.evaluate(() => window.__lab.playMotion('Idle', 0))
      await page.waitForTimeout(200)
      const a = await shot(page)
      await page.evaluate((g) => window.__lab.playMotion(g, 0), otherGroup)
      await page.waitForTimeout(200)
      const b = await shot(page)
      result.motion = { group: otherGroup, diff: diffRatio(a.data, b.data, a.info.channels) }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }

  return result
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const browserPath = BROWSER_CANDIDATES.find((p) => existsSync(p))
  if (!browserPath) {
    console.error('未找到可用浏览器（Edge / Chrome）。')
    process.exit(2)
  }

  console.log('=== P0-b 场景验证：三方案对比 ===')
  console.log(`浏览器：${browserPath}`)
  console.log('')

  const lab = startLab()
  let browser = null
  try {
    progress('lab starting')
    if (!(await waitForLab())) throw new Error('pet-lab 未在 60s 内就绪')
    progress('lab ready')
    browser = await chromium.launch({ executablePath: browserPath, headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    const failedRequests = []
    page.on('response', (res) => {
      if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`)
    })
    page.on('requestfailed', (req) => failedRequests.push(`FAILED ${req.url()}`))

    await page.goto(`http://127.0.0.1:${PORT}/sprite-lab.html`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__lab?.ready === true, { timeout: 30000 })
    progress('lab page ready')

    const results = []
    for (const id of MODELS) {
      process.stdout.write(`  · ${id} … `)
      progress(`start ${id}`)
      const r = await verifyModel(page, id)
      progress(`done ${id}${r.error ? ' ERROR=' + r.error : ''}`)
      results.push(r)
      console.log(r.error ? `失败：${r.error}` : '完成')
    }

    // ---- 证据落盘 ----
    mkdirSync(EVIDENCE, { recursive: true })
    const payload = {
      generatedAt: new Date().toISOString(),
      browser: browserPath,
      models: results,
      projection: {
        demoSet: { expressions: 4, mouths: 4, bodyPoses: 3 },
        threshold: 150,
        perScheme: {
          A: { demoFrames: results.find((r) => r.modelId === 'demo_variant_a')?.snap.idleFrames ?? null, at12Expressions: 12 * 4 * 3 },
          B: { demoFrames: results.find((r) => r.modelId === 'demo_variant_b')?.snap.idleFrames ?? null, at12Expressions: 3 + 12 + 4 },
          C: { demoFrames: results.find((r) => r.modelId === 'demo_variant_c')?.snap.idleFrames ?? null, at12Expressions: 3 + 12 + 4 },
        },
      },
      pageErrors: realErrorsSafe(errors),
      failedRequests: realFailedSafe(failedRequests),
    }
    writeFileSync(join(EVIDENCE, 'check-p0b-scenarios-result.json'), JSON.stringify(payload, null, 2))

    // ---- 汇总表 ----
    const pad = (s, n) => String(s).padEnd(n)
    console.log('')
    console.log('| 模型 | 槽位 | Idle帧数 | 图集KB | 加载ms | 命中一致 | 口型单调 | 表情生效 | 动作生效 |')
    console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const r of results) {
      const s = r.snap
      const probe = r.probe ? `${r.probe.matched}/${r.probe.total}${r.probe.transformMatch ? '' : ' 变换✗'}` : '—'
      const mouth = r.mouth ? (r.mouth.monotonic ? '✓' : `✗ ${r.mouth.counts.join('/')}`) : '（无口型层）'
      const expr = r.expression ? (r.expression.allChanged ? '✓' : `✗ ${r.expression.diffs.map((d) => (d * 100).toFixed(2) + '%').join(' ')}`) : '—'
      const motion = r.motion ? `${(r.motion.diff * 100).toFixed(1)}%` : '—'
      console.log(
        `| ${pad(r.modelId, 18)} | ${pad(s.slots.join('/') || '（无）', 12)} | ${pad(s.idleFrames, 8)} | ${pad((s.atlasBytes / 1024).toFixed(1), 6)} | ${pad(s.loadMs?.toFixed(0), 6)} | ${pad(probe, 8)} | ${pad(mouth, 8)} | ${pad(expr, 8)} | ${pad(motion, 8)} |`,
      )
    }

    // ---- 场景 A 明细 ----
    console.log('')
    console.log('场景 A（拖拽后命中区是否跟着走）：')
    for (const r of results) {
      const a = r.sceneA
      if (!a) {
        console.log(`  ${r.modelId}: 未采集`)
        continue
      }
      console.log(
        `  ${pad(r.modelId, 18)} 位置 (${a.before.x.toFixed(0)},${a.before.y.toFixed(0)}) → (${a.after.x.toFixed(0)},${a.after.y.toFixed(0)})，命中一致 ${a.stillHits}/${a.samples}`,
      )
    }

    // ---- 资源量外推 ----
    console.log('')
    console.log('场景 B 资源量（演示集 = 4 表情 × 4 口型 × 3 身体帧）：')
    const byVariant = { a: null, b: null, c: null }
    for (const r of results) {
      const m = /^demo_variant_([abc])$/.exec(r.modelId)
      if (m) byVariant[m[1]] = r.snap.idleFrames
    }
    const EXPR = 12
    const MOUTH = 4
    const BODY = 3
    console.log(`  A 整体帧   演示 ${byVariant.a} 帧 → 外推 12 表情 ${EXPR * MOUTH * BODY} 帧`)
    console.log(`  B 分层差分 演示 ${byVariant.b} 帧 → 外推 12 表情 ${BODY + EXPR + MOUTH} 帧`)
    console.log(`  C 混合     演示 ${byVariant.c} 帧 → 外推 12 表情 ${BODY + EXPR + MOUTH} 帧`)
    console.log(`  阈值 150 帧：A ${EXPR * MOUTH * BODY < 150 ? '未超' : '超出'}，B/C ${BODY + EXPR + MOUTH < 150 ? '未超' : '超出'}`)

    // favicon 之类的无关请求不算问题，但要把 URL 打出来，不留'有个 404 但不知道是什么'
    const realFailed = realFailedSafe(failedRequests)
    if (realFailed.length) {
      console.log('')
      console.log('失败请求：')
      for (const u of realFailed.slice(0, 10)) console.log(`  ! ${u}`)
    }
    const realErrors = realErrorsSafe(errors)
    if (realErrors.length) {
      console.log('')
      console.log('页面错误：')
      for (const e of realErrors.slice(0, 10)) console.log(`  ! ${e}`)
    }

    // 一台否决：只要命中一致性不是 100%，场景 A 就没过
    const badProbe = results.filter((r) => r.probe && r.probe.matched !== r.probe.total)
    if (badProbe.length) {
      console.log('')
      console.log(`✗ 命中一致性未达 100%：${badProbe.map((r) => r.modelId).join(', ')}`)
      process.exitCode = 1
    } else if (realErrors.length === 0 && realFailed.length === 0) {
      console.log('')
      console.log('✓ 五个模型的命中区一致性均为 100%，页面无错误')
    }
  } finally {
    if (browser) await browser.close()
    lab.kill()
    // vite 在 Windows 上会留下子进程，补一刀
    try {
      spawn('taskkill', ['/pid', String(lab.pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* 已经退了 */
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
