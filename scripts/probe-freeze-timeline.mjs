/**
 * 分析一个冻结捕获的 cpuprofile 时间轴：**冻结窗口前后主线程分别在做什么**。
 *
 * 动机：12:23:39 那次窗口内只有 136 个样本（覆盖率 0.6%），栈几乎看不到东西。
 * 但 profile 一共 10304 个样本 —— 窗口**外**的那些能说明「正常时在做什么」，
 * 与窗口内的空白对比，往往能反推出阻塞发生在哪一类操作上。
 *
 *   node scripts/probe-freeze-timeline.mjs <capture.json> [窗口前后各多少 ms]
 */
import fs from 'node:fs'
import path from 'node:path'

const jsonPath = process.argv[2]
if (!jsonPath) {
  console.error('用法: node scripts/probe-freeze-timeline.mjs <freeze-*.json> [spanMs]')
  process.exit(1)
}
const spanMs = Number(process.argv[3] ?? 15000)

const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
const profPath = jsonPath.replace(/\.json$/, '.cpuprofile')
if (!fs.existsSync(profPath)) {
  console.error('没有对应的 .cpuprofile（native 冻结常如此）:', profPath)
  process.exit(1)
}
const p = JSON.parse(fs.readFileSync(profPath, 'utf8'))

const detected = Date.parse(meta.detectedAt)
const frozenFrom = meta.frozenFrom ? Date.parse(meta.frozenFrom) : detected
// 锚点：profile.startTime 对应的 wall clock（捕获器写 meta 时用的同一套算法）
// 这里用「窗口内首个样本」反推 —— 更稳，不依赖捕获器内部状态
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const path8 = (id) => {
  const out = []
  let c = byId.get(id)
  for (let g = 0; c && g < 8; g++) {
    const cf = c.callFrame
    out.unshift(`${cf.functionName || '(anon)'}@${(cf.url || 'native').replace(/^file:\/\/\//, '').split(/[\\/]/).pop()}:${cf.lineNumber}`)
    c = byId.get(c.parent)
  }
  return out.join(' ← ')
}

// 样本的绝对时间需要锚点；捕获器没写进 meta，用「最后一个样本 ≈ 检测时刻」近似
let cum = p.startTime
const us = p.samples.map((_, i) => (cum += p.timeDeltas[i]))
const lastUs = us[us.length - 1]
const anchor = detected - (lastUs - p.startTime) / 1000 // wall clock of startTime

const buckets = new Map()
for (let i = 0; i < p.samples.length; i++) {
  const wall = anchor + (us[i] - p.startTime) / 1000
  const rel = wall - frozenFrom
  if (rel < -spanMs || rel > spanMs) continue
  const k = Math.round(rel / 500) * 500 // 500ms 一桶
  if (!buckets.has(k)) buckets.set(k, [])
  buckets.get(k).push(p.samples[i])
}

console.log(`捕获: ${path.basename(jsonPath)}  [${meta.kind}]  心跳 ${meta.heartbeatLagMs ?? '超时'}ms`)
console.log(`冻结窗口: ${new Date(frozenFrom).toLocaleTimeString()} → ${new Date(detected).toLocaleTimeString()}`)
console.log(`profile 覆盖 ${Math.round((lastUs - p.startTime) / 1000)}ms，共 ${p.samples.length} 样本\n`)
console.log('相对冻结起点   样本  主要栈（前 2）')
console.log('─'.repeat(96))
for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
  const ids = buckets.get(k)
  const counts = new Map()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([id, n]) => `${n}× ${path8(id).slice(0, 62)}`)
  const mark = k >= 0 && k <= (detected - frozenFrom) ? ' ⛔' : ''
  console.log(
    `${String(k).padStart(8)}ms  ${String(ids.length).padStart(5)}${mark}  ${top.join('  |  ')}`,
  )
}
console.log('\n⛔ = 落在冻结窗口内')
