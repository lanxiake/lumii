/**
 * 冻结现场捕获器 v3：盯住主进程的主线程冻结，自动把 CPU profile 抓下来。
 *
 * ## 为什么需要它
 *
 * 2026-09-19 查过一次导出期间的 96 秒异常：其中确认有一处主线程完全冻结
 * （应用日志里某行的**外层**落盘时间戳比**内层**生成时间戳晚 54 秒）。
 * 之后六次复现尝试都没再出现，六次 CPU profile 全部干净 —— 抓不到现场就查不动。
 *
 * ## v1 为什么是瞎的（三个缺陷叠加，且全部静默）
 *
 * v1 用「日志**最后一行**的**内层**时间戳」当判据，**一次都没触发过**：
 * ① 日志路径在启动时算死 → 跨日后读一个不再增长的旧文件；
 * ② 只看最后一行，而它高频被 `[AgentRuntime:IPC] ... mcp:status` 这类**单时间戳**行占据
 *   （实测 09-19 日志尾部 8192 字节 / 99 行里，含内层时间戳的行数是 **0**）；
 * ③ 两处失败都是 `continue`，**不打任何警告**。
 * **「装上了」被当成了「在工作」。**
 *
 * ## v2/v3 的判据：主线程自己报告时间
 *
 * 向主进程注入心跳（`setInterval` 每 100ms 写 `Date.now()`），轮询
 * `Date.now() - __lumiiFreezeHb`。**心跳停摆 = 不跑事件循环 = 冻结**，
 * 与日志格式、路径、是否有输出全部无关。
 *
 * ⚠️ 判据不能是「CDP 往返延迟」—— 实测（`scripts/probe-freeze-detect-via-cdp.mjs`）
 * 证明该假设是错的：主线程忙等 5 秒期间，`Runtime.evaluate` 与 `Profiler.stop`
 * 都在 **1~4ms** 内返回。V8 用 interrupt 把命令插进主线程，Node 的 inspector
 * 跑在独立线程上，**命令不排主线程的队**。
 *
 * 两个可靠信号，都用：
 *   - **JS 层冻结**：evaluate 及时返回但心跳落后 → 主线程在跑 JS，
 *     采样线程能采到栈（实测忙等期采到 1586 个样本，栈顶正是那行循环）。
 *   - **原生层冻结**：evaluate **超时**（原生代码里没有 JS 检查点）→ 栈可能为空。
 *
 * ## v3 相对 v2 的两处修正（都是 09-20 现场教的）
 *
 * ① **先落盘再取 profile**。v2 把 meta 写在 `Profiler.stop` 之后 —— 而 native 冻结时
 *    stop 可能**永远不返回**（10:06 那次主线程卡 ≥16s，随后进程被重启），
 *    代码根本走不到写盘那一步，什么都没留下。
 *    现在 `.json` 在等 stop **之前**就写：**「有 .json 无 .cpuprofile」本身就是证据**。
 * ② **CDP 断开后自动重连**。dev 环境应用重启是常态，v2 一断就退出，
 *    于是应用重启会顺手把捕获器带走（10:06 就是这样）。现在断线后等应用回来、
 *    重新注入心跳、继续盯。
 *
 * ## 用法
 *
 *   # 1. 带 --inspect 启动（端口随意，下面传给它）
 *   node apps/windows/scripts/run-dev.cjs --inspect=5860 --sourcemap
 *
 *   # 2. 挂上捕获器（常驻，会自动重连）
 *   node scripts/capture-main-freeze.mjs --port 5860
 *
 *   # 3. 等它报「捕获到冻结」；产物 <out>/freeze-*.cpuprofile + .json
 *
 * 参数：--threshold（默认 2000ms）--poll（默认 500ms）--roll（默认 90s）
 *       --out（默认 C:/tmp/freeze-captures）--reconnect（默认 5000ms）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

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
/** CDP 断开后多久重试一次 */
const RECONNECT_MS = Number(arg('reconnect', '5000'))
const OUT = arg('out', 'C:/tmp/freeze-captures')
const LOG_DIR = arg('logdir', 'C:/Users/75791/.lumii/logs/app')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[freeze-capture ${new Date().toISOString().slice(11, 19)}]`, ...a)

// ── 辅助证据：日志（按天滚动 + 尾部倒扫）────────────────────────────────────
const INNER_RE =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[[A-Z]+\] \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/
const parseTs = (s) => Date.parse(s.replace(' ', 'T') + 'Z')

/**
 * 读当前日志尾部（**每次重新算日期**）。从尾部**倒扫**找最近一条含内层时间戳的行。
 * 另附最后 5 行原文 —— 主线程冻结时日志会**断档**，断档本身就是独立证据
 * （2026-09-20 10:06：末行 10:06:11，心跳日志消失，直到 10:06:29 新进程启动）。
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
    return { file, scanned: lines.length, withInner: last, tail: lines.slice(-5).map((l) => l.slice(0, 160)) }
  } catch (e) {
    return { file, error: e.message }
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

// ── 会话状态（每次重连都重建）─────────────────────────────────────────────
let ws = null
let pending = new Map()
let msgId = 0
let closed = false
let anchor = 0
let profileStarted = false
let rollTimer = null

const raw = (method, params = {}) =>
  new Promise((res, rej) => {
    if (!ws || closed) {
      rej(new Error('CDP 未连接'))
      return
    }
    const id = ++msgId
    pending.set(id, { res, rej, sentAt: Date.now() })
    ws.send(JSON.stringify({ id, method, params }))
  })

/** 带超时的 send：超时返回 { timedOut: true }，不抛错、不挂住调用方 */
const send = (method, params = {}, timeoutMs = EVAL_TIMEOUT_MS) =>
  Promise.race([
    raw(method, params)
      .then((r) => Object.assign(r, { rtt: 0 }))
      .catch((e) => ({ err: e.message })),
    sleep(timeoutMs).then(() => ({ timedOut: true })),
  ])

async function findWsUrl() {
  for (let i = 0; i < 120; i++) {
    if (closed) throw new Error('会话已关闭')
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list.find((x) => x.webSocketDebuggerUrl)
      if (t) return t.webSocketDebuggerUrl
    } catch {}
    await sleep(1000)
  }
  throw new Error(`连不上 inspector :${PORT}`)
}

/**
 * 双心跳：`setInterval` + 递归 `setTimeout`，两者机制不同（前者由 libuv 的
 * timer 列表驱动，后者每次触发后重新入队）。
 *
 * ⚠️ 为什么要两个（2026-09-20 现场教的）：单心跳会**误报**。10:25:20 那次报
 * 心跳落后 2610ms，但应用自己的 `mcp:status`（每 5 秒一条主线程定时 IPC）
 * 在冻结窗口内**正常写了 18.661 那条** —— 那一刻主线程是活的。
 * 也就是说单靠一个 timer 的落后，区分不了「主线程真卡住」和「这个 timer 被推迟」。
 * 两个独立机制**同时**停摆，才认定为冻结。
 */
const HB = '__lumiiFreezeHb' // setInterval 心跳
const HB2 = '__lumiiFreezeHbB' // 递归 setTimeout 心跳
const INJECT = `(() => {
  if (typeof globalThis.${HB} !== 'number' || globalThis.${HB} === 0) {
    globalThis.${HB} = Date.now();
    globalThis.${HB}Timer = setInterval(() => { globalThis.${HB} = Date.now(); }, 100);
  }
  if (typeof globalThis.${HB2} !== 'number' || globalThis.${HB2} === 0) {
    globalThis.${HB2} = Date.now();
    const tick = () => { globalThis.${HB2} = Date.now(); globalThis.${HB2}Timer = setTimeout(tick, 100); };
    globalThis.${HB2}Timer = setTimeout(tick, 100);
  }
  return { a: Date.now() - globalThis.${HB}, b: Date.now() - globalThis.${HB2} };
})()`

/** 读两个心跳的落后值 */
const READ_HB = `({ a: Date.now() - globalThis.${HB}, b: Date.now() - globalThis.${HB2} })`

async function startProfile() {
  if (closed) return
  const tBefore = Date.now()
  await raw('Profiler.start').catch(() => {})
  anchor = (tBefore + Date.now()) / 2
  profileStarted = true
}

let busy = false
async function roll() {
  if (busy || closed || !profileStarted) return
  const hb = await send('Runtime.evaluate', { expression: READ_HB, returnByValue: true }, 2000)
  const worst = Math.max(hb.result?.value?.a ?? 0, hb.result?.value?.b ?? 0)
  if (hb.timedOut || hb.err || worst > 1000) return // 有冻结迹象，别切
  try {
    await raw('Profiler.stop')
    await startProfile()
  } catch {
    /* 断连时忽略 */
  }
}
const scheduleRoll = () => {
  if (rollTimer) clearInterval(rollTimer)
  rollTimer = setInterval(() => void roll(), ROLL_MS)
}

// ── 冻结期样本的自动判读 ────────────────────────────────────────────────────
/**
 * 按**完整调用栈**聚合窗口内的样本。只输出栈顶是不够的：
 * 实测栈顶可能是 `all@native` / `listOnTimeout` 这类无信息量的帧（甚至无 parent）。
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

/**
 * 采样**系统进程表** —— 冻结发生时，捕获器是独立进程、不受主线程阻塞影响，
 * 可以替被冻住的应用看一眼"此刻系统上有什么"。
 *
 * 动机：§6.8 那类「离开 V8 视野」的现场，profile 里只有裸 native 帧
 * （`exec@native` 100% 覆盖数秒），看不出是谁在起子进程。进程表能直接回答
 * 「是不是子进程风暴」——如果 `git.exe` 有几十上百个，方向就明确了。
 *
 * ⚠️ 这里的 `execSync` 会阻塞**捕获器自己**（几百毫秒），但它是独立进程，
 * 不影响被测应用。
 */
function sampleProcesses() {
  try {
    const out = execSync('tasklist /FO CSV /NH', {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    const counts = new Map()
    let total = 0
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const name = /^"([^"]+)"/.exec(line)?.[1]
      if (!name) continue
      total++
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    return { total, top }
  } catch (e) {
    return { error: e.message }
  }
}

/**
 * 跟踪**整机 CPU 使用率** —— 用来区分两种截然不同的现象。
 *
 * 2026-09-20 把 91 次捕获按 `evaluate` 是否超时分成两类后，发现两个反直觉的点：
 *   - A 类（evaluate **成功**）里有 8 次采样覆盖率只有 0.0~0.7% —— 主线程明明
 *     能响应，采样却几乎为空；
 *   - B 类（evaluate **超时**）里有覆盖率 28% 的 —— 有样本，却连着 5 秒不回话。
 *
 * V8 的采样线程是**独立线程**，系统 CPU 饱和时它自己就会被饿死 —— 于是
 * 「覆盖率低」既可能是主线程卡住，也可能只是采样线程抢不到 CPU。
 * 记录整机 CPU 使用率才能把这二者分开。
 *
 * Windows 上 `os.loadavg()` 恒为 0，所以用 `os.cpus()` 的累积 times 做差分。
 */
let lastCpuTimes = os.cpus().map((c) => ({ ...c.times }))
let cpuPct = 0

function updateCpu() {
  const now = os.cpus()
  let idle = 0
  let total = 0
  now.forEach((c, i) => {
    const p = lastCpuTimes[i]
    if (!p) return
    const dUser = c.times.user - p.user
    const dNice = c.times.nice - p.nice
    const dSys = c.times.sys - p.sys
    const dIdle = c.times.idle - p.idle
    const dIrq = c.times.irq - p.irq
    idle += dIdle
    total += dUser + dNice + dSys + dIdle + dIrq
  })
  if (total > 0) cpuPct = Math.round((1 - idle / total) * 100)
  lastCpuTimes = now.map((c) => ({ ...c.times }))
}

async function capture(kind, lagA, lagB) {
  busy = true
  if (rollTimer) clearInterval(rollTimer)
  const detectedAt = new Date()
  const freezeFrom = lagA ? new Date(Date.now() - lagA) : null
  log(
    `⚠️ 捕获到冻结 [${kind}]：` +
      (lagA != null ? `双心跳均停摆 setInterval=${lagA}ms setTimeout=${lagB}ms` : '(evaluate 超时，原生层冻结)'),
  )

  const stamp = detectedAt.toISOString().replace(/[: .]/g, '-')
  const base = path.join(OUT, `freeze-${stamp}`)
  // 趁冻结还在持续，先采一份系统进程表（这是独立进程做的，不受主线程影响）
  const processes = sampleProcesses()
  if (processes.top) {
    const notable = processes.top.filter(([n]) => /git|node|electron|cmd|sh/i.test(n))
    log(`冻结时刻系统进程 ${processes.total} 个；相关: ${notable.map(([n, c]) => `${n}×${c}`).join(' ')}`)
  }
  const meta = {
    kind,
    heartbeatLagMs: lagA ?? null,
    heartbeatLagMsB: lagB ?? null,
    detectedAt: detectedAt.toISOString(),
    frozenFrom: freezeFrom?.toISOString() ?? null,
    log: logTail(),
    /** 整机 CPU 使用率（采样时的瞬时值）。用于区分「主线程卡」与「采样线程被饿死」 */
    cpuPct,
    processes,
    profile: null,
    note:
      'kind=js → 双心跳都停摆；kind=native → evaluate 超时（原生代码里没有检查点）。' +
      'heartbeatLagMs/-B = 两个独立心跳（setInterval / 递归 setTimeout）各自落后当前时刻的毫秒数；' +
      '**两者同时超过阈值才判冻结**（2026-09-20：单心跳曾误报，同窗口内应用的 mcp:status 定时 IPC 仍在正常写）。' +
      '⚠️ 本文件在等 Profiler.stop **之前**就落盘了 —— native 冻结时 stop 可能永远不返回' +
      '（2026-09-20 10:06：主线程卡 ≥16s，随后进程被重启，什么都没留下）。' +
      '所以「有 .json 无 .cpuprofile」本身就是证据。' +
      '另外看 log.tail —— 主线程冻结时日志会**断档**，断档起点即冻结起点。',
  }
  // ★ 先落盘现场：v2 的教训 —— 等到 stop 之后再写，长冻结什么都留不下
  fs.writeFileSync(`${base}.json`, JSON.stringify(meta, null, 2))
  log(`现场记录已落盘 ${path.basename(base)}.json（profile 待取）`)

  // 超时给足：若主线程会恢复，stop 会在恢复后返回，且**包含冻结期的样本**
  const stopped = await send('Profiler.stop', {}, 120000)
  if (stopped.timedOut) log('Profiler.stop 超时（120s）—— profile 没拿到，但 .json 已在')
  else if (stopped.err) log(`Profiler.stop 失败（${stopped.err}）—— .json 已在`)
  else meta.profile = stopped.profile ?? null
  profileStarted = false

  const profile = meta.profile
  if (profile) {
    fs.writeFileSync(`${base}.cpuprofile`, JSON.stringify(profile))
    // 窗口终点用**检测时刻**，不是分析时刻 —— 后者会把 stop 往返期间也算进去
    const h = hotspots(profile, freezeFrom ? freezeFrom.getTime() : detectedAt.getTime() - 60000, detectedAt.getTime())
    // 采样间隔 200µs → 窗口内样本数 × 0.2ms ≈ V8 实际被观测到的时长。
    // 占比过低说明主线程那段时间**不在 V8 里**（native 阻塞），此时栈天然看不到。
    const coverage = (h.inWindow * 0.2) / Math.max(h.windowMs, 1)
    meta.profile = { total: h.total, inWindow: h.inWindow, spanMs: h.spanMs, windowMs: h.windowMs, coverage, top: h.top }
    log(`已保存 ${path.basename(base)}.cpuprofile（冻结窗口 ${h.inWindow}/${h.total} 样本，窗口 ${h.windowMs}ms，profile 覆盖 ${h.spanMs}ms）`)
    if (coverage < 0.15) {
      log(
        `⚠️ 窗口内采样覆盖率仅 ${(coverage * 100).toFixed(0)}% —— 主线程**不在执行 JS**，` +
          '阻塞在 native 层（SQLite / 文件 / 子进程 / 同步 API）。这种形态下栈看不到东西，' +
          '要去看 .json 里 log.tail 的**断档**与断档前后的日志。' +
          '（2026-09-20 修正：09-19 曾把"profile 干净"读成"没复现"，其实那正是 native 阻塞的特征。）',
      )
    }
    log('冻结窗口内的调用栈（样本数 栈路径，← 左边是被调用者）：')
    for (const [k, v] of h.top) log(`   ${v}  ${k}`)
  }
  fs.writeFileSync(`${base}.json`, JSON.stringify(meta, null, 2))

  busy = false
  if (closed) return
  await startProfile()
  scheduleRoll()
  // 重启两个心跳：停掉的 timer 会让 lag 一直增长，造成连环误报
  await send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        try { clearInterval(globalThis.${HB}Timer) } catch {}
        try { clearTimeout(globalThis.${HB2}Timer) } catch {}
        globalThis.${HB} = 0; globalThis.${HB2} = 0;
        return true;
      })()`,
      returnByValue: true,
    },
    3000,
  )
  await send('Runtime.evaluate', { expression: INJECT, returnByValue: true }, 3000)
}

// ── 一次会话：连上 → 注入 → 主循环（直到断开）──────────────────────────────
async function session() {
  // ⚠️ 必须在 findWsUrl() **之前**清标志：外层循环在每轮结束时会把它设回 true，
  // 而 findWsUrl 首行就是 `if (closed) throw` —— 顺序反了会让重连第一次循环就失败、
  // 无限打「第 N 次连接… / 会话已关闭」（2026-09-20 实测踩到）。
  closed = false
  const wsUrl = await findWsUrl()
  pending = new Map()
  ws = new WebSocket(wsUrl)

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    }
  })
  ws.addEventListener('close', () => {
    closed = true
    // 让所有在途请求立刻失败，否则 await 会永远挂住
    for (const [, p] of pending) p.rej(new Error('CDP 连接已断开'))
    pending.clear()
  })
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true })
  })

  await raw('Profiler.enable')
  await raw('Profiler.setSamplingInterval', { interval: 200 })

  const first = await send('Runtime.evaluate', { expression: INJECT, returnByValue: true })
  if (first.timedOut) log('❌ 注入心跳超时 —— 主线程当前就卡着？')
  else if (first.err) log(`❌ 注入心跳失败：${first.err}`)
  else log(`✅ 双心跳已注入（落后 setInterval=${first.result?.value?.a}ms setTimeout=${first.result?.value?.b}ms）`)
  await startProfile()
  scheduleRoll()

  log(`判据：${HB} 落后 > ${THRESHOLD_MS}ms（轮询 ${POLL_MS}ms）；日志辅助证据 ${LOG_DIR}`)

  // 主循环：跑到断开为止
  for (;;) {
    await sleep(POLL_MS)
    updateCpu() // 每轮更新整机 CPU，供 capture 记录
    if (closed) throw new Error('CDP 连接已断开')
    if (busy) continue
    const r = await send('Runtime.evaluate', { expression: READ_HB, returnByValue: true }, EVAL_TIMEOUT_MS)
    if (closed) throw new Error('CDP 连接已断开')
    if (r.timedOut) {
      await capture('native', null, null)
      continue
    }
    if (r.err) {
      log(`evaluate 报错（心跳可能被清了，重注入）: ${r.err}`)
      await send('Runtime.evaluate', { expression: INJECT, returnByValue: true }, EVAL_TIMEOUT_MS)
      continue
    }
    const lagA = r.result?.value?.a
    const lagB = r.result?.value?.b
    if (typeof lagA !== 'number' || typeof lagB !== 'number') continue
    // ★ 两个独立心跳都停摆才算冻结 —— 单个 timer 落后区分不了「主线程卡住」与「timer 被推迟」
    if (lagA > THRESHOLD_MS && lagB > THRESHOLD_MS) {
      await capture('js', lagA, lagB)
    } else if (lagA > THRESHOLD_MS || lagB > THRESHOLD_MS) {
      log(`⚠️ 单心跳落后（setInterval=${lagA}ms setTimeout=${lagB}ms）—— 不判冻结，疑似 timer 被推迟`)
    } else if (process.env.FREEZE_CAPTURE_VERBOSE) {
      log(`lag=${lagA}/${lagB}ms`)
    }
  }
}

// ── 外层：断线重连（dev 环境应用重启是常态，不能一断就退）──────────────────
fs.mkdirSync(OUT, { recursive: true })
log(`产物目录 ${OUT}；目标 inspector :${PORT}；断线后每 ${RECONNECT_MS}ms 重试`)

let attempt = 0
for (;;) {
  try {
    attempt++
    if (attempt > 1) log(`第 ${attempt} 次连接…`)
    await session()
  } catch (e) {
    log(`会话结束：${e.message}`)
  }
  closed = true
  if (rollTimer) clearInterval(rollTimer)
  try { ws?.close() } catch {}
  await sleep(RECONNECT_MS)
}
