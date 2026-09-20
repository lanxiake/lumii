/**
 * 实验室验证：**系统进程数会不会放大 spawn 的主线程开销**。
 *
 * 线索（2026-09-20 15:29 那次冻结，捕获器新加的进程表采样）：
 *   - 栈顶 `spawn@native` 6765 个样本（≈1.35 秒）
 *   - 同一刻系统有 **441 个进程**，其中 `cmd.exe × 26` + `conhost.exe × 35`
 *     —— 并发跑三个 CLI 套件留下的（每个 lumii-ui 调用起一个 console host）
 *
 * 而此前两次实验（并发 spawn 60 / execFile 1000）在**干净环境**下最大心跳落后
 * 只有 110ms / 93ms。差异可能不在"并发多少"，而在**当时的系统进程压力**。
 *
 * 设计：被观测进程**按时间自己做两轮**（不依赖 IPC）——
 *   第 1 轮在 2.5s（干净），第 2 轮在 12s（父进程已在 5s 灌入背景进程）。
 *
 *   node scripts/probe-spawn-under-load.mjs [背景进程数] [每轮 spawn 数]
 */
import { spawn } from 'node:child_process'

const BG = Number(process.argv[2] ?? 200)
const N = Number(process.argv[3] ?? 150)

const CHILD = `
  const { spawn } = require('node:child_process')
  let hb = Date.now()
  let maxLag = 0
  setInterval(() => { hb = Date.now() }, 100)
  setInterval(() => {
    const lag = Date.now() - hb
    if (lag > maxLag) maxLag = lag
    try { process.stderr.write('HB ' + lag + ' ' + maxLag + '\\n') } catch {}
  }, 400)

  function round(tag) {
    const t0 = Date.now()
    let done = 0
    for (let i = 0; i < ${N}; i++) {
      const k = spawn(process.execPath, ['-e', 'setTimeout(()=>{},250)'], { stdio: 'ignore' })
      k.on('exit', () => { if (++done === ${N}) process.stderr.write('DONE ' + tag + ' ' + (Date.now() - t0) + ' ' + maxLag + '\\n') })
    }
    process.stderr.write('START ' + tag + '\\n')
  }
  setTimeout(() => round('clean'), 2500)
  setTimeout(() => round('loaded'), 12000)
`

const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['ignore', 'pipe', 'pipe'] })
const t0 = Date.now()
const rounds = []

child.stderr.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    const s = line.trim()
    if (!s) continue
    const start = /^START (\w+)$/.exec(s)
    if (start) {
      const tag = start[1]
      console.log(`\n>>> [${String(Date.now() - t0).padStart(6)}ms] 轮次 ${tag}：并发 spawn ${N} 个`)
      continue
    }
    const done = /^DONE (\w+) (\d+) (\d+)$/.exec(s)
    if (done) {
      console.log(`    全轮耗时 ${done[2]}ms，该轮最大心跳落后 ${done[3]}ms`)
      rounds.push({ tag: done[1], wall: Number(done[2]), maxLag: Number(done[3]) })
      continue
    }
    const hb = /^HB (\d+) (\d+)$/.exec(s)
    if (hb && Number(hb[1]) > 1000) console.log(`    ⚠️ 心跳落后 ${hb[1]}ms`)
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(5000)
console.log(`\n>>> [${String(Date.now() - t0).padStart(6)}ms] 灌入 ${BG} 个后台进程占住进程表…`)
const bg = []
for (let i = 0; i < BG; i++) {
  bg.push(spawn(process.execPath, ['-e', 'setTimeout(()=>{},25000)'], { stdio: 'ignore' }))
}
await sleep(1000)
console.log(`    已起 ${bg.length} 个`)

await sleep(14000)

console.log('\n=== 判读 ===')
for (const r of rounds) {
  console.log(`  ${r.tag.padEnd(6)}: 全轮 ${r.wall}ms，最大心跳落后 ${r.maxLag}ms`)
}
if (rounds.length === 2) {
  const ratio = rounds[1].maxLag / Math.max(rounds[0].maxLag, 1)
  console.log(`\n心跳落后放大倍数: ${ratio.toFixed(1)}×`)
  console.log(ratio > 3
    ? '→ 进程压力确实显著放大 spawn 的主线程开销，与现场吻合。'
    : '→ 进程压力不是主因，需另找机制。')
}

for (const b of bg) b.kill()
child.kill()
process.exit(0)
