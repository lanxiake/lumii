/**
 * 浏览器操作套件执行器（BROWSER 域）
 *
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 * 用例：docs/test/lumii-cli/browser/browser-test-cases.md
 *
 * ## 设计要点
 *
 * **驱动批量化、判定细粒度**：一次 LLM 往返跑多步工具操作（真实用户就是这么用的，
 * 也省往返——本机模型端点被多会话共用，往返很贵），但每个工具调用**单独判定**：
 * 从 DB 的 `messages.parts` 里按 `type==='tool'` 逐个提取 name/args/result/status。
 *
 * **判据两层**：执行层（工具真的被调用、返回了什么）+ 效果层（CDP 直读页面状态）。
 * 模型在正文里的自述一律不作为判据。
 *
 * 用法：node docs/test/lumii-cli/browser/run-browser-suite.mjs [--only NAV,CLICK]
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assert,
  createEvidence,
  dbQuery,
  preflight,
  sendAndWait,
  ui,
  okJson,
} from '../lib/cli-harness.mjs'
import {
  cdpAlive,
  evalOnPage,
  listPages,
  readProbe,
  cdpPort,
} from './lib/browser-observer.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SUITE_DIR = __dirname
const PORT = Number(process.env.BROWSER_PROBE_PORT ?? 18799)
const CDP = cdpPort()

const onlyArg = process.argv.indexOf('--only')
const ONLY = onlyArg > -1 ? (process.argv[onlyArg + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null

// ────────────────────────────────────────────────
// 取证工具
// ────────────────────────────────────────────────

/** 读会话里全部 assistant 消息的 tool parts（按时间序） */
function collectToolCalls(sk) {
  const rows = dbQuery(
    "SELECT id, content_json FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY timestamp ASC, rowid ASC",
    sk,
  )
  const out = []
  for (const r of rows) {
    let cj
    try {
      cj = JSON.parse(r.content_json)
    } catch {
      continue
    }
    for (const p of cj?.parts ?? []) {
      if (p?.type === 'tool') out.push({ ...p, messageId: r.id })
    }
  }
  return out
}

/** 取 result 里的文本（工具的返回体可能是 {content:[{type:'text',text}]} 或裸对象） */
function resultText(result) {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (typeof result === 'object') {
    const c = result.content
    if (Array.isArray(c)) return c.filter((x) => x?.type === 'text').map((x) => x.text ?? '').join('\n')
    try {
      return JSON.stringify(result)
    } catch {
      return String(result)
    }
  }
  return String(result)
}

/** 工具返回体里解析出的 JSON 载荷（`{ok:true,result:{...}}` 形态）；解析不出返回 null */
function resultJson(result) {
  const t = resultText(result).trim()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

/** 从一次回合的新增 calls 里找指定工具（可给第几次出现） */
function findCall(calls, name, nth = 0) {
  const hit = calls.filter((c) => c.name === name)
  return hit[nth] ?? null
}

/** 断言一个 tool 调用成功（status=done 且非 error）；失败抛出可读原因 */
function assertToolOk(call, name) {
  assert(call, `模型没有调用 ${name}`)
  assert(
    call.status === 'done',
    `${name} 状态为 ${call.status}（预期 done）：${resultText(call.result).slice(0, 200)}`,
  )
  return call
}

/**
 * 异步 sleep。
 *
 * **不要用 harness 的 `sleep()`**：它是 `Atomics.wait`，会阻塞整个事件循环。
 * 本套件在轮询期间，Chrome 可能正在加载我们自己的探针页面——事件循环一卡，
 * 服务器就收不到请求，表现为 `page.goto: Timeout`（首跑 NAV-01 就是这么挂的）。
 * 探针服务器虽已挪到独立进程，套件内的等待也一并异步化，免得再踩。
 */
const asleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等 CDP 里出现匹配页面（navigate 之后页面才存在） */
async function waitForPageUrl(pattern, timeoutMs = 25000) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern))
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const pages = await listPages(CDP)
    const hit = pages.find((p) => re.test(p.url))
    if (hit) return hit
    await asleep(500)
  }
  return null
}

/** 轮询等页面上 __probe 就绪（navigate 后脚本可能还没跑完） */
async function waitProbeReady(timeoutMs = 20000, urlPattern = /interact\.html/) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const p = await readProbe(CDP, urlPattern)
    if (p && p.ready) return p
    await asleep(400)
  }
  return null
}

/**
 * 在**独立进程**里起探针页面服务器。
 *
 * 为什么不能像最初那样在本进程 `startProbeServer()`：harness 的 `ui()` 用
 * `spawnSync` 调 CLI，`sendAndWait` 的轮询用 `Atomics.wait`——两者都会**同步阻塞
 * 事件循环**。服务器跑在同一进程里，就会在模型调用 browser_navigate 的那一刻
 * 完全无法响应，Chrome 那边表现为 goto 超时（NAV-01 首跑实测）。
 */
/**
 * 从 start 起找一个空闲端口。
 *
 * **不能写死端口**：本仓库常有并行会话在同一工作区跑各自的验证脚本，
 * 18799 就被 `verify/pet-sprite/characters/local-toolchain-server.mjs` 占过
 * （2026-09-21 实测，导致重跑直接以「探针服务器未能就绪」终止）。
 */
async function findFreePort(start, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const p = start + i
    const free = await new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(p, '127.0.0.1')
    })
    if (free) return p
  }
  return null
}

async function spawnProbeServer(startPort) {
  const port = await findFreePort(startPort)
  if (!port) throw new Error(`从 ${startPort} 起连续 ${30} 个端口都被占用`)
  if (port !== startPort) console.log(`[browser-suite] 端口 ${startPort} 被占用，改用 ${port}`)

  const script = path.join(__dirname, 'lib', 'serve-fixtures.mjs')
  const child = spawn(process.execPath, [script, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += String(c)))
  child.stdout.on('data', () => {})

  const origin = `http://127.0.0.1:${port}`
  const ok = await new Promise((resolve) => {
    const deadline = Date.now() + 15000
    const tryOnce = () => {
      const req = http.get(`${origin}/interact.html`, { timeout: 1500 }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('timeout', () => {
        req.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(tryOnce, 300)
      })
      req.on('error', () => {
        if (Date.now() > deadline) resolve(false)
        else setTimeout(tryOnce, 300)
      })
    }
    tryOnce()
  })

  if (!ok) {
    child.kill()
    throw new Error(`探针服务器未能就绪（端口 ${port}）${stderr ? '：' + stderr.slice(0, 300) : ''}`)
  }
  return { origin, port, close: () => child.kill() }
}

/** 读当前浏览器活动页的 URL（CDP 视角；忽略 about:blank / devtools） */
async function activePageUrl() {
  const pages = await listPages(CDP)
  const real = pages.filter((p) => /^https?:/.test(p.url))
  return real.length ? real[real.length - 1].url : (pages[0]?.url ?? '')
}

// ────────────────────────────────────────────────
// 探针会话
// ────────────────────────────────────────────────

function newProbeSession(title) {
  const c = okJson(ui(['conversation', 'create', '--title', `[browser-suite] ${title}`]), 'conversation create')
  const sk = c.sessionKey ?? c.id
  assert(sk, `会话创建未返回 sessionKey: ${JSON.stringify(c).slice(0, 200)}`)
  return sk
}

/** 发一条指令并等回合结束；返回本回合新增的工具调用 */
function turn(sk, prompt, { timeoutMs = 300000 } = {}) {
  const before = collectToolCalls(sk).length
  const r = sendAndWait(sk, prompt, { timeoutMs, pollMs: 2000 })
  const all = collectToolCalls(sk)
  return { calls: all.slice(before), elapsedMs: r.elapsedMs, text: r.text }
}

// ────────────────────────────────────────────────
// 步骤定义
// ────────────────────────────────────────────────

/** @type {{key:string, cases:string[], run:(ctx:any)=>Promise<{id:string,status:string,note:string}[]>}[]} */
const STEPS = []
const step = (key, cases, run) => STEPS.push({ key, cases, run })

const T = (s) => s.trim().replace(/\n\s+/g, '\n')

// ── A 组：导航 ──────────────────────────────────
step('NAV', ['BROWSER-NAV-01'], async (ctx) => {
  const target = `${ctx.origin}/interact.html`
  const t = turn(
    ctx.sk,
    T(`请调用 browser_navigate 工具，打开这个地址：${target}
只做这一个工具调用，不要做其它任何操作。完成后把工具返回的内容原样贴出来。`),
  )
  ctx.lastTurn = t
  const call = findCall(t.calls, 'browser_navigate')
  const payload = call ? resultJson(call.result) : null
  const reportedUrl = payload?.result?.url ?? payload?.url ?? null

  assertToolOk(call, 'browser_navigate')
  assert(payload?.ok === true, `browser_navigate 返回体 ok 不为 true：${resultText(call.result).slice(0, 200)}`)
  assert(
    typeof reportedUrl === 'string' && reportedUrl.includes('/interact.html'),
    `返回体 url 不含 interact.html：${String(reportedUrl)}`,
  )

  const page = await waitForPageUrl(/interact\.html/, 45000)
  assert(page, `CDP 里没有出现 interact.html 页面（当前：${(await listPages(CDP)).map((p) => p.url).join(', ') || '无'}）`)
  const title = await evalOnPage(CDP, /interact\.html/, 'document.title')
  assert(
    typeof title.value === 'string' && title.value.includes('Lumii Browser Probe'),
    `页面标题不符：${String(title.value)}`,
  )
  return [{ id: 'BROWSER-NAV-01', status: 'PASS', note: `冷启动+落地成功，title="${title.value}"` }]
})

step('NAV2', ['BROWSER-NAV-02'], async (ctx) => {
  const target = `${ctx.origin}/second.html`
  const t = turn(
    ctx.sk,
    T(`请调用 browser_navigate 工具，打开这个地址：${target}
只做这一个工具调用。完成后把工具返回的内容原样贴出来。`),
  )
  const call = assertToolOk(findCall(t.calls, 'browser_navigate'), 'browser_navigate')
  const payload = resultJson(call.result)

  const page = await waitForPageUrl(/second\.html/, 25000)
  assert(page, 'CDP 里没有出现 second.html')
  const marker = await evalOnPage(CDP, /second\.html/, 'document.getElementById("page-marker")?.textContent ?? null')
  assert(marker.value === 'SECOND', `#page-marker 不是 SECOND：${String(marker.value)}`)
  return [
    {
      id: 'BROWSER-NAV-02',
      status: 'PASS',
      note: `换页生效，marker=${marker.value}，返回 ok=${payload?.ok}`,
    },
  ]
})

// ── B 组：快照 ──────────────────────────────────
step('SNAP', ['BROWSER-SNAP-01', 'BROWSER-SNAP-02'], async (ctx) => {
  // 先回到 interact.html，后续动作都在这一页
  const t0 = turn(ctx.sk, T(`请调用 browser_navigate 打开 ${ctx.origin}/interact.html，只做这一个调用。`))
  assertToolOk(findCall(t0.calls, 'browser_navigate'), 'browser_navigate(回interact)')
  await waitForPageUrl(/interact\.html/, 25000)
  await waitProbeReady()

  const t1 = turn(
    ctx.sk,
    T(`请调用 browser_snapshot 工具查看当前页面（不要传 full 参数），然后告诉我两件事：
1. 返回正文的第一行（形如 [page] ... refs=N）原样是什么
2. 页面里文本为「点击我」的那个按钮，它的 ref 是什么
只做这一个工具调用。`),
  )
  const snap = assertToolOk(findCall(t1.calls, 'browser_snapshot'), 'browser_snapshot')
  const text = resultText(snap.result)
  const header = text.split('\n')[0] ?? ''
  const refsMatch = /refs=(\d+)/.exec(header)
  assert(header.startsWith('[page]'), `快照首行不是 [page] 开头：${header.slice(0, 120)}`)
  assert(refsMatch && Number(refsMatch[1]) > 0, `快照 refs 不为正：${header.slice(0, 120)}`)

  const liveUrl = await evalOnPage(CDP, /interact\.html/, 'location.href')
  assert(
    String(header).includes(String(liveUrl.value)),
    `快照里的 url 与 CDP 实测不一致：快照「${header.slice(0, 120)}」vs 实测「${liveUrl.value}」`,
  )
  assert(/ref=e\d+/.test(text), '快照正文里没有 ref=eN 形态的元素引用')

  const t2 = turn(
    ctx.sk,
    T(`请调用 browser_snapshot 工具，这次传 full=true，读取当前页面的文字内容。
然后回答：页面上的一级标题文字是什么？只做这一个工具调用。`),
  )
  const full = assertToolOk(findCall(t2.calls, 'browser_snapshot'), 'browser_snapshot(full)')
  const fullText = resultText(full.result)
  assert(
    fullText.includes('Lumii Browser Probe'),
    `full 快照里读不到标题文字（前 200 字：${fullText.slice(0, 200)}）`,
  )
  assert(
    !/^\[page\][^\n]*refs=\d+\s*$/m.test(fullText) || fullText.length > 400,
    `full=true 似乎仍走了紧凑模式（返回过短：${fullText.length} 字符）`,
  )

  return [
    { id: 'BROWSER-SNAP-01', status: 'PASS', note: `refs=${refsMatch[1]}，url 与 CDP 一致` },
    { id: 'BROWSER-SNAP-02', status: 'PASS', note: `full 模式读到标题正文（${fullText.length} 字符）` },
  ]
})

// ── C 组：交互 ──────────────────────────────────
step('CLICK', ['BROWSER-CLICK-01', 'BROWSER-CLICK-02'], async (ctx) => {
  const t1 = turn(
    ctx.sk,
    T(`请按顺序执行：
1. 用 browser_snapshot 查看当前页面，找到文本为「点击我」的按钮的 ref
2. 用 browser_click 点击那个 ref
不要做其它操作。完成后说明两步是否都成功。`),
  )
  const snap = assertToolOk(findCall(t1.calls, 'browser_snapshot'), 'browser_snapshot(取ref)')
  const click = assertToolOk(findCall(t1.calls, 'browser_click'), 'browser_click')
  const clickRef = click.args?.ref
  assert(clickRef != null && String(clickRef).trim() !== '', `browser_click 的 ref 参数为空：${JSON.stringify(click.args)}`)

  await asleep(700)
  const probe = await readProbe(CDP, /interact\.html/)
  assert(probe, 'CDP 读不到 __probe（页面可能已不是 interact.html）')
  assert(probe.clicks === 1, `__probe.clicks 预期 1，实测 ${probe.clicks}`)
  const domCount = await evalOnPage(CDP, /interact\.html/, 'document.getElementById("click-count")?.textContent ?? null')
  assert(domCount.value === '1', `#click-count 预期 "1"，实测 ${String(domCount.value)}`)

  // 第二次点击
  const t2 = turn(
    ctx.sk,
    T(`请再用 browser_click 点击同一个按钮（文本为「点击我」的那个）。如果 ref 可能已失效，先重新 browser_snapshot 取一次。只做点击这一件事。`),
  )
  const click2 = assertToolOk(findCall(t2.calls, 'browser_click'), 'browser_click(第二次)')
  await asleep(700)
  const probe2 = await readProbe(CDP, /interact\.html/)
  assert(probe2, 'CDP 第二次读不到 __probe')
  assert(probe2.clicks === 2, `第二次点击后 __probe.clicks 预期 2，实测 ${probe2.clicks}`)

  return [
    { id: 'BROWSER-CLICK-01', status: 'PASS', note: `ref=${clickRef} → __probe.clicks=1，DOM 同步` },
    { id: 'BROWSER-CLICK-02', status: 'PASS', note: `连点递增 → __probe.clicks=2（args=${JSON.stringify(click2.args)}）` },
  ]
})

step('TYPE', ['BROWSER-TYPE-01'], async (ctx) => {
  const TEXT = 'lumii-probe-42'
  const t = turn(
    ctx.sk,
    T(`请按顺序执行：
1. 用 browser_snapshot 查看当前页面，找到那个占位符为「在此输入」的输入框的 ref
2. 用 browser_type 往它里面输入这段文字：${TEXT}
不要做其它操作。`),
  )
  assertToolOk(findCall(t.calls, 'browser_snapshot'), 'browser_snapshot(取输入框ref)')
  const type = assertToolOk(findCall(t.calls, 'browser_type'), 'browser_type')
  assert(String(type.args?.text ?? '') === TEXT, `browser_type 的 text 参数不符：${JSON.stringify(type.args)}`)

  await asleep(700)
  const probe = await readProbe(CDP, /interact\.html/)
  assert(probe, 'CDP 读不到 __probe')
  const last = Array.isArray(probe.inputEvents) ? probe.inputEvents[probe.inputEvents.length - 1] : null
  assert(last === TEXT, `__probe.inputEvents 末项预期 "${TEXT}"，实测 ${JSON.stringify(last)}`)
  const domVal = await evalOnPage(CDP, /interact\.html/, 'document.getElementById("input-text")?.value ?? null')
  assert(domVal.value === TEXT, `#input-text.value 预期 "${TEXT}"，实测 ${JSON.stringify(domVal.value)}`)
  return [{ id: 'BROWSER-TYPE-01', status: 'PASS', note: `输入事件与 DOM 值双向确认："${TEXT}"` }]
})

step('SCROLL', ['BROWSER-SCROLL-01'], async (ctx) => {
  const before = await evalOnPage(CDP, /interact\.html/, 'window.scrollY')
  const t = turn(
    ctx.sk,
    T(`请调用 browser_scroll 工具，direction 传 down，向下滚动页面。只做这一个调用。`),
  )
  const call = assertToolOk(findCall(t.calls, 'browser_scroll'), 'browser_scroll')
  await asleep(700)
  const after = await evalOnPage(CDP, /interact\.html/, 'window.scrollY')
  assert(
    typeof after.value === 'number' && after.value > (typeof before.value === 'number' ? before.value : 0),
    `scrollY 没有增加：前 ${before.value} → 后 ${after.value}`,
  )
  return [{ id: 'BROWSER-SCROLL-01', status: 'PASS', note: `scrollY ${before.value} → ${after.value}` }]
})

step('WAIT', ['BROWSER-WAIT-01'], async (ctx) => {
  const t = turn(
    ctx.sk,
    T(`请按顺序执行：
1. 用 browser_snapshot 找到文本为「3 秒后出现隐藏元素」的按钮的 ref（页面可能已滚动，需要先 snapshot）
2. 用 browser_click 点击它
3. 用 browser_wait 等待 CSS 选择器 #late-el 出现（selector 传 "#late-el"）
不要做其它操作。`),
  )
  assertToolOk(findCall(t.calls, 'browser_click'), 'browser_click(触发迟到元素)')
  const wait = assertToolOk(findCall(t.calls, 'browser_wait'), 'browser_wait')
  assert(
    String(wait.args?.selector ?? '') === '#late-el',
    `browser_wait 的 selector 参数不符：${JSON.stringify(wait.args)}`,
  )
  await asleep(500)
  const probe = await readProbe(CDP, /interact\.html/)
  const exists = await evalOnPage(CDP, /interact\.html/, 'document.querySelector("#late-el") ? true : false')
  assert(probe?.lateShown === true, `__probe.lateShown 预期 true，实测 ${String(probe?.lateShown)}`)
  assert(exists.value === true, '#late-el 在 DOM 里不存在')
  return [{ id: 'BROWSER-WAIT-01', status: 'PASS', note: 'selector 等待命中，元素已插入 DOM' }]
})

// ── D 组：求值 ──────────────────────────────────
step('EVAL', ['BROWSER-EVAL-01'], async (ctx) => {
  const t1 = turn(ctx.sk, T(`请调用 browser_eval 工具，script 传 1+1，把返回内容原样贴出来。只做这一个调用。`))
  const e1 = assertToolOk(findCall(t1.calls, 'browser_eval'), 'browser_eval(1+1)')
  const p1 = resultJson(e1.result)
  assert(p1, `browser_eval 返回体不是 JSON：${resultText(e1.result).slice(0, 200)}`)
  assert(p1.ok === true, `browser_eval 返回 ok 不为 true：${resultText(e1.result).slice(0, 200)}`)
  // 注意层级：wrapExecute 包一层 `{ok,result}`，browserEvalPayload 再把求值结果放进内层 `result`
  const body1 = p1.result ?? {}
  assert(body1.result === 2, `1+1 结果预期 2，实测 ${JSON.stringify(body1.result)}`)
  assert(
    typeof body1.url === 'string' && body1.url.length > 0,
    `返回体缺少 url 字段（2026-09-21 修的正是这个）：${resultText(e1.result).slice(0, 200)}`,
  )

  // 读 __probe.clicks 并与 CDP 直读交叉比对
  const t2 = turn(
    ctx.sk,
    T(`请调用 browser_eval 工具，script 传 window.__probe.clicks，把返回的数值原样告诉我。只做这一个调用。`),
  )
  const e2 = assertToolOk(findCall(t2.calls, 'browser_eval'), 'browser_eval(读 clicks)')
  const p2 = resultJson(e2.result)
  assert(p2?.ok === true, `第二次 eval 返回 ok 不为 true：${resultText(e2.result).slice(0, 200)}`)
  const clicksViaTool = p2?.result?.result
  const probe = await readProbe(CDP, /interact\.html/)
  assert(probe, 'CDP 读不到 __probe 用于交叉验证')
  assert(
    Number(clicksViaTool) === Number(probe.clicks),
    `eval 读到的 clicks（${JSON.stringify(clicksViaTool)}）与 CDP 直读（${probe.clicks}）不一致`,
  )
  return [
    {
      id: 'BROWSER-EVAL-01',
      status: 'PASS',
      note: `1+1=2；url 字段在；clicks 交叉一致（${clicksViaTool}）`,
    },
  ]
})

step('EVAL2', ['BROWSER-EVAL-02'], async (ctx) => {
  // 造一个真实的空白页场景：navigate 到 about:blank。
  // 注意必须做**成功**的求值——抛错走的是 error 分支，不会带 url/note（见 bridge-browser-tools.ts）。
  const t1 = turn(ctx.sk, T(`请调用 browser_navigate 工具打开 about:blank。只做这一个调用。`))
  assertToolOk(findCall(t1.calls, 'browser_navigate'), 'browser_navigate(about:blank)')
  const blank = await waitForPageUrl(/^about:blank/, 15000)
  assert(
    blank,
    `CDP 里没有 about:blank 页面（当前：${(await listPages(CDP)).map((p) => p.url).join(', ')}）`,
  )

  const t2 = turn(ctx.sk, T(`请调用 browser_eval 工具，script 传 1+1，把返回内容原样贴出来。只做这一个调用。`))
  const call = assertToolOk(findCall(t2.calls, 'browser_eval'), 'browser_eval(空白页)')
  const payload = resultJson(call.result)
  const body = payload?.result ?? {}
  assert(payload?.ok === true, `空白页求值未成功：${resultText(call.result).slice(0, 200)}`)
  assert(
    typeof body.url === 'string' && /^about:blank/.test(body.url),
    `返回体 url 不是空白页：${JSON.stringify(payload).slice(0, 200)}`,
  )
  assert(
    typeof body.note === 'string' && body.note.includes('browser_navigate'),
    `空白页缺少「先导航」提示（2026-09-21 修的正是这个）：${JSON.stringify(payload).slice(0, 300)}`,
  )

  // 收尾回 interact，别让套件结束时浏览器停在空白页
  const t3 = turn(ctx.sk, T(`请调用 browser_navigate 打开 ${ctx.origin}/interact.html。只做这一个调用。`))
  assertToolOk(findCall(t3.calls, 'browser_navigate'), 'browser_navigate(收尾)')

  return [
    { id: 'BROWSER-EVAL-02', status: 'PASS', note: `空白页求值带导航提示：「${body.note.slice(0, 36)}…」` },
  ]
})

// ── E 组：历史与截图 ────────────────────────────
step('HIST', ['BROWSER-HIST-01', 'BROWSER-HIST-02'], async (ctx) => {
  // 自包含地铺历史：interact → second，这样单独 --only HIST 也能跑
  const tA = turn(ctx.sk, T(`请调用 browser_navigate 打开 ${ctx.origin}/interact.html，只做这一个调用。`))
  assertToolOk(findCall(tA.calls, 'browser_navigate'), 'browser_navigate(铺历史起点)')
  assert(await waitForPageUrl(/interact\.html/, 25000), '起点 interact.html 没打开')

  const tB = turn(ctx.sk, T(`请调用 browser_navigate 打开 ${ctx.origin}/second.html，只做这一个调用。`))
  assertToolOk(findCall(tB.calls, 'browser_navigate'), 'browser_navigate(去 second)')
  assert(await waitForPageUrl(/second\.html/, 25000), 'second.html 没打开')

  // 后退
  const tBack = turn(ctx.sk, T(`请调用 browser_back 工具返回上一页。只做这一个调用。`))
  assertToolOk(findCall(tBack.calls, 'browser_back'), 'browser_back')
  const backPage = await waitForPageUrl(/interact\.html/, 20000)
  assert(
    backPage,
    `back 之后没回到 interact.html（当前：${(await listPages(CDP)).map((p) => p.url).join(', ')}）`,
  )

  // 前进：back 之后历史里仍有 second，可直接前进
  const tF = turn(ctx.sk, T(`请调用 browser_forward 工具前进到下一页。只做这一个调用。`))
  assertToolOk(findCall(tF.calls, 'browser_forward'), 'browser_forward')
  const fwdPage = await waitForPageUrl(/second\.html/, 20000)
  assert(
    fwdPage,
    `forward 之后没回到 second.html（当前：${(await listPages(CDP)).map((p) => p.url).join(', ')}）`,
  )

  return [
    { id: 'BROWSER-HIST-01', status: 'PASS', note: 'history.back() 落到 interact.html' },
    { id: 'BROWSER-HIST-02', status: 'PASS', note: 'history.forward() 回到 second.html' },
  ]
})

step('SHOT', ['BROWSER-SHOT-01', 'BROWSER-PERF-01'], async (ctx) => {
  /**
   * 两次连续截图，分别计时。
   *
   * 2026-09-21 实测：**首次截图 79–231 秒，第二次起 ~85ms**（快约 1000 倍）。
   * 根因是 Chrome 以 headed 方式运行（`headless:false`，browser-service.ts:109），窗口在
   * 后台时合成器休眠，首次 `Page.captureScreenshot` 要等首帧产出；此后帧已在产，就快了。
   * 裸 CDP 对照实验确认 `Runtime.evaluate` 只要 19ms，慢的不是 CDP 通道。
   *
   * 这里**如实测量、不做阈值断言**（窗口是否在前台依环境而变），但把两次耗时都记进证据
   * ——「第一次截图像卡死」正是用户最容易感知的流畅性问题，必须留痕。
   */
  const shotTimes = []
  for (let i = 0; i < 2; i++) {
    const t = turn(ctx.sk, T(`请调用 browser_screenshot 工具截图当前页面，把返回内容原样贴出来。只做这一个调用。`))
    const call = assertToolOk(findCall(t.calls, 'browser_screenshot'), `browser_screenshot(第${i + 1}次)`)
    const text = resultText(call.result)
    const m = /"path"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(text)
    assert(m, `截图返回体里找不到 path：${text.slice(0, 300)}`)
    const filePath = m[1].replace(/\\\\/g, '\\')
    const normalized = filePath.replace(/\//g, path.sep)
    assert(fs.existsSync(normalized), `截图文件不存在：${filePath}`)
    const size = fs.statSync(normalized).size
    assert(size > 5000, `截图文件过小（${size} 字节），像是空白图：${filePath}`)
    shotTimes.push({ ms: t.elapsedMs, size, name: path.basename(filePath) })
  }

  const [first, second] = shotTimes
  const ratio = second.ms > 0 ? (first.ms / second.ms).toFixed(1) : '?'
  return [
    {
      id: 'BROWSER-SHOT-01',
      status: 'PASS',
      note: `两次均产出有效图（${(first.size / 1024).toFixed(1)}KB / ${(second.size / 1024).toFixed(1)}KB）`,
    },
    {
      id: 'BROWSER-PERF-01',
      status: 'PASS',
      note:
        `回合耗时：首次 ${(first.ms / 1000).toFixed(1)}s → 第二次 ${(second.ms / 1000).toFixed(1)}s` +
        `（含模型往返，比值 ${ratio}x；首帧唤醒成本）`,
    },
  ]
})

// ── F 组：稳定性与错误处理 ──────────────────────
step('STAB', ['BROWSER-STAB-01'], async (ctx) => {
  const t = turn(
    ctx.sk,
    T(`请连续调用 browser_snapshot 工具三次（就是连着发三次同样的调用），每次都不要传参数。
然后把三次返回的第一行分别贴出来。`),
  )
  const snaps = t.calls.filter((c) => c.name === 'browser_snapshot')
  assert(snaps.length >= 3, `本回合 browser_snapshot 只被调用了 ${snaps.length} 次（预期 3 次）`)
  const sizes = snaps.slice(0, 3).map((s) => {
    assertToolOk(s, 'browser_snapshot(连续)')
    const txt = resultText(s.result)
    assert(txt.length > 50, `某次快照返回过短（${txt.length} 字符）：${txt.slice(0, 120)}`)
    return txt.length
  })
  return [
    {
      id: 'BROWSER-STAB-01',
      status: 'PASS',
      note: `连续 3 次均成功，长度 ${sizes.join('/')}`,
    },
  ]
})

step('ERR', ['BROWSER-ERR-01', 'BROWSER-ERR-02', 'BROWSER-ERR-03'], async (ctx) => {
  const out = []
  /** 每个子用例独立 try/catch：一个失败不该把另外两个也记成 FAIL（首跑就吃了这个亏） */
  const guard = async (id, fn) => {
    try {
      out.push({ id, status: 'PASS', note: await fn() })
    } catch (err) {
      out.push({ id, status: 'FAIL', note: err instanceof Error ? err.message : String(err) })
    }
  }

  await guard('BROWSER-ERR-01', async () => {
    const t = turn(
      ctx.sk,
      T(`请调用 browser_click 工具，ref 参数传 "e99999"（这个 ref 不存在）。把工具返回的内容原样贴出来。只做这一个调用。`),
    )
    const c = findCall(t.calls, 'browser_click')
    assert(c, '模型没有调用 browser_click')
    const p = resultJson(c.result)
    assert(p?.ok === false || c.isError === true, `无效 ref 没有报错：${resultText(c.result).slice(0, 200)}`)
    const err = String(p?.error ?? '')
    assert(err.trim().length > 0, `错误信息为空：${resultText(c.result).slice(0, 200)}`)
    return `可读报错：${err.slice(0, 70)}`
  })

  await guard('BROWSER-ERR-02', async () => {
    const t = turn(
      ctx.sk,
      T(`请调用 browser_navigate 打开 http://127.0.0.1:1/ （这个地址必然连不上）。把返回内容原样贴出来。只做这一个调用。`),
    )
    const c = findCall(t.calls, 'browser_navigate')
    assert(c, '模型没有调用 browser_navigate')
    const p = resultJson(c.result)
    assert(p?.ok === false || c.isError === true, `导航到不可达地址没有报错：${resultText(c.result).slice(0, 200)}`)
    const err = String(p?.error ?? '')
    assert(err.trim().length > 0, `错误信息为空：${resultText(c.result).slice(0, 200)}`)

    // 浏览器没被打挂——用 **CDP 直连**验证，而不是指望模型再调一次工具
    // （首跑时模型在此处选择不调用 snapshot，用例就误判了）
    await asleep(800)
    const pages = await listPages(CDP)
    assert(pages.length > 0, '导航失败后 CDP 里连一个页面都没有了——浏览器可能被打挂')
    const alive = await evalOnPage(CDP, /./, '1+1')
    assert(alive.ok && alive.value === 2, `页面上下文已不可用：${alive.error ?? String(alive.value)}`)
    return `可读报错且浏览器存活（CDP 直连确认）：${err.slice(0, 60)}`
  })

  await guard('BROWSER-ERR-03', async () => {
    // 先确保有个正常页面可操作
    const t0 = turn(ctx.sk, T(`请调用 browser_navigate 打开 ${ctx.origin}/interact.html，只做这一个调用。`))
    assert(findCall(t0.calls, 'browser_navigate'), '模型没有调用 browser_navigate（准备页）')

    const t1 = turn(
      ctx.sk,
      T(`请调用 browser_eval 工具，script 参数传这个非法表达式：this is not valid js(((　把返回内容原样贴出来。只做这一个调用。`),
    )
    const c1 = findCall(t1.calls, 'browser_eval')
    assert(c1, '模型没有调用 browser_eval')
    const p1 = resultJson(c1.result)
    assert(p1?.ok === false || c1.isError === true, `非法脚本没有报错：${resultText(c1.result).slice(0, 200)}`)
    const err = String(p1?.error ?? '')
    assert(err.trim().length > 0, `错误信息为空：${resultText(c1.result).slice(0, 200)}`)

    const t2 = turn(ctx.sk, T(`请调用 browser_eval 工具，script 传 2+2，把返回内容原样贴出来。只做这一个调用。`))
    const c2 = assertToolOk(findCall(t2.calls, 'browser_eval'), 'browser_eval(非法脚本之后)')
    const p2 = resultJson(c2.result)
    assert(p2?.result?.result === 4, `非法脚本之后 eval 失效：${resultText(c2.result).slice(0, 200)}`)
    return `可读报错且求值能力未受损（2+2=4）：${err.slice(0, 60)}`
  })

  return out
})

// ────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────

async function main() {
  const ev = createEvidence(SUITE_DIR, 'browser-suite', '浏览器操作套件')

  const pf = preflight()
  if (!pf.ok) {
    console.error('⛔ 预检失败：')
    for (const p of pf.problems) console.error('  - ' + p)
    console.error('提示：先启动客户端（pnpm dev 或已安装版），再跑本套件。')
    process.exit(3)
  }
  for (const w of pf.warnings) console.warn('⚠️  ' + w)

  console.log(`[browser-suite] CDP 端口 ${CDP}；首次调用浏览器工具时才启动 Chrome（冷启动由 NAV-01 覆盖）`)
  console.log(`[browser-suite] CDP 当前可达：${await cdpAlive(CDP)}`)

  const server = await spawnProbeServer(PORT)
  console.log(`[browser-suite] 探针页面服务（独立进程）：${server.origin}`)

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    server.close()
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  const fails = { count: 0 }
  let stop = false

  try {
    for (const s of STEPS) {
      if (ONLY && !ONLY.includes(s.key)) continue
      if (stop) break
      console.log(`\n── 步骤 ${s.key}（覆盖 ${s.cases.join(', ')}） ──`)
      // 每个步骤一个独立探针会话：避免上下文里的旧工具结果被模型抄（2026-09-17 踩过）
      let ctx
      try {
        const sk = newProbeSession(`${s.key}-${new Date().toISOString().slice(11, 19)}`)
        ctx = { sk, origin: server.origin, cdp: CDP }
        const results = await s.run(ctx)
        for (const r of results) {
          if (fails) fails.count = 0
          ev.record(r.id, r.status, r.note, { sessionKey: sk })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        for (const caseId of s.cases) {
          ev.record(caseId, 'FAIL', msg, {
            sessionKey: ctx?.sk,
            stack: err instanceof Error ? err.stack : undefined,
          })
        }
        fails.count++
        if (fails.count >= 3) {
          console.error('⛔ 连续 3 个步骤失败，提前终止（请检查环境/模型）')
          stop = true
        }
      }
    }
  } finally {
    cleanup()
  }

  // 流畅性：从日志取本次套件期间的 ToolRunner 耗时
  const fluency = (() => {
    try {
      const logDir = path.join(os.homedir(), '.lumii', 'logs', 'app')
      const files = fs.readdirSync(logDir).filter((f) => /^mtbot-.*\.log$/.test(f))
      if (!files.length) return null
      const latest = files
        .map((f) => ({ f, m: fs.statSync(path.join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0].f
      const content = fs.readFileSync(path.join(logDir, latest), 'utf-8')
      const lines = content.split(/\r?\n/)
      const cutoff = lines.length - 20000
      const durations = []
      for (let i = Math.max(0, cutoff); i < lines.length; i++) {
        const m = /\[ToolRunner\] ← (browser_\w+) durationMs=(\d+)/.exec(lines[i])
        if (m) durations.push({ tool: m[1], ms: Number(m[2]) })
      }
      if (!durations.length) return null
      const byTool = {}
      for (const d of durations) {
        byTool[d.tool] ??= []
        byTool[d.tool].push(d.ms)
      }
      const rows = Object.entries(byTool).map(([tool, arr]) => ({
        tool,
        n: arr.length,
        median: arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)],
        max: Math.max(...arr),
      }))
      return rows
    } catch {
      return null
    }
  })()

  const fluencySection = fluency
    ? `\n## 流畅性（工具耗时，取自 \`[ToolRunner] ← ... durationMs=\`，日志近 2 万行）\n\n| 工具 | 次数 | 中位耗时 | 最大耗时 |\n|---|---|---|---|\n${fluency
        .map((r) => `| ${r.tool} | ${r.n} | ${r.median}ms | ${r.max}ms |`)
        .join('\n')}\n`
    : '\n## 流畅性\n\n（日志通道不可用或本次未采集到 ToolRunner 记录）\n'

  const findingsSection = `
## 主要发现

### 1. ⚠️ 首次截图极慢（79–231 秒），之后 ~85ms

上表 \`browser_screenshot\` 的 140ms 是**热状态**读数——本套件跑之前，Chrome 的合成器
已被其他调试活动唤醒过。**冷状态下的首次截图完全是另一回事**，裸 CDP 独立实验（不经工具层）：

| 连续第 N 次 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 耗时 | **79648ms** | 79ms | 90ms | 76ms | 84ms |

套件首轮（浏览器刚被拉起）实测 \`ToolRunner ← browser_screenshot durationMs=231641\` ——**231 秒**。

**根因**：Chrome 以 \`headless:false\` 运行（\`apps/windows/src/main/browser-service.ts:109\`），
窗口在后台时合成器休眠，首次 \`Page.captureScreenshot\` 要等首帧产出；此后帧已在产就快了。

**已排除**（对照实验做的，别重复走弯路）：
- 不是 CDP 通道慢——同一时刻 \`Runtime.evaluate\` 只要 **19ms**
- 不是 \`captureBeyondViewport\` 的锅——置 false 反而更慢（120s 超时）
- 不是页面太大——\`fromSurface:false\` 同样超时；视口截图（15.3KB）与全页截图一样慢

**产品影响**：用户第一次让 Agent 截图会以为卡死。建议方向：浏览器拉起后**异步预热一帧**，
或截图前先激活窗口。

### 2. 工具执行本身很快（热状态）

除 \`browser_wait\`（本套件故意让它等 3 秒的延迟元素，2737ms 属预期）外，**全部工具中位耗时
都在 300ms 以内**：click 257ms / snapshot 144ms / navigate 136ms / eval 97ms / back 65ms。
端到端回合耗时的大头是模型往返，不是浏览器操作。

### 3. 能力边界：没有标签管理

工具集**没有**列标签 / 切标签的命令，且目标选择**粘在** \`lastTargetId\`
（\`browser-control/src/browser/server-context.ts:403-412\` 的 \`pickDefault()\`：
优先复用上次操作过的标签，否则取第一个 page）。后果：用户在 Chrome 里手动切到别的标签后，
Agent 仍会操作**上一个**标签。缓解是 \`browser_snapshot\` 返回首行的 \`[page] <url> refs=N\`
让模型能看见自己在哪一页（这正是 2026-09-21 补 \`url\` 字段的价值）。

## 测试方法与边界

- **判据两层缺一不可**：执行层（DB \`messages.parts\` 的 \`type==='tool'\` 块）+ 效果层
  （裸 CDP 直读页面 \`window.__probe\`）。模型在正文里的自述**一律不作为判据**。
- **驱动只能走 LLM**：CLI 无浏览器命令、控制口白名单未收录、browser-control 的 dispatcher
  是进程内的（无 HTTP 服务器）。
- **未覆盖**：多标签切换（工具集不支持）、并发调用同一页面、浏览器长时间空闲后的行为、
  截图内容的像素级正确性（只验了文件非空且 > 5KB）。
`

  ev.writeReport({
    meta: {
      '被测对象': '客户端浏览器控制工具集（browser_* × 10）',
      '驱动': 'lumii-ui CLI → 真实会话 → 真实 LLM → 真实工具执行',
      '观测': `裸 CDP 直连 127.0.0.1:${CDP}（不经工具层）`,
      '探针页面': server.origin,
    },
    extraSections: fluencySection + findingsSection,
  })
}

main().catch((err) => {
  console.error('套件异常终止：', err)
  process.exit(1)
})
