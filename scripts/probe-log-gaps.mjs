/**
 * 全天「主线程心跳断档」扫描 —— 补捕获器看不到的部分。
 *
 * 捕获器只在**它运行期间**、且**超过阈值（2s）**时才会记录。本脚本换一个口径：
 * 应用自己的 `mcp:status` 是**每 5 秒一条**的主线程 IPC 心跳（渲染层定时发、
 * 主进程处理并落日志）。**它的间隔被拉长 = 主线程（或渲染层）被卡住**。
 *
 * 这样能得到全天所有卡顿的分布，而不仅是捕获器在岗时段。
 *
 * ⚠️ 两个已知坑（判读时必须扣掉）：
 *   ① 渲染层不活跃（窗口最小化 / 未加载完）时它本来就不发 —— 断档 ≠ 一定卡顿；
 *   ② 应用重启会造成几分钟的"断档"，那不是卡顿，是停机。
 *   所以每个长间隔都要看**前后有没有别的日志**来自证。
 *
 *   node C:/tmp/probe-log-gaps.cjs [YYYY-MM-DD]
 */
import fs from 'node:fs'

const day = process.argv[2] ?? '2026-09-20'
const LOG = `C:/Users/75791/.lumii/logs/app/mtbot-${day}.log`

const raw = fs.readFileSync(LOG, 'utf8').split('\n')
const TS_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/
const parse = (s) => Date.parse(s.replace(' ', 'T')) // 日志是本地时间，无 Z

/** 所有日志行（含时间戳与原文） */
const lines = []
for (const l of raw) {
  const m = TS_RE.exec(l)
  if (m) lines.push({ t: parse(m[1]), text: l })
}
if (lines.length === 0) {
  console.error('没读到日志行:', LOG)
  process.exit(1)
}

const statuses = lines.filter((l) => /mcp:status/.test(l.text))
console.log(`文件 ${LOG}`)
console.log(`总行数 ${lines.length} | mcp:status ${statuses.length} 条`)
console.log(`时间跨度 ${new Date(lines[0].t).toLocaleString()} → ${new Date(lines[lines.length - 1].t).toLocaleString()}\n`)

// ── 间隔分布 ──────────────────────────────────────────────────────────────
const gaps = []
for (let i = 1; i < statuses.length; i++) {
  gaps.push({ from: statuses[i - 1], to: statuses[i], ms: statuses[i].t - statuses[i - 1].t })
}
const sorted = [...gaps].sort((a, b) => a.ms - b.ms)
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]?.ms ?? 0
console.log('mcp:status 间隔分布（ms）:')
console.log(`  最小 ${sorted[0]?.ms} | p50 ${q(0.5)} | p90 ${q(0.9)} | p99 ${q(0.99)} | 最大 ${sorted[sorted.length - 1]?.ms}`)
console.log(`  >8s 的有 ${gaps.filter((g) => g.ms > 8000).length} 处\n`)

// ── 长间隔明细（附前后日志，用于区分「卡顿」与「停机/静默」）────────────────
const long = gaps.filter((g) => g.ms > 8000).sort((a, b) => b.ms - a.ms)
console.log(`=== 间隔 > 8s 的 ${long.length} 处 ===`)
for (const g of long.slice(0, 25)) {
  const secs = (g.ms / 1000).toFixed(1)
  console.log(`\n[${secs}s] ${new Date(g.from.t).toLocaleTimeString()} → ${new Date(g.to.t).toLocaleTimeString()}`)
  // 断档期间（含两端各 1 秒）有没有别的日志？有 = 主线程还活着，只是这个心跳没发
  const during = lines.filter((l) => l.t > g.from.t + 1000 && l.t < g.to.t - 1000)
  const kinds = new Map()
  for (const l of during) {
    const k = (/\[([A-Za-z:\-]+)\]/.exec(l.text.replace(/^\[[^\]]+\] /, '')) ?? [, '?'])[1]
    kinds.set(k, (kinds.get(k) ?? 0) + 1)
  }
  console.log(
    `  断档期间其他日志: ${during.length} 条` +
      (during.length ? ` —— ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}×${n}`).join(', ')}` : '（完全静默）'),
  )
  console.log(`  断档前最后一行: ${g.from.text.slice(24, 150)}`)
  console.log(`  断档后第一行:   ${g.to.text.slice(24, 150)}`)
}

// ── 与捕获器产物对齐 ──────────────────────────────────────────────────────
console.log('\n=== 与捕获器产物对齐（捕获时刻 → 扫描到的断档）===')
const dir = 'C:/tmp/freeze-captures'
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const j = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'))
    const at = Date.parse(j.detectedAt) // UTC
    // 本地时区偏移
    const offsetMin = new Date().getTimezoneOffset()
    const localMs = at - offsetMin * 60_000
    const near = gaps
      .filter((g) => Math.abs(g.to.t - localMs) < 60_000 || Math.abs(g.from.t - localMs) < 60_000)
      .sort((a, b) => b.ms - a.ms)[0]
    console.log(
      `  ${f.replace('freeze-', '').replace('.json', '')} [${j.kind}] 心跳${j.heartbeatLagMs ?? '超时'}` +
        (near ? `  ↔ 扫描到最近断档 ${(near.ms / 1000).toFixed(1)}s` : '  ↔ 未匹配到断档'),
    )
  }
}
