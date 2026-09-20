/**
 * 实验室验证：**自己并发创建子进程时，主线程会停多久**。
 *
 * 假说（来自 13:44~14:17 那簇低覆盖率冻结）：冻结前 1~2 秒 `exec@native`
 * 从每桶 5~22 个样本激增到 **354 / 417**，随后主线程「离开 V8 视野」数秒。
 * 那段时间日志显示 git gc 跑了 76 秒、工作区快照 13 秒内触发 3 次 ——
 * 都在 spawn git 子进程。`child_process.spawn` 虽异步，但**创建过程
 * （uv_spawn → CreateProcess）是同步的**，跑在主线程上。
 *
 * ⚠️ 第一版把观测对象搞反了：心跳在被观测的子进程里，而 spawn 是父进程做的。
 * 这一版让**同一个有心跳的进程自己去 spawn**。
 *
 *   node scripts/probe-spawn-storm.mjs [并发数]
 */
import { spawn } from 'node:child_process'

const N = Number(process.argv[2] ?? 60)

const CHILD = `
  const { spawn } = require('node:child_process')
  let hb = Date.now()
  setInterval(() => { hb = Date.now() }, 100)
  setInterval(() => { try { process.stderr.write('HB ' + (Date.now() - hb) + '\\n') } catch {} }, 500)
  setTimeout(() => {
    const t0 = Date.now()
    const kids = []
    for (let i = 0; i < ${N}; i++) {
      kids.push(spawn(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { stdio: 'ignore' }))
    }
    process.stderr.write('SPAWNED ' + (Date.now() - t0) + 'ms\\n')
  }, 2500)
`

const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['ignore', 'pipe', 'pipe'] })
const t0 = Date.now()
let maxLag = 0

child.stderr.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    const hb = /^HB (\d+)$/.exec(line.trim())
    if (hb) {
      const lag = Number(hb[1])
      maxLag = Math.max(maxLag, lag)
      const flag = lag > 1000 ? '   ⚠️ 主线程停摆' : ''
      console.log(`[${String(Date.now() - t0).padStart(6)}ms] 心跳落后 ${String(lag).padStart(5)}ms${flag}`)
      continue
    }
    const sp = /^SPAWNED (\d+)ms$/.exec(line.trim())
    if (sp) console.log(`\n>>> 自己同步创建 ${N} 个子进程耗时 ${sp[1]}（这段就在主线程上）\n`)
  }
})

setTimeout(() => {
  console.log(`\n=== 判读 ===`)
  console.log(`最大心跳落后: ${maxLag}ms`)
  console.log(maxLag > 1500
    ? '→ 并发 spawn 确实显著阻塞主线程，与 git 风暴期间的形态吻合。'
    : '→ 并发 spawn 的开销不足以解释秒级冻结，需另找机制。')
  child.kill()
  process.exit(0)
}, 14000)
