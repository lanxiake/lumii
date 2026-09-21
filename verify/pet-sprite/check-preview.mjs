#!/usr/bin/env node
/**
 * check-preview.mjs — 验 `review/index.html` 真的能看
 *
 * ## 为什么要机器验
 *
 * 这个页面里几乎所有东西都是**打开浏览器之前看不见的**：脚本语法错、图集路径写错、
 * 帧条引用了一个不存在的帧、切了组但画面没换。前两种会白屏（一眼能发现），
 * 后两种**看着正常但其实没在工作**——画面停在第 0 帧也能显示出一个像模像样的宠物。
 * 而且它是 `file://` 直接打开的页面，没有构建步骤兜底，错就错到底。
 *
 * ## 走 `file://`，不走 HTTP
 *
 * 页面最重要的用法是**双击打开**，所以就拿 `file://` 测。代价是 canvas 被跨源污染、
 * 页面里读不了像素（这也是页面自己不 `getImageData` 的原因）；断言改用
 * **元素截图比对**——走合成器，不受污染影响。
 *
 * 用法：node check-preview.mjs [--shot]
 *   --shot 额外把整页截图存到 docs/test/pet-sprite/evidence/
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const sharp = createRequire(path.join(REPO, 'package.json'))('sharp')
const PAGE = path.join(REPO, 'verify/pet-sprite/review/index.html')
const EVIDENCE = path.join(REPO, 'docs/test/pet-sprite/evidence')
const SHOT = process.argv.includes('--shot')

/** 系统 Edge 优先，省一次 Chromium 下载（与 check-composite.mjs 同一份候选表） */
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

if (!fs.existsSync(PAGE)) {
  throw new Error(`页面不存在：${PAGE}——先跑 make-preview.mjs`)
}
if (!fs.existsSync(path.join(REPO, 'verify/pet-sprite/review/models.js'))) {
  throw new Error('models.js 不存在——先跑 make-preview.mjs')
}

const exe = BROWSERS.find((p) => fs.existsSync(p))
const failures = []
const results = []
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)
  results.push({ label, pass: !!cond, detail })
  if (!cond) failures.push(label)
}

// **不加 `--allow-file-access-from-files`**：加了会让 canvas 不被污染，
// 但用户双击打开时没有这个开关——测试环境必须和真实用法一致，否则验的是另一回事。
const browser = await chromium.launch({ executablePath: exe })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

await page.goto(pathToFileURL(PAGE).href)
await page.waitForFunction(() => !!window.__preview, null, { timeout: 10000 })

// ---- 1. 加载干净 ----
console.log('\n### 加载')
await page.waitForTimeout(600)
ok(errors.length === 0, '无 console error / pageerror', errors.slice(0, 3).join(' | '))

const models = await page.evaluate(() => window.PET_REVIEW.models.map((m) => m.id))
ok(models.length >= 8, `模型数 ${models.length}`, models.join(' '))

// 挨个切一遍，把所有图都拉起来——顺带验证"切模型不炸"
for (const id of models) await page.evaluate((x) => window.__preview.selectModel(x), id)
await page.waitForFunction(() => window.__preview.loading.length === 0, null, { timeout: 20000 })
ok(true, '所有图集与原始图加载完成')

// ---- 2. 每只模型的帧条与清单一致 ----
console.log('\n### 帧条 / 清单一致')
for (const id of models) {
  const r = await page.evaluate((x) => {
    window.__preview.selectModel(x)
    const st = window.__preview.state
    const dom = document.querySelectorAll('#frames .fcell').length
    const tabs = document.querySelectorAll('#tabs button').length
    return { groups: window.PET_REVIEW.models.find((m) => m.id === x).animations.length, st, dom, tabs }
  }, id)
  ok(
    r.st.gi >= 0 && r.dom === r.st.frames && r.tabs === r.groups,
    `${id}`,
    `组 ${r.tabs}/${r.groups} · 帧条 ${r.dom}/${r.st.frames} 帧 · 当前 ${r.st.group}`,
  )
}

// ---- 3. 合成播放真的在动 ----
console.log('\n### 合成播放')
const stage = await page.$('#stageCv')
await page.evaluate(() => { window.__preview.pause() })

/** 跳到某个动作组的第 a 帧、再跳到第 b 帧，比对两次画面 */
async function framesDiffer(id, group, a, b) {
  const jump = async (frame) => {
    await page.evaluate(([mid, g, i]) => {
      const p = window.__preview
      p.selectModel(mid)
      p.selectGroup(window.PET_REVIEW.models.find((m) => m.id === mid).animations.findIndex((x) => x.group === g))
      p.goto(i)
    }, [id, group, frame])
    await page.waitForTimeout(140)
    return stage.screenshot()
  }
  const s1 = await jump(a)
  const s2 = await jump(b)
  return !s1.equals(s2)
}

/**
 * 真人素材这一组的第 0 帧与第 2 帧**故意**用一对逐像素相同的帧：
 *
 * 实测 `shimeji_nekojapan.png` 的 WALK 行 4 格里，第 0 格与第 2 格在原表里就
 * 逐字节相同（不是切图切错），五只猫**全部**如此——同一位画师、同源素材。
 * 所以这里一正一反地钉两件事：不同的帧要画出不同画面，"相同的帧"要真的画得一样。
 * 后者同时是生成侧 `duplicates` 判据的交叉验证——两条独立路径得出同一结论才算数。
 */
ok(await framesDiffer('demo_shimeji_nekojapan', 'Walk', 0, 1), '真人素材：Walk 第 0 帧 vs 第 1 帧画面不同')
ok(!(await framesDiffer('demo_shimeji_nekojapan', 'Walk', 0, 2)), '真人素材：Walk 第 0 帧 vs 第 2 帧画面**相同**（素材里就是同一张图）')
ok(await framesDiffer('demo_anime_girl', 'Wave', 1, 4), 'AI 直出：Wave 第 1 帧 vs 第 4 帧画面不同')
ok(await framesDiffer('demo_mecha_gundam', 'Idle', 0, 2), 'AI 直出：Idle 第 0 帧 vs 第 2 帧画面不同')

// 帧条上要标出重复帧，否则"8 帧只有 3 个姿势"这件事在页面上是看不见的
const dupMarks = await page.evaluate(() => {
  window.__preview.selectModel('demo_shimeji_nekojapan')
  const g = window.PET_REVIEW.models.find((m) => m.id === 'demo_shimeji_nekojapan').animations.findIndex((x) => x.group === 'Walk')
  window.__preview.selectGroup(g)
  return {
    marks: document.querySelectorAll('#frames .dup').length,
    note: document.getElementById('frameNote').textContent,
  }
})
ok(dupMarks.marks === 2, '重复帧在帧条上标出来了', `2 帧各标 1 处（实得 ${dupMarks.marks}）`)
ok(/4 帧（3 个不同画面）/.test(dupMarks.note), '帧条摘要报出真实画面数', dupMarks.note.slice(0, 80))

// 原始图的概况要**同步**跟着状态走。放进 rAF 里会让读它的人拿到上一只模型的值，
// 而"有画 4/4 格 · 被引用 4 格"配着刚切过来的那张表显示出来，看着完全正常。
const noteSync = await page.evaluate(() => {
  const note = () => document.getElementById('srcNote').textContent
  window.__preview.selectModel('demo_shimeji_nekojapan')
  window.__preview.selectGroup(0)
  const afterModel = note() // 切模型：应当立刻是这张表的概况
  window.__preview.selectModel('demo_cartoon_cat')
  document.querySelectorAll('#srcTabs button')[2].click() // 再点第三个页签（表情批）
  return [afterModel, note()]
})
ok(
  noteSync[0].includes('整表') && noteSync[1].includes('表情批'),
  '切模型 / 点原图页签，概况都同步跟上',
  noteSync.map((x) => x.slice(0, 20)).join('  →  '),
)

// ---- 4. 播放推进 + 速度倍率 ----
console.log('\n### 播放与速度')
await page.evaluate(() => {
  window.__preview.selectModel('demo_anime_girl')
  window.__preview.selectGroup(0)
  window.__preview.setSpeed(1)
  window.__preview.goto(0)
  window.__preview.play()
})
await page.waitForTimeout(500)
const moved = await page.evaluate(() => window.__preview.state.i)
ok(moved !== 0, '1× 播放 500ms 后帧号推进了', `停在第 ${moved} 帧`)

/**
 * 速度的判据用**播放时钟推进量**，不用帧号。
 *
 * 帧号是取模的，快放转好几圈之后回到哪一帧全看运气，比不出快慢。
 * `clock` 是累计的播放时长（毫秒，已乘倍率），直接反映"这段时间里放了多少动画"。
 */
async function clockAfter(speed, ms) {
  await page.evaluate((s) => {
    const p = window.__preview
    p.selectModel('demo_anime_girl')
    p.selectGroup(0)
    p.goto(0)
    p.setSpeed(s)
    p.play()
  }, speed)
  await page.waitForTimeout(ms)
  const c = await page.evaluate(() => window.__preview.state.clock)
  await page.evaluate(() => window.__preview.pause())
  return c
}
const slow = await clockAfter(0.1, 600)
const fast = await clockAfter(4, 600)
ok(
  fast > slow * 4,
  '速度倍率生效（同样 600ms 内的播放时钟推进量）',
  `0.1× → ${slow}ms，4× → ${fast}ms，比值 ${(fast / Math.max(slow, 1)).toFixed(1)}×`,
)

// ---- 5. 原始出图区有画面 ----
console.log('\n### 原始出图')
const src = await page.$('#srcCv')
for (const [id, si, label] of [
  ['demo_anime_girl', 0, '待机批'],
  ['demo_anime_girl', 1, '挥手批'],
  ['demo_cartoon_cat', 2, '表情批'],
]) {
  await page.evaluate(([mid, s]) => {
    window.__preview.selectModel(mid)
    document.querySelectorAll('#srcTabs button')[s].click()
  }, [id, si])
  await page.waitForTimeout(160)
  const shot = await src.screenshot()
  // 全是棋盘格底的话 PNG 会被压得极小；画出图来之后体积显著变大
  ok(shot.length > 4000, `${id} ${label} 有画面`, `${(shot.length / 1024).toFixed(0)}KB`)
}

/**
 * 画布上**真的画了东西**，不只是 DOM 里有数据。
 *
 * 前面几条断言读的是 `models.js` 与 DOM，验的是"数据算对了"；绘制代码出错
 * （坐标算错、颜色写错、被后面的 fillRect 盖掉）它们一条都抓不到。
 * 这里绕开 canvas 的跨源污染（`file://` 下 `getImageData` 会抛 SecurityError），
 * 走 **元素截图 → sharp 读像素** 的路子。
 *
 * 判据窗口是**量出来的**，不是挑的：画布上同时有另一种橙黄色——当前帧的高亮框
 * `#ffc857` = (255,200,87)，跟角标的 `rgba(255,170,90,.9)`（叠在深底上约
 * (233,156,85)）落在同一个粗窗口里。实测两者的**绿通道差着 44**
 * （角标 160 一带，黄框 208 一带），所以在 g 上切一刀就分开了。
 */
async function orphanMarks() {
  const { data, info } = await sharp(await src.screenshot()).raw().toBuffer({ resolveWithObject: true })
  let n = 0
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (r > 210 && g > 120 && g < 185 && b < 120) n++
  }
  return n
}

await page.evaluate(() => {
  window.__preview.selectModel('demo_shimeji_nekojapan') // 整表里有 12 格"画了没被引用"
  window.__preview.selectGroup(0)
})
await page.waitForTimeout(200)
const orphanOn = await orphanMarks()
await page.evaluate(() => {
  window.__preview.selectModel('demo_anime_girl') // 对照组：4 格全被引用，不该有角标
  window.__preview.selectGroup(0)
})
await page.waitForTimeout(200)
const orphanOff = await orphanMarks()
// 对照组判"少"而不是判"零"：girl 上实测残留 **1 个**像素，是抗锯齿边缘恰好落进窗口。
// 单个像素的噪声躲不掉，所以判据落在"成规模"上——真角标是 12 块各约 70 像素的实心三角，
// 与噪声差着两个数量级。
ok(
  orphanOn > 300 && orphanOff < 20,
  '孤儿格的橙色角标画在了画布上（且干净模型上没有）',
  `nekojapan ${orphanOn} 像素 / girl ${orphanOff} 像素`,
)

// ---- 6. 辅助线开关 ----
console.log('\n### 开关')
await page.evaluate(() => {
  window.__preview.selectModel('demo_shimeji_nekojapan')
  window.__preview.goto(0)
})
await page.waitForTimeout(120)
const withGuides = await stage.screenshot()
await page.evaluate(() => { document.getElementById('guidesChk').click() })
await page.waitForTimeout(160)
const noGuides = await stage.screenshot()
ok(!withGuides.equals(noGuides), '辅助线开关改变画面')
await page.evaluate(() => { document.getElementById('guidesChk').click() })

// ---- 7. 存证 ----
if (SHOT) {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  await page.evaluate(() => {
    window.__preview.selectModel('demo_anime_girl')
    window.__preview.selectGroup(2)
    window.__preview.goto(3)
  })
  await page.waitForTimeout(200)
  const file = path.join(EVIDENCE, 'pet-preview.png')
  await page.screenshot({ path: file })
  console.log(`\n截图 → ${path.relative(REPO, file)}`)
}

await browser.close()

// 结果落 JSON（png 只在 --shot 时产出，不入库）。与其他 check-*.mjs 同一套约定。
fs.mkdirSync(EVIDENCE, { recursive: true })
fs.writeFileSync(
  path.join(EVIDENCE, 'check-preview-result.json'),
  JSON.stringify({ at: new Date().toISOString(), pass: failures.length === 0, results }, null, 2),
)

console.log(`\n${failures.length === 0 ? '✓ 全部通过' : `✗ ${failures.length} 项失败：${failures.join('、')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
