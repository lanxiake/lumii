/**
 * 实验室验证：**传自定义 env 会不会显著放大 spawn 的主线程开销**。
 *
 * 这是第 4 版实验。前三版都被否定：
 *   ① 并发 spawn 60 个（继承 env）        → 心跳落后 110ms
 *   ② 并发 execFile 300 / 1000 个          → 134ms / 93ms
 *   ③ 加 200 个背景进程制造进程压力         → 放大 1.0×
 *
 * 但它们**都没有模拟真实调用形态**：`git-cli.ts:191` 是
 *
 *   env: { ...gitEnvFor(opts.gitDir), ...(opts.env ?? {}) }
 *
 * 而 `gitEnvFor` 返回 `{ ...process.env, GIT_AUTHOR_NAME, ..., LC_ALL: 'C' }`
 * —— 即**每次 spawn 都构造一个完整的自定义环境块**（本机 process.env 有 96+ 个
 * 变量），传给 `CreateProcess`。Windows 上「传自定义环境块」远比「继承父环境」
 * 昂贵（要序列化并重建整个环境块，还要解析 PATH 找可执行文件）。
 *
 * 本脚本对比：继承 env vs 自定义 env（模拟 gitEnvFor），各并发 N 次。
 *
 *   node scripts/probe-spawn-env-cost.mjs [并发数]
 */
import { spawn } from 'node:child_process'

const N = Number(process.argv[2] ?? 150)

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

  // 模拟 gitEnvFor 的返回形态（本机 96 个变量 + git 的那几个）
  function fakeGitEnv() {
    return {
      ...process.env,
      GIT_AUTHOR_NAME: 'Mtbot',
      GIT_AUTHOR_EMAIL: 'vcs@mtbot.local',
      GIT_COMMITTER_NAME: 'Mtbot',
      GIT_COMMITTER_EMAIL: 'vcs@mtbot.local',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: 'C:/tmp/nonexistent-gitconfig',
      LC_ALL: 'C',
    }
  }

  function round(tag, useEnv) {
    const t0 = Date.now()
    let done = 0
    for (let i = 0; i < ${N}; i++) {
      const opts = useEnv ? { stdio: 'ignore', env: fakeGitEnv() } : { stdio: 'ignore' }
      const k = spawn(process.execPath, ['-e', 'setTimeout(()=>{},200)'], opts)
      k.on('exit', () => { if (++done === ${N}) process.stderr.write('DONE ' + tag + ' ' + (Date.now() - t0) + ' ' + maxLag + '\\n') })
    }
    process.stderr.write('START ' + tag + '\\n')
  }

  setTimeout(() => round('inherit', false), 2500)
  setTimeout(() => { maxLag = 0 }, 9000)
  setTimeout(() => round('custom-env', true), 10000)
`

const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['ignore', 'pipe', 'pipe'] })
const t0 = Date.now()
const rounds = []

child.stderr.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    const s = line.trim()
    if (!s) continue
    const st = /^START (.+)$/.exec(s)
    if (st) {
      console.log(`\n>>> [${String(Date.now() - t0).padStart(6)}ms] 轮次 ${st[1]}：并发 spawn ${N} 个`)
      continue
    }
    const dn = /^DONE (.+) (\d+) (\d+)$/.exec(s)
    if (dn) {
      console.log(`    全轮耗时 ${dn[2]}ms，该轮最大心跳落后 ${dn[3]}ms`)
      rounds.push({ tag: dn[1], wall: Number(dn[2]), maxLag: Number(dn[3]) })
      continue
    }
    const hb = /^HB (\d+) (\d+)$/.exec(s)
    if (hb && Number(hb[1]) > 1000) console.log(`    ⚠️ 心跳落后 ${hb[1]}ms`)
  }
})

setTimeout(() => {
  console.log('\n=== 判读 ===')
  for (const r of rounds) console.log(`  ${r.tag.padEnd(12)}: 全轮 ${r.wall}ms，最大心跳落后 ${r.maxLag}ms`)
  if (rounds.length === 2) {
    const ratio = rounds[1].maxLag / Math.max(rounds[0].maxLag, 1)
    console.log(`\n自定义 env 相对继承的放大倍数: ${ratio.toFixed(1)}×`)
    console.log(ratio > 3
      ? '→ 传自定义 env 确实显著放大 spawn 开销，与现场形态吻合。'
      : '→ 也不是主因。')
  }
  child.kill()
  process.exit(0)
}, 22000)
