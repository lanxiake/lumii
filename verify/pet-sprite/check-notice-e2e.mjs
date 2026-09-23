#!/usr/bin/env node
/**
 * check-notice-e2e.mjs — 按**用户真实使用**的顺序跑一遍通知链路（S6 的端到端那一半）
 *
 * 设计与实施：docs/plans/客户端UI/2026-09-23-Agent通知与审批闭环实施计划.md §十.2 / §十二
 *
 * ## 为什么单独一个脚本
 *
 * `check-agent-notice.mjs` 是**判据表**式的（逐个造现场、逐个断言）；
 * 这个是**用户旅程**式的：按一个真实用户会做的事往下走，看宠物在该安静的时候安静、
 * 该出声的时候出声。两者互补——判据表保证每一环都对，旅程保证**合起来不烦人**。
 *
 * ## 模拟的旅程与判据
 *
 *   1. 用户发一句轻任务（"回一句就行"）→ **零气泡**（不打扰：`turn:end` 没跑满 90s、
 *      也没有 `task_complete`，就不该有任何东西冒出来）
 *   2. 用户发一个任务并让它用 `task_complete` 收尾 → 宠物冒一句**摘要本身**
 *      （`report` 档**不发**系统通知——那是 `action` 档的特权，见设计 §5.1）
 *   3. 用户去设置里关掉「Agent 通知」→ 再有事（一条真审批）也**什么都不该出现**
 *
 * ## 已知边界
 *
 * - **"点系统通知跳转"验不了**：那要真的去点 OS 通知气泡，自动化里做不到。
 *   退到验"`convId` 传对了"（`check-agent-notice.mjs` 的判据）+ `conversation:navigate`
 *   的既有处理。**手测办法**见实施文档 §10.4。
 * - **报告档的两条焦点判据**（"用户发起后走开"）没单独造：要先把主窗弄聚焦再让它失焦，
 *   自动化里不稳。而实测环境里主窗**天然失焦**（宠物窗覆盖全屏），所以走的是另一条升级路径。
 *
 * ## 用法（客户端需带调试端口启动：`pnpm dev:debug`）
 *
 *   node verify/pet-sprite/check-notice-e2e.mjs
 *   node verify/pet-sprite/check-notice-e2e.mjs --keep
 */
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const KEEP = process.argv.includes('--keep')
const AUTO_APPROVE_KEY = 'mtbot-auto-approve'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const LOG_PATH = join(
  homedir(),
  '.lumii',
  'logs',
  'app',
  `mtbot-${new Date().toISOString().slice(0, 10)}.log`,
)

function readLogFrom(offset) {
  try {
    const { size } = statSync(LOG_PATH)
    if (size <= offset) return ''
    const fd = openSync(LOG_PATH, 'r')
    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    closeSync(fd)
    return buf.toString('utf-8')
  } catch {
    return ''
  }
}
function logSize() {
  try {
    return statSync(LOG_PATH).size
  } catch {
    return 0
  }
}
/** 日志有块缓冲：轮询等目标串落盘，读一次就下结论会得到假红 */
async function waitForLog(offset, needle, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (readLogFrom(offset).includes(needle)) return true
    await sleep(500)
  }
  return readLogFrom(offset).includes(needle)
}

// ── 控制口 ────────────────────────────────────────────────────────────────

const cfg = JSON.parse(readFileSync(join(homedir(), '.lumii', 'runtime', 'app-ui.json'), 'utf-8'))
async function post(route, body) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body ?? {}),
  })
  return res.json()
}

// ── CDP ──────────────────────────────────────────────────────────────────

async function targets() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  return list.filter((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:5174'))
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'))
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    const hit = pending.get(msg.id)
    if (hit) {
      pending.delete(msg.id)
      hit(msg)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const myId = ++id
      pending.set(myId, resolve)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) {
      throw new Error(`CDP evaluate 异常: ${r.result.exceptionDetails.text}`)
    }
    return r.result?.result?.value
  }
  return { send, evaluate, close: () => ws.close() }
}

async function waitForTarget(pred, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const t = (await targets()).find(pred)
    if (t) return t
    await sleep(400)
  }
  return null
}

// ── 宠物窗 DOM ────────────────────────────────────────────────────────────

const BUBBLES_JS = `(() => {
  return [...document.querySelectorAll('[data-pet-bubble]')].map((el) => ({
    kind: el.getAttribute('data-pet-bubble'),
    text: (el.textContent || '').trim(),
  }))
})()`

async function readNoticeBubbles(c) {
  try {
    return ((await c.evaluate(BUBBLES_JS)) ?? []).filter((b) => b.kind === 'notice')
  } catch {
    return []
  }
}

// ── 流程 ──────────────────────────────────────────────────────────────────

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

let mainCdp = null
let petCdp = null
let probeKey = null
let savedAutoApprove = null
let autoApproveTouched = false

/** 主窗重载 + 重连（reload 后旧连接会失效） */
async function reloadMainWindow() {
  mainCdp?.close()
  mainCdp = null
  const t0 = await waitForTarget((t) => !t.url.includes('mode=pet'))
  if (!t0) throw new Error('reload 前找不到主窗目标')
  const tmp = await connect(t0)
  await tmp.send('Page.enable')
  await tmp.send('Page.reload', {})
  tmp.close()
  await sleep(3500)
  const t1 = await waitForTarget((t) => !t.url.includes('mode=pet'))
  if (!t1) throw new Error('reload 后找不到主窗目标')
  mainCdp = await connect(t1)
}

async function cleanup() {
  // 开关先恢复：它影响的是"用户体验"，不能留着
  try {
    await mainCdp?.evaluate(
      `window.electronAPI.pet.setVirtualHumanSettings({ enableAgentNotice: true })`,
    )
  } catch {
    /* 主窗可能已经断了 */
  }
  if (probeKey) {
    try {
      await post('/command', { type: 'user:abort', sessionKey: probeKey })
      await sleep(500)
      await mainCdp?.evaluate(
        `window.electronAPI.agentRuntime.sendCommand({ type: 'conversation:delete', sessionKey: ${JSON.stringify(probeKey)} })`,
      )
      console.log(`· probe 会话已中断并删除 sessionKey=${probeKey}`)
    } catch (e) {
      console.log(`· ⚠ probe 会话清理失败（请手工删除 ${probeKey}）：${e.message}`)
    }
    probeKey = null
  }
  if (autoApproveTouched && savedAutoApprove !== null) {
    try {
      await mainCdp?.evaluate(
        `localStorage.setItem(${JSON.stringify(AUTO_APPROVE_KEY)}, ${JSON.stringify(savedAutoApprove)})`,
      )
      await reloadMainWindow()
      console.log(`· 自动审批设置已恢复为 ${savedAutoApprove}`)
    } catch (e) {
      console.log(`· ⚠ 恢复自动审批失败（请手工检查设置开关）：${e.message}`)
    }
    autoApproveTouched = false
  }
}

/**
 * 发一条用户消息。**只负责发，不负责等**——各场景自己轮询自己的判据。
 *
 * ⚠️ 首版这里做了"等到本轮 turn:end"，用的是主窗事件流里的 `turn:start/turn:end` 序列。
 * 那个判据**有竞态**：场景 1 的收尾事件可能滞后到场景 2 才被 push 进来，于是场景 2
 * 立刻以为"自己的回合结束了"而提前返回 —— 后面的场景 3 便在场景 2 的 `task_complete`
 * **之前**关掉了开关，把三条判据一起弄红（真实原因是脚本，不是产品）。
 * 改成"只发不等"：判据本来就该由"气泡有没有出现"来回答，不需要知道回合何时结束。
 */
async function sendUserMessage(text) {
  // 挂一次事件收集器（幂等：重复挂只是多记一遍，用于"审批确实发生了"这类前置判据）
  await mainCdp.evaluate(`(() => {
    if (window.__e2eHooked) return true
    window.__e2eHooked = true
    window.__e2ePerms = 0
    window.electronAPI.agentRuntime.onEvent((e) => {
      if (e?.type === 'agent:permission:request') window.__e2ePerms = (window.__e2ePerms || 0) + 1
    })
    return true
  })()`)
  await post('/command', { sessionKey: probeKey, content: text, msgId: randomUUID(), type: 'user:send' })
}

try {
  // ---- 0. 就绪 ----
  const mode = await post('/ipc/pet/getMode')
  const currentMode = typeof mode === 'string' ? mode : (mode?.mode ?? JSON.stringify(mode))
  if (currentMode !== 'pet') {
    console.log(`· 宠物模式当前=${currentMode}，切换到 pet`)
    await post('/ipc/pet/switchMode', { mode: 'pet' })
  }
  const petTarget = await waitForTarget((t) => t.url.includes('mode=pet'))
  if (!petTarget) throw new Error('等不到宠物窗口——宠物模式没起来？')
  petCdp = await connect(petTarget)
  const mainTarget = await waitForTarget((t) => !t.url.includes('mode=pet'))
  if (!mainTarget) throw new Error('等不到主窗口 CDP 目标')
  mainCdp = await connect(mainTarget)
  await sleep(2500)

  const created = await mainCdp.evaluate(
    `window.electronAPI.agentRuntime.sendCommand({ type: 'conversation:create', title: '[探针] 通知端到端' })`,
  )
  probeKey = created?.sessionKey
  if (!probeKey) throw new Error(`创建会话失败: ${JSON.stringify(created)}`)
  console.log(`· 会话已建 sessionKey=${probeKey}`)

  // ============ 场景 1：轻任务不该被打扰 ============
  console.log('\n【场景 1】用户发一句轻任务 —— 期望：宠物什么都不说')
  const log1 = logSize()
  await sendUserMessage('请只回复「收到」两个字，不要调用任何工具。')
  // 等这一轮跑完再下结论（轻任务几秒就好；20s 也给"该冒的东西"足够机会冒出来）
  await sleep(20_000)
  const afterQuiet = await readNoticeBubbles(petCdp)
  record(
    '轻任务零气泡（不打扰）',
    afterQuiet.length === 0,
    afterQuiet.length ? JSON.stringify(afterQuiet) : undefined,
  )
  record(
    '轻任务不发系统通知',
    !readLogFrom(log1).includes('[DesktopNotify]'),
    undefined,
  )

  // ============ 场景 2：任务完成要说一声 ============
  console.log('\n【场景 2】用户发一个用 task_complete 收尾的任务 —— 期望：冒一句摘要 + 系统通知')
  const log2 = logSize()
  /**
   * ⚠️ 这一段**依赖模型配合**（它得真的去调 `task_complete`），所以给一次重试。
   *
   * 实测遇到过：同一句提示词，第一轮调了、第二轮没调——那是模型行为，不是产品缺陷。
   * 不重试的话脚本会随机变红，而红的原因与被测对象无关（"判据为假先怀疑判据本身"
   * 在这里的形态是：**先确认现场真的造出来了**）。
   */
  let doneBubble = null
  let attempts = 0
  for (let attempt = 1; attempt <= 2 && !doneBubble; attempt++) {
    attempts = attempt
    await sendUserMessage(
      attempt === 1
        ? '请调用 task_complete 工具来结束这一轮，summary 参数写「E2E 已完成」。不要调用任何别的工具。'
        : '请立刻调用 task_complete 工具，summary 参数写「E2E 已完成」。这是这一轮唯一的要求。',
    )
    // `task_complete` 还有道**验证门**：第一次调用会被要求"再调一次"才放行，所以给足时间
    const doneUntil = Date.now() + 70_000
    while (Date.now() < doneUntil) {
      doneBubble = (await readNoticeBubbles(petCdp)).find((b) => b.text.includes('E2E 已完成')) ?? null
      if (doneBubble) break
      await sleep(2000)
    }
    if (!doneBubble && attempt === 1) console.log('· 这一轮模型没调 task_complete，重试一次…')
  }
  // 前置判据：把"模型没配合"与"产品缺陷"分开。
  // 这条红了 = 现场压根没造出来，**别去改产品代码**（"判据为假先怀疑判据本身"）。
  const taskDoneInLog = readLogFrom(log2).includes('\\"status\\":\\"completed\\"')
  record(
    '（前置）模型真的调了 task_complete 且拿到了 completed',
    taskDoneInLog,
    taskDoneInLog ? undefined : '模型没配合——这条红了不代表产品有问题',
  )
  record(
    '任务完成冒出摘要气泡',
    Boolean(doneBubble),
    doneBubble
      ? `text="${doneBubble.text}"（第 ${attempts} 次尝试）`
      : `试了 ${attempts} 次都没冒——先看上面那条前置判据`,
  )
  // 设计 §5.1：系统通知是 **`action` 档的特权**——"`report` 的语义是顺便告诉你一声，
  // 给它最强的通道等于把'任务完成'变成需要处理的待办"。所以这条的期望是**不出现**。
  //
  // ⚠️ 主窗另有一条「MtBot · 任务已完成」的系统通知（D1，且只在主窗失焦时发）——
  // 那是**另一条链路**，判据要按**宠物侧的标题**匹配，别把两者混起来。
  // （首版写的是"应该出现"，于是无论跑多少次都是红的。）
  const petNotified = readLogFrom(log2).includes('Lumii · 需要你确认')
  record(
    'report 档不发系统通知（设计 §5.1）',
    !petNotified,
    petNotified ? '任务完成不该走系统通知通道' : undefined,
  )

  // 让这一轮彻底收尾再进场景 3：否则它可能还在跑，被场景 3 关掉的开关挡住，
  // 变成"场景 2 失败 + 场景 3 假通过"——首版就是这么互相污染的。
  await sleep(5000)

  // ============ 场景 3：关掉开关就彻底安静 ============
  console.log('\n【场景 3】用户在设置里关掉「Agent 通知」—— 期望：连审批都不出现')
  // 关自动审批，好让审批真的挂住
  savedAutoApprove = await mainCdp.evaluate(`localStorage.getItem(${JSON.stringify(AUTO_APPROVE_KEY)})`)
  if (savedAutoApprove !== 'false') {
    await mainCdp.evaluate(`localStorage.setItem(${JSON.stringify(AUTO_APPROVE_KEY)}, 'false')`)
    autoApproveTouched = true
    await reloadMainWindow()
    await sleep(2000)
  }
  await mainCdp.evaluate(`window.electronAPI.pet.setVirtualHumanSettings({ enableAgentNotice: false })`)
  await sleep(1500)
  const log3 = logSize()
  await sendUserMessage('请用 Bash 工具执行 node -e "console.log(42)"，然后把结果告诉我。')
  // 审批会挂住 → 这轮不会结束；等够时间让"该弹的"有机会弹
  await sleep(25_000)
  const perms = (await mainCdp.evaluate(`window.__e2ePerms ?? 0`)) ?? 0
  const afterOff = await readNoticeBubbles(petCdp)
  record('（前置）确实发生了审批', perms > 0, `permission:request 计数=${perms}`)
  record(
    '关掉开关后零气泡',
    afterOff.length === 0,
    afterOff.length ? JSON.stringify(afterOff) : undefined,
  )
  record(
    '关掉开关后不发系统通知',
    !readLogFrom(log3).includes('Lumii · 需要你确认'),
    undefined,
  )

  // ---- 清场 ----
  console.log('')
  await cleanup()
} catch (err) {
  console.error(`\n✗ 执行出错：${err.message}`)
  if (!KEEP) {
    console.log('· 出错也做一遍清场（--keep 可保留现场）')
    await cleanup().catch(() => {})
  }
} finally {
  petCdp?.close()
  mainCdp?.close()
}

const passed = results.filter((r) => r.pass).length
console.log(`\n===== 判定：${passed}/${results.length} 通过 =====`)
if (passed === results.length) {
  console.log('✓ 用户旅程：该安静时安静、该出声时出声')
} else {
  console.log('✗ 有判据未过——看上面逐条')
  process.exitCode = 1
}
