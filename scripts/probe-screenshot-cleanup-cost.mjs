/**
 * 验证 `clearScreenshotTempDir` 的改动：把删除成本移出主线程。
 *
 * 对照的是修复前的实现 `rmSync(dir, {recursive:true, force:true})`：
 * 10000 个截图（每张 100KB）实测 **1565ms**，全在主线程上。
 *
 * 本脚本在**临时目录**里造同样规模的目录，分别跑「旧实现」与「新实现」，
 * 比较**函数返回耗时**（即主线程被占用多久）。
 *
 *   node scripts/probe-screenshot-cleanup-cost.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const N = Number(process.argv[2] ?? 10000)
const SIZE = 100 * 1024 // 接近真实截图
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-shot-cleanup-'))
const dir = path.join(root, 'temp', 'screenshots')

function seed(n) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(dir, `shot-${i}.jpg`), Buffer.alloc(SIZE, i % 256))
  }
}

const ms = (a, b) => Number(b - a) / 1e6
const f = (n) => n.toFixed(0)

// ── 旧实现：同步递归删除 ──────────────────────────────────────────────────
seed(N)
{
  const t0 = process.hrtime.bigint()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const t1 = process.hrtime.bigint()
  console.log(`旧实现（rmSync 递归删）      ${f(ms(t0, t1)).padStart(6)}ms   ← 全部占用主线程`)
}

// ── 新实现：rename + 后台删 ───────────────────────────────────────────────
seed(N)
{
  const t0 = process.hrtime.bigint()
  let trash = null
  try {
    if (fs.existsSync(dir)) {
      trash = `${dir}.trash-${Date.now()}`
      fs.renameSync(dir, trash)
    }
  } catch {
    trash = null
  }
  fs.mkdirSync(dir, { recursive: true })
  if (trash) void fs.promises.rm(trash, { recursive: true, force: true }).catch(() => {})
  const t1 = process.hrtime.bigint()
  console.log(`新实现（rename + 后台删）    ${f(ms(t0, t1)).padStart(6)}ms   ← 主线程只花这么多`)
  // 等后台删完再收尾，避免残留
  await new Promise((r) => setTimeout(r, 3000))
}

// 目录必须立刻是空的（语义不变）
const left = fs.readdirSync(dir).length
console.log(`\n新目录内容: ${left} 项（应为 0）`)
const trashLeft = fs.readdirSync(path.dirname(dir)).filter((n) => n.includes('.trash-'))
console.log(`残留 trash: ${trashLeft.length} 个（后台删完应为 0）`)

fs.rmSync(root, { recursive: true, force: true })
