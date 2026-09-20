/**
 * 实验室验证（第二版）：CDP 命令在主线程冻结期间到底发生什么。
 *
 * 第一版的缺陷：只测了「往返时间」和「是否超时」，**没看返回值**，也没验证
 * evaluate 是否真的执行了。而且 profile 的时间锚点用 busyStart 硬凑，是错的。
 *
 * 这一版：
 *   - 子进程维护 __hb（由主线程 setInterval 更新）→ evaluate 读它，能分辨主线程死活
 *   - evaluate 带副作用（__probe 自增）→ 事后可查它是否真被执行
 *   - Profiler.start 前后各取一次 Date.now() 取中点，作为 profile 时间轴的锚
 *   - 打印子进程 stderr
 *
 *   node scripts/probe-freeze-detect-via-cdp.mjs
 */
import { spawn } from 'node:child_process'

const PORT = 5873
const BUSY_MS = 5000
const BUSY_AT_MS = 2000

const code = `
  globalThis.__hb = Date.now()
  globalThis.__probe = 0
  setInterval(() => { globalThis.__hb = Date.now() }, 100)
  setTimeout(() => {
    console.log('BUSY-START ' + Date.now())
    const t = Date.now()
    while (Date.now() - t < ${BUSY_MS}) {}
    console.log('BUSY-END ' + Date.now())
  }, ${BUSY_AT_MS})
  setInterval(() => {}, 1000)
`
const child = spawn(process.execPath, [`--inspect=${PORT}`, '-e', code], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
const marks = {}
child.stdout.on('data', (d) => {
  for (const l of d.toString().split('\n')) {
    if (l.startsWith('BUSY-START')) marks.busyStart = Number(l.split(' ')[1])
    if (l.startsWith('BUSY-END')) marks.busyEnd = Number(l.split(' ')[1])
  }
})
child.stderr.on('data', (d) => process.stderr.write('[child-err] ' + d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(
        (x) => x.webSocketDebuggerUrl,
      )
      if (t) return t.webSocketDebuggerUrl
    } catch {}
    await sleep(100)
  }
  throw new Error('连不上 inspector')
}

const ws = new WebSocket(await findWs())
let id = 0
const pending = new Map()
const raw = (method, params = {}) =>
  new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej, sentAt: Date.now() })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
/** 带超时的 send —— 超时返回 { timedOut: true }，不抛错 */
const send = (method, params = {}, timeoutMs = 120000) =>
  Promise.race([
    raw(method, params).catch((e) => ({ err: e.message, rtt: e.rtt })),
    sleep(timeoutMs).then(() => ({ timedOut: true })),
  ])
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    const rtt = Date.now() - p.sentAt
    m.error ? p.rej(Object.assign(new Error(JSON.stringify(m.error)), { rtt })) : p.res({ ...m.result, rtt })
  }
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

/** 发一条 evaluate，返回 { ok, timedOut, value, err, rtt } */
async function ev(expr, timeoutMs) {
  try {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, timeoutMs)
    if (r.timedOut) return { timedOut: true }
    return { ok: true, value: r.result?.value, desc: r.result?.description, rtt: r.rtt }
  } catch (e) {
    return { err: e.message, rtt: e.rtt }
  }
}

await raw('Profiler.enable')
await raw('Profiler.setSamplingInterval', { interval: 200 })

console.log(`[基线] ${JSON.stringify(await ev('1 + 1', 3000))}`)

// 主线程心跳：空闲时应接近 0
console.log(`[基线] 空闲期 hb 落后 = ${(await ev('Date.now() - globalThis.__hb', 3000)).value}ms`)

// ── 锚点：start 前后各取一次 Date.now() ──
const tBefore = Date.now()
await raw('Profiler.start')
const tAfter = Date.now()
const anchor = (tBefore + tAfter) / 2

while (!marks.busyStart) await sleep(50)
console.log(`\n主线程进入忙等（${marks.busyStart}），1 秒后发探测…`)
await sleep(1000)
console.log(`此刻忙等还剩约 ${BUSY_MS - (Date.now() - marks.busyStart)}ms\n`)

// ── Q1：冻结期间 evaluate 读主线程心跳变量 ──
const q1 = await ev('Date.now() - globalThis.__hb', 3000)
console.log(`Q1 evaluate('Date.now() - __hb') 冻结期: ${JSON.stringify(q1)}`)

// ── Q2：带副作用 ──
const q2 = await ev('++globalThis.__probe', 3000)
console.log(`Q2 evaluate('++__probe') 冻结期: ${JSON.stringify(q2)}`)

// ── Q3：Profiler.stop 是否挂起 ──
const t2 = Date.now()
try {
  const r = await raw('Profiler.stop')
  console.log(`Q3 Profiler.stop 往返 = ${Date.now() - t2}ms，样本 ${r.profile.samples.length}`)
  var profile = r.profile
} catch (e) {
  console.log(`Q3 Profiler.stop 失败: ${e.message}（往返 ${Date.now() - t2}ms）`)
}

// ── Q4：忙等结束后再看 evaluate 与 __probe ──
while (!marks.busyEnd) await sleep(50)
console.log(`\n忙等结束（${marks.busyEnd}，实际 ${marks.busyEnd - marks.busyStart}ms）`)
console.log(`Q4 evaluate('++__probe') 恢复后: ${JSON.stringify(await ev('++globalThis.__probe', 3000))}`)

// ── Q5：profile 时间轴是否覆盖忙等期 ──
if (profile) {
  const toWall = (us) => anchor + (us - profile.startTime) / 1000
  let cum = profile.startTime
  const wall = profile.samples.map((_, i) => (cum += profile.timeDeltas[i]))
  const inBusy = wall.filter((w) => toWall(w) >= marks.busyStart && toWall(w) <= marks.busyEnd)
  console.log(
    `Q5 总样本 ${profile.samples.length}（覆盖 ${Math.round((toWall(wall[wall.length - 1]) - toWall(wall[0])))}ms），` +
      `落在忙等窗口内 ${inBusy.length}`,
  )
  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]))
  const counts = new Map()
  profile.samples.forEach((s, i) => {
    const w = toWall(wall[i])
    if (w < marks.busyStart || w > marks.busyEnd) return
    const cf = nodeById.get(s)?.callFrame
    const key = cf ? `${cf.functionName || '(anon)'} @ ${cf.url || '(native)'}:${cf.lineNumber}` : '(?)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  })
  console.log('Q5 忙等期样本栈顶（前 5）:')
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`   ${v}  ${k}`)
}

child.kill()
process.exit(0)
