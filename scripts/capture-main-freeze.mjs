/**
 * 冻结现场捕获器 v2：盯住主进程的主线程冻结，自动把 CPU profile 抓下来。
 *
 * ## 为什么需要它
 *
 * 2026-09-19 查过一次导出期间的 96 秒异常：其中确认有一处主线程完全冻结
 * （应用日志里某行的**外层**落盘时间戳比**内层**生成时间戳晚 54 秒）。
 * 之后六次复现尝试都没再出现，六次 CPU profile 全部干净（无 >200ms 的 JS 空隙）
 * —— 抓不到现场就查不动。
 *
 * ## v1 为什么是瞎的（三个缺陷叠加，且全部静默）
 *
 * v1 用「日志**最后一行**的**内层**时间戳」当判据，实测**从未触发过一次**：
 *
 * 1. **日志路径在启动时算死**（`mtbot-<启动日>.log`）→ 跨日后读的是一个不再增长的
 *    旧文件。实测 09-19 那份定格在 23:59:57，而 09-20 的日志已经在写。
 * 2. **只看最后一行**，而那一行高频被 `[AgentRuntime:IPC] [command] received: mcp:status`
 *    这类**单时间戳**行占据（由 `[Main]` 直打，不经 file-logger 包装，没有内层时间戳）。
 *    实测 09-19 日志尾部 8192 字节 / 99 行里，含内层时间戳的行数是 **0**。
 * 3. 两处失败都是 `continue`，**不打任何警告** —— 看起来连上了、打印了启动横幅、
 *    然后永远沉默。**「装上了」被当成了「在工作」。**
 *
 * ## v2 的判据：主线程自己报告时间
 *
 * 向主进程注入一个心跳（`setInterval` 每 100ms 写一次 `Date.now()`），然后轮询
 * `Date.now() - __lumiiFreezeHb`。**心跳停摆 = 主线程不跑事件循环 = 冻结**，
 * 与日志格式、日志路径、是否有日志输出全部无关。
 *
 * ⚠️ 判据不能是「CDP 往返延迟」—— 实测（`scripts/probe-freeze-detect-via-cdp.mjs`）
 * 证明这条假设是错的：主线程忙等 5 秒期间，`Runtime.evaluate` 与 `Profiler.stop`
 * 都在 **1~4ms** 内返回。V8 用 interrupt 把命令插进主线程，Node 的 inspector
 * 跑在独立线程上，**命令不排主线程的队**。
 *
 * 由此得到两个可靠的信号，本脚本都用：
 *   - **JS 层冻结**：evaluate 及时返回，但心跳落后 → 主线程在跑 JS（死循环/大计算），
 *     V8 采样线程能采到栈（实测忙等期采到 1586 个样本，栈顶正是那行忙等循环）。
 *   - **原生层冻结**：evaluate **超时**（原生代码里没有 JS 检查点，interrupt 插不进去）
 *     → 采样线程可能只能采到 `(program)`/空栈 —— 这本身就是判据。
 *
 * ## 用法
 *
 *   # 1. 带 --inspect 启动（端口随意，下面传给它）
 *   cd apps/windows && node scripts/run-dev.cjs --inspect=5860
 *
 *   # 2. 挂上捕获器（常驻）
 *   node scripts/capture-main-freeze.mjs --port 5860
 *
 *   # 3. 等它自己报「捕获到冻结」；产物 <out>/freeze-*.cpuprofile + .json
 *
 * 参数：--threshold（默认 2000ms）--poll（默认 500ms）--roll（默认 90s）
 *       --out（默认 C:/tmp/freeze-captures）
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PORT = Number(arg('port', '5860'))
/** 心跳落后超过它就认定「主线程被冻住了」 */
const THRESHOLD_MS = Number(arg('threshold', '2000'))
/** 轮询间隔 */
const POLL_MS = Number(arg('poll', '500'))
/** 环缓冲重启间隔（毫秒）—— stop 不需要主线程，实测 4ms 返回 */
const ROLL_MS = Number(arg('roll', '90000'))
/** evaluate 超时：超过它就认定「原生层冻结」 */
const EVAL_TIMEOUT_MS = Number(arg('evalTimeout', '5000'))
const OUT = arg('out', 'C:/tmp/freeze-captures')
const LOG_DIR = arg('logdir', 'C:/Users/75791/.lumii/logs/app')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[freeze-capture ${new Date().toISOString().slice(11, 19)}]`, ...a)

// ── 辅助证据：日志（按天滚动 + 尾部倒扫，v1 的两个 bug 都在这里修掉）──────────
const INNER_RE =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[[A-Z]+\] \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/
const parseTs = (s) => Date.parse(s.replace(' ', 'T') + 'Z')

/**
 * 读当前日志尾部（**每次重新算日期**，不再是启动时算死）。
 * 从尾部**倒扫**找最近一条含内层时间戳的行 —— v1 只看最后一行，而末行高频是
 * 单时间戳的 IPC 心跳行。
 */
function logTail() {
  const file = path.join(LOG_DIR, `mtbot-${new Date().toISOString().slice(0, 10)}.log`)
  let fd
  try {
    const size = fs.statSync(file).size
    const len = Math.min(size, 65536)
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n').filter((l) => l.length > 10)
    let last = null
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = INNER_RE.exec(lines[i])
      if (m) {
        last = { outer: parseTs(m[1]), inner: parseTs(m[2]), line: lines[i].slice(0, 200) }
        break
      }
    }
    return {
      file,
      scanned: lines.length,
      withInner: last,
      tail: lines.slice(-5).map((l) => l.slice(0, 160)),
    }
  } catch (e) {
    return { file, error: e.message }
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

// ── 连 CDP ────────────────────────────────────────────────────────────────
async function findWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list.find((x) => x.webSocketDebuggerUrl)
      if (t) return t.webSocketDebuggerUrl
    } catch {}
    await sleep(1000)
  }
  throw new Error(`连不上 inspector :${PORT}（确认应用是用 --inspect=${PORT} 起的）`)
}

const wsUrl = await findWsUrl()
const ws = new WebSocket(wsUrl)
let msgId = 0
const pending = new Map()
const raw = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, { res, rej, sentAt: Date.now() })
    ws.send(JSON.stringify({ id, method, params }))
  })
/** 带超时的 send：超时返回 { timedOut: true }，不抛错、不挂住主循环 */
const send = (method, params = {}, timeoutMs = EVAL_TIMEOUT_MS) =>
  Promise.race([
    raw(method, params).catch((e) => ({ err: e.message })),
    sleep(timeoutMs).then(() => ({ timedOut: true })),
  ])
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    const rtt = Date.now() - p.sentAt
    m.error ? p.rej(Object.assign(new Error(JSON.stringify(m.error)), { rtt })) : p.res(Object.assign(m.result, { rtt }))
  }
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
ws.addEventListener('close', () => {
  log('⚠️ CDP 连接断开（应用退出或重启了？）—— 脚本退出，需要重新挂')
  process.exit(1)
})

await raw('Profiler.enable')
await raw('Profiler.setSamplingInterval', { interval: 200 })

// ── 注入心跳 ──────────────────────────────────────────────────────────────
const HB = '__lumiiFreezeHb'
const INJECT = `(() => {
  if (typeof globalThis.${HB} !== 'number' || globalThis.${HB} === 0) {
    globalThis.${HB} = Date.now();
    globalThis.${HB}Timer = setInterval(() => { globalThis.${HB} = Date.now(); }, 100);
  }
  return Date.now() - globalThis.${HB};
})()`

let anchor = 0 // profile.startTime 对应的 wall clock（start 前后各取一次取中点）
let profileStarted = false

async function startProfile() {
  const tBefore = Date.now()
  await raw('Profiler.start')
  anchor = (tBefore + Date.now()) / 2
  profileStarted = true
}

const first = await send('Runtime.evaluate', { expression: INJECT, returnByValue: true })
if (first.timedOut) {
  log('❌ 注入心跳超时 —— 主线程当前就卡着？或 inspector 不可用')
} else if (first.err) {
  log(`❌ 注入心跳失败：${first.err}`)
  process.exit(1)
} else {
  log(`✅ 心跳已注入（当前落后 ${first.result?.value}ms）`)
}
await startProfile()

log(`判据：${HB} 落后 > ${THRESHOLD_MS}ms（轮询 ${POLL_MS}ms）；日志辅助证据 ${LOG_DIR}`)
log(`产物目录 ${OUT}`)
fs.mkdirSync(OUT, { recursive: true })

// ── 环缓冲：定期 stop+start 丢掉旧样本。实测 stop 不需要主线程（4ms 返回），
//    但**冻结期间绝不能 roll** —— 那会把冻结期的样本切掉。所以 roll 前先看心跳。──
let busy = false
async function roll() {
  if (busy || !profileStarted) return
  const hb = await send('Runtime.evaluate', { expression: `Date.now() - globalThis.${HB}`, returnByValue: true }, 2000)
  if (hb.timedOut || (hb.result?.value ?? 0) > 1000) return // 有冻结迹象，别切
  try {
    await raw('Profiler.stop')
    await startProfile()
  } catch (e) {
    log('roll 失败:', e.message)
  }
}
let rollTimer = null
const scheduleRoll = () => {
  if (rollTimer) clearInterval(rollTimer)
  rollTimer = setInterval(() => void roll(), ROLL_MS)
}
scheduleRoll()

// ── 冻结期样本的自动判读 ────────────────────────────────────────────────────
/**
 * 从 profile 里切出 [fromWall, toWall] 窗口内的样本，按**完整调用栈**聚合。
 * 只输出栈顶是不够的：实测栈顶可能是 `listOnTimeout` 这类无信息量的帧，
 * 真正卡住的那一帧在它下面。
 */
function hotspots(profile, fromWall, toWall) {
  const toWallOf = (us) => anchor + (us - profile.startTime) / 1000
  let cum = profile.startTime
  const walls = profile.samples.map((_, i) => (cum += profile.timeDeltas[i]))
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const stackPath = (id) => {
    const out = []
    let c = byId.get(id)
    for (let guard = 0; c && guard < 40; guard++) {
      const cf = c.callFrame
      out.unshift(`${cf.functionName || '(anon)'}@${(cf.url || 'native').replace(/^file:\/\/\//, '')}:${cf.lineNumber}`)
      c = byId.get(c.parent)
    }
    return out.join(' ← ')
  }
  const counts = new Map()
  let inWindow = 0
  let minW = Infinity
  let maxW = -Infinity
  profile.samples.forEach((s, i) => {
    const w = toWallOf(walls[i])
    minW = Math.min(minW, w)
    maxW = Math.max(maxW, w)
    if (w < fromWall || w > toWall) return
    inWindow++
    const key = stackPath(s)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  })
  return {
    total: profile.samples.length,
    inWindow,
    spanMs: Math.round(maxW - minW),
    windowMs: Math.round(toWall - fromWall),
    top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  }
}

async function capture(kind, lagMs) {
  busy = true
  clearInterval(rollTimer)
  const detectedAt = new Date()
  const freezeFrom = lagMs ? new Date(Date.now() - lagMs) : null
  log(`⚠️ 捕获到冻结 [${kind}]：心跳落后 ${lagMs ? lagMs + 'ms' : '(evaluate 超时，原生层冻结)'}`)

  let profile = null
  const stopped = await send('Profiler.stop', {}, 60000)
  if (stopped.timedOut) log('Profiler.stop 超时（60s）—— profile 没拿到')
  else if (stopped.err) log(`Profiler.stop 失败: ${stopped.err}`)
  else profile = stopped.profile
  profileStarted = false

  const stamp = detectedAt.toISOString().replace(/[: .]/g, '-')
  const base = path.join(OUT, `freeze-${stamp}`)
  const meta = {
    kind,
    heartbeatLagMs: lagMs ?? null,
    detectedAt: detectedAt.toISOString(),
    frozenFrom: freezeFrom?.toISOString() ?? null,
    log: logTail(),
    note:
      'kind=js → 主线程跑 JS（栈可采）；kind=native → evaluate 超时，原生代码阻塞，栈可能为空。' +
      'heartbeatLagMs = 注入的 setInterval 心跳落后当前时刻的毫秒数。',
  }
  if (profile) {
    fs.writeFileSync(`${base}.cpuprofile`, JSON.stringify(profile))
    // 窗口终点用**检测时刻**，不是分析时刻 —— 后者会把 stop 往返期间也算进去
    const h = hotspots(profile, freezeFrom ? freezeFrom.getTime() : detectedAt.getTime() - 60000, detectedAt.getTime())
    meta.profile = { total: h.total, inWindow: h.inWindow, spanMs: h.spanMs, windowMs: h.windowMs, top: h.top }
    log(`已保存 ${base}.cpuprofile（冻结窗口 ${h.inWindow}/${h.total} 样本，窗口 ${h.windowMs}ms，profile 覆盖 ${h.spanMs}ms）`)
    log('冻结窗口内的调用栈（样本数 栈路径，← 左边是被调用者）：')
    for (const [k, v] of h.top) log(`   ${v}  ${k}`)
  }
  fs.writeFileSync(`${base}.json`, JSON.stringify(meta, null, 2))

  // 继续盯（可能还有第二次）
  busy = false
  await startProfile()
  scheduleRoll()
  // 复位心跳基线，避免立刻二次触发
  await send('Runtime.evaluate', { expression: `globalThis.${HB} = Date.now()`, returnByValue: true }, 3000)
}

// ── 主循环 ────────────────────────────────────────────────────────────────
for (;;) {
  await sleep(POLL_MS)
  if (busy) continue
  const r = await send(
    'Runtime.evaluate',
    { expression: `Date.now() - globalThis.${HB}`, returnByValue: true },
    EVAL_TIMEOUT_MS,
  )
  if (r.timedOut) {
    await capture('native', null)
    continue
  }
  if (r.err) {
    log(`evaluate 报错（心跳可能被清了，下轮重注入）: ${r.err}`)
    await send('Runtime.evaluate', { expression: INJECT, returnByValue: true }, EVAL_TIMEOUT_MS)
    continue
  }
  const lag = r.result?.value
  if (typeof lag !== 'number') continue
  if (lag > THRESHOLD_MS) await capture('js', lag)
  if (process.env.FREEZE_CAPTURE_VERBOSE) log(`lag=${lag}ms`)
}
