/**
 * 冻结现场捕获器：盯住主进程的事件循环冻结，自动把 CPU profile 抓下来。
 *
 * ## 为什么需要它
 *
 * 2026-09-19 查过一次导出期间的 96 秒异常：其中确认有一处主线程完全冻结
 * （应用日志里某行的**外层**落盘时间戳比**内层**生成时间戳晚 54 秒）。
 * 但那是启动 + 同步并发下的偶发事件，之后六次复现尝试都没再出现，
 * 六次 CPU profile 全部干净（无 >200ms 的 JS 空隙）—— 抓不到现场就查不动。
 *
 * ## 判据为什么用「日志内层时间戳」
 *
 * 应用日志每行形如 `[外层时间戳] [LEVEL] [内层时间戳] [LEVEL] [命名空间] ...`：
 * 外层是 file-logger 落盘那一刻，内层是 logger.warn 被调用的那一刻。
 * **主线程冻结时 writeLine 执行不了，两者就会拉开**（坏样本里差了 54 秒）。
 *
 * ⚠️ 不要用「日志文件是否增长」当判据 —— 那是我第一版的错误：安静时段本来就
 * 不打日志，会把正常静默误报成冻结（当时报了 54 次假阳性，全是噪声）。
 * 内层/外层的**落差**只在真正阻塞时增长，静默期不会。
 *
 * ## 用法
 *
 *   # 1. 带 --inspect 启动（端口随意，下面传给它）
 *   cd apps/windows && node scripts/run-dev.cjs --inspect=5860
 *
 *   # 2. 挂上捕获器（常驻）
 *   node scripts/capture-main-freeze.mjs --port 5860
 *
 *   # 3. 等它自己报「捕获到冻结」
 *   #    产物：<out>/freeze-<时刻>.cpuprofile + .json（含冻结时刻与前后日志）
 *
 * 冻结阈值、采样深度可用 --threshold / --window 调。
 */
import fs from 'node:fs'
import path from 'node:path'

// ── 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PORT = Number(arg('port', '5860'))
/** 内层↔外层时间戳落差超过它就认定「主线程被冻住了」 */
const THRESHOLD_MS = Number(arg('threshold', '2000'))
/** profile 环缓冲保留的样本数（200µs/样本 → 200_000 ≈ 40s） */
const SAMPLE_WINDOW = Number(arg('window', '200000'))
const LOG = arg('log', 'C:/Users/75791/.lumii/logs/app/mtbot-' +
  new Date().toISOString().slice(0, 10) + '.log')
const OUT = arg('out', 'C:/tmp/freeze-captures')

// ── 读日志尾部，取最后一条「内层时间戳」 ────────────────────────────────────
const INNER_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[[A-Z]+\] \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/gm
const parseTs = (s) => Date.parse(s.replace(' ', 'T') + 'Z')

/** 返回 { inner: number|undefined, outer: number|undefined, line: string } */
function lastLine() {
  let fd
  try {
    const size = fs.statSync(LOG).size
    const len = Math.min(size, 8192)
    fd = fs.openSync(LOG, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const text = buf.toString('utf8')
    const lines = text.split('\n').filter((l) => l.length > 10)
    const line = lines[lines.length - 1] ?? ''
    INNER_RE.lastIndex = 0
    const m = INNER_RE.exec(line)
    // 双时间戳形态：外层 m[1]、内层 m[2]。单时间戳形态（如 [Main] 直打）取 m[1]。
    return m
      ? { outer: parseTs(m[1]), inner: parseTs(m[2] ?? m[1]), line: line.slice(0, 200) }
      : { line: line.slice(0, 200) }
  } catch {
    return { line: '' }
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

// ── 连 CDP ────────────────────────────────────────────────────────────────
async function findWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const t = list.find((x) => x.webSocketDebuggerUrl)
      if (t) return t.webSocketDebuggerUrl
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`连不上 inspector :${PORT}（确认应用是用 --inspect=${PORT} 起的）`)
}

const wsUrl = await findWsUrl()
const ws = new WebSocket(wsUrl)
let msgId = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
  }
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

await send('Profiler.enable')
await send('Profiler.setSamplingInterval', { interval: 200 })

const log = (...a) => console.log(`[freeze-capture ${new Date().toISOString().slice(11, 19)}]`, ...a)
log(`已连上 ${wsUrl}`)
log(`判据：内层↔外层时间戳落差 > ${THRESHOLD_MS}ms；日志 ${LOG}`)
log(`产物目录 ${OUT}`)
fs.mkdirSync(OUT, { recursive: true })

// ── 环缓冲：每 WINDOW 秒重启一次 profile，丢弃旧样本，内存有界 ──────────────
const RESTART_EVERY_MS = (SAMPLE_WINDOW * 0.2)
let capturing = false
let seenInner = 0

async function roll() {
  if (capturing) return
  try {
    const { profile } = await send('Profiler.stop')
    lastProfile = profile
  } catch { /* 还没 start 过 */ }
  try { await send('Profiler.start') } catch (e) { log('start 失败:', e.message) }
}

let lastProfile = null
await roll()
let rollTimer = setInterval(() => void roll(), RESTART_EVERY_MS)
// roll 期间不能让检测误判，用一个短锁
const rollLock = { busy: false }

async function capture(freezeMs, at) {
  capturing = true
  log(`⚠️ 捕获到冻结：落差 ${freezeMs}ms（${at}）`)
  clearInterval(rollTimer)
  try {
    const { profile } = await send('Profiler.stop')
    const stamp = at.replace(/[: .]/g, '-')
    const profPath = path.join(OUT, `freeze-${stamp}.cpuprofile`)
    fs.writeFileSync(profPath, JSON.stringify(profile))
    // 附带现场元信息：日志最后一行 + 冻结时刻
    const meta = {
      freezeMs,
      at,
      capturedAt: new Date().toISOString(),
      logFile: LOG,
      lastLogLine: lastLine().line,
      nodes: profile.nodes.length,
      samples: profile.samples.length,
      note: 'freezeMs = 最后一条日志「内层生成时刻」到「外层落盘时刻」的落差',
    }
    fs.writeFileSync(profPath.replace(/\.cpuprofile$/, '.json'), JSON.stringify(meta, null, 2))
    log(`已保存 ${profPath}（${profile.samples.length} 样本）`)
  } catch (e) {
    log('抓取失败:', e.message)
  }
  // 抓完继续盯（可能还有第二次）
  capturing = false
  await roll()
  rollTimer = setInterval(() => void roll(), RESTART_EVERY_MS)
}

// ── 主循环：每 250ms 看一次落差 ────────────────────────────────────────────
const POLL_MS = 250
for (;;) {
  await new Promise((r) => setTimeout(r, POLL_MS))
  const { inner, outer, line } = lastLine()
  if (inner === undefined) continue

  // 只关心**新出现**的行：inner 比上次新才重新计时，避免拿旧行反复报警
  if (inner > seenInner) seenInner = inner

  // 落差 = 现在 - 最后一条日志的内层生成时刻。冻结时 writeLine 卡住，
  // 这个值会持续增长；正常运行时它总在毫秒级（新行不断刷新 inner）。
  const lag = Date.now() - seenInner
  if (lag > THRESHOLD_MS && !capturing) {
    await capture(lag, new Date(seenInner).toISOString().slice(11, 23))
    seenInner = Date.now() // 复位，避免立刻二次触发
  }
  if (process.env.FREEZE_CAPTURE_VERBOSE) log(`lag=${lag}ms  ${line.slice(0, 80)}`)
}
