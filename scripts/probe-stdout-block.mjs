/**
 * 实验室验证（第二版）：写 stdout 到"读端停止读取"的管道，会不会阻塞主线程。
 *
 * 第一版失败：父进程从一开始就不读 stdout，结果连子进程的 stderr 心跳都收不到 ——
 * 分不清是「子进程没起来」还是「阻塞得太彻底」。这一版用**同一子进程分两阶段**：
 *
 *   阶段 A（0~6s）  父进程正常读 stdout   → 基线
 *   阶段 B（6~20s） 父进程 pause() 不再读 → 管道填满，观察子进程心跳
 *
 * 若阶段 B 心跳开始落后到秒级 → 假说成立（同步写被读端拖住）。
 *
 *   node C:/tmp/probe-stdout-block.cjs
 */
import { spawn } from 'node:child_process'

const CHILD = `
  let hb = Date.now()
  let wrote = 0
  setInterval(() => { hb = Date.now() }, 200)
  setInterval(() => {
    try {
      process.stderr.write('HB ' + (Date.now() - hb) + ' ' + wrote + '\\n')
    } catch (e) { /* 忽略 */ }
  }, 1000)
  const chunk = 'x'.repeat(8192)
  setInterval(() => {
    for (let i = 0; i < 20; i++) { try { process.stdout.write(chunk); wrote++ } catch (e) {} }
  }, 5)
`

const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['ignore', 'pipe', 'pipe'] })
child.on('error', (e) => console.log('spawn 失败:', e.message))
child.on('exit', (c, s) => console.log(`\n[子进程退出 code=${c} signal=${s}]`))

let bytes = 0
let phase = 'A(读)'
child.stdout.on('data', (d) => { bytes += d.length })

const t0 = Date.now()
child.stderr.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    const m = /^HB (\d+) (\d+)$/.exec(line.trim())
    if (!m) continue
    const lag = Number(m[1])
    const flag = lag > 1500 ? '   ⚠️ 主线程停摆' : ''
    console.log(
      `[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s] ${phase}  ` +
        `心跳落后 ${String(lag).padStart(5)}ms  子进程已写 ${String(m[2]).padStart(7)} 块  ` +
        `父进程收到 ${(bytes / 1024).toFixed(0).padStart(6)}KB${flag}`,
    )
  }
})

setTimeout(() => {
  phase = 'B(不读)'
  child.stdout.pause()
  console.log('\n>>> 父进程停止读取 stdout（管道将填满）\n')
}, 6000)

setTimeout(() => {
  phase = 'C(恢复读)'
  child.stdout.resume()
  console.log('\n>>> 父进程恢复读取 stdout\n')
}, 14000)

setTimeout(() => {
  console.log('\n=== 判读 ===')
  console.log('阶段 A/B/C 三段对照：')
  console.log('  A 正常读 → 心跳稳定（但注意它并非 0ms：同步写本身占用主线程）')
  console.log('  B 停读   → 心跳源消失（主线程卡在同步写里，连 timer 回调都跑不了）')
  console.log('  C 恢复读 → 心跳应立刻回来 ⇒ 因果方向确认：是**读端**拖住写端')
  console.log('\n这类阻塞不产生 JS 栈 —— 正是 profile 里只看得到 (idle) 的成因。')
  child.kill()
  process.exit(0)
}, 24000)
