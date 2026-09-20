/**
 * 实验室验证（第二版）：**并发 execFile 会不会阻塞主线程** —— 用 `execFile`
 * 而不是 `spawn`，并放大到真实量级。
 *
 * 背景：§6.8 那类"离开 V8 视野"的冻结，时间轴前兆是 `exec@native` 激增
 * （某次 60 秒窗口里 7009 个样本 ≈ 1.4 秒）。第一版实验用 `spawn` 并发 60 个，
 * 最大心跳落后只有 110ms —— 但真实代码用的是 `execFileAsync`（`execFile` 的
 * promise 版），它比 `spawn` 多一层：解析 shell、收集 stdout/stderr、进程回收。
 *
 * 本脚本让**有心跳的那个进程自己**并发 execFile N 次真实命令，观察心跳。
 *
 *   node scripts/probe-exec-storm.mjs [并发数] [命令]
 */
import { spawn } from 'node:child_process'

const N = Number(process.argv[2] ?? 300)
const CMD = process.argv[3] ?? 'git'
const ARGS = CMD === 'git' ? ['--version'] : ['-e', 'setTimeout(()=>{},20)']

const CHILD = `
  const { execFile } = require('node:child_process')
  let hb = Date.now()
  setInterval(() => { hb = Date.now() }, 100)
  setInterval(() => { try { process.stderr.write('HB ' + (Date.now() - hb) + '\\n') } catch {} }, 400)
  setTimeout(() => {
    const t0 = Date.now()
    let done = 0
    let issued = 0
    for (let i = 0; i < ${N}; i++) {
      try {
        execFile(${JSON.stringify(CMD)}, ${JSON.stringify(ARGS)}, { windowsHide: true }, () => {
          if (++done === ${N}) process.stderr.write('ALLDONE ' + (Date.now() - t0) + '\\n')
        })
        issued++
      } catch (e) {
        process.stderr.write('ERR ' + e.message + '\\n')
      }
    }
    process.stderr.write('ISSUED ' + issued + ' in ' + (Date.now() - t0) + 'ms\\n')
  }, 2500)
`

const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['ignore', 'pipe', 'pipe'] })
const t0 = Date.now()
let maxLag = 0
let maxAt = 0

child.stderr.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    const s = line.trim()
    const hb = /^HB (\d+)$/.exec(s)
    if (hb) {
      const lag = Number(hb[1])
      if (lag > maxLag) { maxLag = lag; maxAt = Date.now() - t0 }
      if (lag > 800) console.log(`[${String(Date.now() - t0).padStart(6)}ms] 心跳落后 ${String(lag).padStart(5)}ms  ⚠️`)
      continue
    }
    if (/^(ISSUED|ALLDONE|ERR)/.test(s)) console.log(`\n>>> ${s}\n`)
  }
})

setTimeout(() => {
  console.log(`\n=== 判读 ===`)
  console.log(`并发 ${N} 次 execFile(${CMD}) —— 最大心跳落后: ${maxLag}ms（出现在 ${maxAt}ms）`)
  console.log(maxLag > 1500
    ? '→ 并发 execFile 确实显著阻塞主线程，与现场形态吻合。'
    : '→ 仍未复现秒级阻塞；说明 execFile 的开销也不是主因。')
  child.kill()
  process.exit(0)
}, 20000)
