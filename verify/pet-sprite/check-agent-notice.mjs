#!/usr/bin/env node
/**
 * check-agent-notice.mjs — 验通知链路：气泡（S2）+ 系统通知与焦点广播（S4）
 *
 * 设计与实施：docs/plans/客户端UI/2026-09-23-Agent通知与审批闭环实施计划.md
 *
 * ## 为什么要有这个脚本
 *
 * S2 之前，宠物能把「Agent 在等你」**表现出来**（头顶符号），但**叫不动人**：
 * 没有一句话告诉用户"要你确认什么"，也没有任何可点的东西。这条链路的每一段
 * （事件 → pet-core 通知列表 → 编排器挑气泡 → DOM 气泡 → 销账撤下 → 系统通知）
 * 都只有单测覆盖，合起来能不能跑通没人验过。
 *
 * ## 判据（读宠物窗 DOM + 主进程日志，不看画面）
 *
 *   1. probe 会话挂起 permission 后，宠物窗出现**通知气泡**（`[data-pet-bubble="notice"]`）
 *   2. 气泡**带按钮**「去审批」—— 这是"可点"的 DOM 判据（"看得见、点不动"是设计里要消灭的状态）
 *   3. 文案**以 `description` 开头**—— 首跑实测到「执行 Shell 命令：执行命令：node -e …」
 *      这种冗余（工具中文名与 description 语义重叠，还把命令本身挤到截断之外），
 *      改法是"有 description 就用它"。这条断言就是那次修正的回归哨兵。
 *   4. 3s 后仍在（`action` 档气泡 8s TTL，不像状态句那样一闪而过）
 *   5. 响应 allow-once 后 **1s 内消失**（销账撤气泡，设计 §10.2）
 *   6. **`action` 档发出系统通知**，且 `convId` 是**那个会话**（S4）——
 *      不带 convId 的话用户点了只会把主窗拉到前台、不会切到会话，那正是 D1 的形态
 *   7. **主窗焦点广播已启用 / 可补问**（S4）：主进程日志里那行启动记录 + invoke 问得到
 *   8. **免打扰时段（S5）**：`action` 档**照叫但不冒气泡**，系统通知照发。
 *      时间不可控，用覆盖宠物窗 `Date.prototype.getHours` 造出"23 点"——
 *      验的是 orchestrator 那条接线，纯逻辑由 pet-core 单测覆盖
 *
 * ## 已知边界
 *
 * - **幂等（reload 不重冒）不在本脚本**：宠物窗 reload 会把内存态的 notices 清空，
 *   验出来的是"忘了"而不是"幂等"。真实重放场景（主窗重连补发）造不出来，
 *   由 `packages/pet-core/src/state/notice.test.ts` 的单测覆盖。
 * - **控制坞的待办区不在本脚本**：控制坞默认关着（产品取向：桌面上只放一只宠物），
 *   要展开得先走右键菜单。那块走手测。
 * - **`report` 档不发系统通知**这条没验（要造一个"跑满 90s 且主窗失焦"的回合，
 *   成本高而收益低——`notifyDesktop` 只在 action 分支上被调用，是代码可审的）。
 * - **D1 那条修复（任务完成通知补 `convId`）没实机验**：它要求主窗**失焦**
 *   （`ChatPage` 里有 `document.hasFocus()` 守卫），自动化环境里造不稳。
 *
 * ## 用法（客户端需带调试端口启动：`pnpm dev:debug`）
 *
 *   node verify/pet-sprite/check-agent-notice.mjs           # 一条龙
 *   node verify/pet-sprite/check-agent-notice.mjs --keep    # 出错时保留现场
 */
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const KEEP = process.argv.includes('--keep')
const AUTO_APPROVE_KEY = 'mtbot-auto-approve'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 主进程日志（判据 6/7 的来源）────────────────────────────────────────────

const LOG_PATH = join(
  homedir(),
  '.lumii',
  'logs',
  'app',
  `mtbot-${new Date().toISOString().slice(0, 10)}.log`,
)

/** 增量读日志：只取 `offset` 之后的部分（一天的日志可能几十 MB，别全量读） */
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

/**
 * 轮询日志直到出现目标串（或超时）。
 *
 * **必须轮询**：主进程写日志有块缓冲，`readLogFrom` 在事件刚发生就读**可能读到空的**——
 * 首版就是这么误判的："免打扰把系统通知也吞了"，其实那条通知发了、只是还没落盘。
 */
async function waitForLog(offset, needle, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const text = readLogFrom(offset)
    if (text.includes(needle)) return true
    await sleep(500)
  }
  return readLogFrom(offset).includes(needle)
}

/**
 * 挑一个时区名，让"现在"落在免打扰窗口（22:00–08:00）的正中。
 *
 * 用 `Etc/GMT±N` —— 注意 POSIX 是**反号**的：`Etc/GMT+3` 表示 UTC−3。
 * 目标是本地 3 点，所以偏移 = 3 − 当前 UTC 小时（对 24 取模）。
 */
function quietTimezoneId() {
  const utcHour = new Date().getUTCHours()
  const offset = (((3 - utcHour) % 24) + 24) % 24
  if (offset === 0) return 'UTC'
  return offset <= 12 ? `Etc/GMT-${offset}` : `Etc/GMT+${24 - offset}`
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

// ── 宠物窗 DOM 查询 ───────────────────────────────────────────────────────

/**
 * 通知气泡清单。
 *
 * 锚点是 `PetSpeechBubble` 根节点的 `data-pet-bubble` —— 必须靠它区分通道：
 * 控制坞的待办条目上也有同样文案的按钮（「去审批」），按按钮文字找会两条通道混在一起。
 */
const BUBBLES_JS = `(() => {
  return [...document.querySelectorAll('[data-pet-bubble]')].map((el) => ({
    kind: el.getAttribute('data-pet-bubble'),
    text: (el.textContent || '').trim(),
    button: (el.querySelector('button')?.textContent || '').trim(),
  }))
})()`

async function readBubbles(c) {
  try {
    return (await c.evaluate(BUBBLES_JS)) ?? []
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

try {
  // ---- 1. 宠物模式就绪 ----
  const mode = await post('/ipc/pet/getMode')
  const currentMode = typeof mode === 'string' ? mode : (mode?.mode ?? JSON.stringify(mode))
  if (currentMode !== 'pet') {
    console.log(`· 宠物模式当前=${currentMode}，切换到 pet`)
    await post('/ipc/pet/switchMode', { mode: 'pet' })
  }
  const petTarget = await waitForTarget((t) => t.url.includes('mode=pet'))
  if (!petTarget) throw new Error('等不到宠物窗口（CDP 目标 mode=pet）——宠物模式没起来？')
  petCdp = await connect(petTarget)
  const mainTarget = await waitForTarget((t) => !t.url.includes('mode=pet'))
  if (!mainTarget) throw new Error('等不到主窗口 CDP 目标')
  mainCdp = await connect(mainTarget)
  await sleep(2500)
  console.log('· 宠物窗口与主窗口 CDP 已连接')

  // ---- 2. 关自动审批（两处一起，见 check-foreign-attention.mjs 的说明）----
  savedAutoApprove = await mainCdp.evaluate(`localStorage.getItem(${JSON.stringify(AUTO_APPROVE_KEY)})`)
  if (savedAutoApprove !== 'false') {
    await mainCdp.evaluate(`localStorage.setItem(${JSON.stringify(AUTO_APPROVE_KEY)}, 'false')`)
    autoApproveTouched = true
    await reloadMainWindow()
    await sleep(2000)
    console.log(`· 自动审批已临时关闭（原值 ${JSON.stringify(savedAutoApprove)}，结束后恢复）`)
  } else {
    console.log('· 自动审批本来就是关的，不动它')
  }

  // ---- 3. 基线：不该有通知气泡 ----
  const baseline = await readBubbles(petCdp)
  record(
    '基线无通知气泡',
    !baseline.some((b) => b.kind === 'notice'),
    baseline.length ? JSON.stringify(baseline) : undefined,
  )

  // ---- 4. 新建 probe 会话并跑一条会触发审批的命令 ----
  //
  // 记下日志偏移：判据 6 要的是"这次跑出来的那条"，不是历史里的。
  const logOffset = logSize()
  const created = await mainCdp.evaluate(
    `window.electronAPI.agentRuntime.sendCommand({ type: 'conversation:create', title: '[探针] 通知链路' })`,
  )
  probeKey = created?.sessionKey
  if (!probeKey) throw new Error(`创建 probe 会话失败: ${JSON.stringify(created)}`)
  console.log(`· probe 会话已建 sessionKey=${probeKey}`)

  // requestId 只在事件里出现，DOM 上没有，事后补挂抓不到
  await mainCdp.evaluate(`(() => {
    window.__probePermissionEvents = []
    window.electronAPI.agentRuntime.onEvent((e) => {
      if (typeof e?.type === 'string' && e.type.startsWith('agent:permission')) {
        window.__probePermissionEvents.push({ type: e.type, requestId: e.requestId })
      }
    })
    return true
  })()`)

  const PROBE_TEXT =
    '[探针] 自动化验证用，请忽略对话内容本身：请用 Bash 工具执行 ' +
    'node -e "console.log(Date.now())"，然后把输出的数字原样回答我。' +
    '那个数字是当前时间戳，你不可能凭记忆得到——必须真的执行命令。'
  await post('/command', {
    type: 'user:send',
    sessionKey: probeKey,
    content: PROBE_TEXT,
    msgId: randomUUID(),
  })
  console.log('· 已向 probe 会话发送触发消息，开始轮询宠物窗 DOM…')

  // ---- 5. 轮询：等通知气泡出现 ----
  let seen = null
  let requestId = null
  const until = Date.now() + 120_000
  let lastBubbles = []
  while (Date.now() < until) {
    await sleep(2000)
    lastBubbles = await readBubbles(petCdp)
    if (!requestId) {
      const events = await mainCdp.evaluate(`window.__probePermissionEvents`)
      requestId = events?.find((e) => e.type === 'agent:permission:request')?.requestId ?? null
    }
    const hit = lastBubbles.find((b) => b.kind === 'notice')
    if (hit) {
      seen = hit
      break
    }
  }

  console.log(`· 轮询结束，最后一次气泡 = ${JSON.stringify(lastBubbles)}`)
  const collected = (await mainCdp.evaluate(`window.__probePermissionEvents`)) ?? []
  console.log(`· 期间收到的 permission 事件 = ${JSON.stringify(collected)}`)

  record('通知气泡出现', Boolean(seen), seen ? `text="${seen.text}"` : '120s 内没等到')
  record(
    '气泡带「去审批」按钮（可点）',
    seen?.button === '去审批',
    seen ? `button="${seen.button}"` : '气泡都没出现',
  )
  record(
    '文案用 description 本身（不前缀工具名）',
    Boolean(seen?.text?.startsWith('执行命令')),
    seen
      ? `text="${seen.text}"`
      : undefined,
  )

  if (seen) {
    // ---- 6. 3s 后仍在（action 档 8s TTL，不像状态句一闪而过）----
    await sleep(3000)
    const still = (await readBubbles(petCdp)).some((b) => b.kind === 'notice')
    record('3s 后仍在（真在等人，不是一闪而过）', still, still ? undefined : '提前消失了')

    // ---- 7. 响应"允许" → 期望 1s 内撤气泡 ----
    if (requestId) {
      console.log(`· 抓到 requestId=${requestId}，发 allow-once 应答…`)
      await mainCdp.evaluate(
        `window.electronAPI.agentRuntime.sendCommand({ type: 'user:permission:respond', requestId: ${JSON.stringify(requestId)}, decision: 'allow-once' })`,
      )
      let clearedMs = null
      for (let i = 0; i < 12; i++) {
        await sleep(250)
        const now = await readBubbles(petCdp)
        if (!now.some((b) => b.kind === 'notice')) {
          clearedMs = (i + 1) * 250
          break
        }
      }
      record(
        '响应后 1s 内撤气泡（销账生效）',
        clearedMs !== null && clearedMs <= 1000,
        clearedMs === null ? '>3s 仍挂着' : `${clearedMs}ms 消失`,
      )
    } else {
      record('响应后 1s 内撤气泡（销账生效）', false, '没抓到 requestId，无法应答')
    }
  }

  // ---- 7. 系统通知（S4）----
  //
  // 判据取**主进程日志**而不是"屏幕上有没有弹窗"：通知是 OS 级的东西，
  // 截图判据既不稳（可能被系统折叠）又依赖人看。`[DesktopNotify]` 那行里
  // title/body/convId 三样都在，足够判"发对了、且带对了会话"。
  // 日志有块缓冲，事件刚发生就读可能读到空的 → 轮询等它落盘
  await waitForLog(logOffset, '[DesktopNotify]')
  const lines = readLogFrom(logOffset)
    .split('\n')
    .filter((l) => l.includes('[DesktopNotify]'))
  const hit = lines.find((l) => probeKey && l.includes(`convId="${probeKey}"`))
  record(
    'action 档发出系统通知（S4）',
    lines.length > 0,
    lines.length > 0 ? lines[lines.length - 1].slice(0, 140) : '日志里没有 DesktopNotify',
  )
  record(
    '通知带上了会话（点了会跳过去）',
    Boolean(hit),
    hit ? undefined : `没找到 convId="${probeKey}"`,
  )

  // ---- 8. 主窗焦点广播（S4）----
  //
  // 它决定 `report` 档的两条判据（"用户发起后走开了"、"主窗失焦才补一句"）。
  // 只验"接通了"——真正的焦点变化需要人切窗口，自动化里造不稳。
  const allLog = readLogFrom(0)
  record(
    '主窗焦点广播已启用（S4）',
    allLog.includes('[mainWindowFocus] 已开始把主窗焦点变化转给宠物窗口'),
    allLog.includes('[mainWindowFocus] 拿不到主窗口')
      ? '主进程报了拿不到主窗——广播没挂上'
      : undefined,
  )
  // 补问通路：主进程只在**变化时**推，渲染层挂载那一刻的状态得自己问一次
  // （与 getIdleStage / getPerchRect 同一族）。这条只验"问得到"，
  // "值传到了编排器"由 shell 里的 ref 补喂保证（代码可审，四个同类先例）。
  const focusNow = await petCdp.evaluate(`window.electronAPI.pet.getMainWindowFocus()`)
  record(
    '主窗焦点可补问（挂载补问那条路）',
    typeof focusNow === 'boolean',
    `返回 ${JSON.stringify(focusNow)}`,
  )

  // ---- 9. 免打扰时段（S5）----
  //
  // ⚠️ 造"现在是深夜"必须用 **`Emulation.setTimezoneOverride`（渲染进程级）**，
  // **不能**覆盖 `Date.prototype.getHours`：CDP 的 `Runtime.evaluate` 跑在 **isolated world**
  // （preload 那个世界）里，改的是那个世界的 `Date`，而编排器在页面主世界——
  // 首版就是这么写的：探针里读回来是 23、宠物那边照样 14 点，于是"免打扰没生效"。
  // 时区是进程级的，两个世界一起变。（又一个"判据为假先怀疑判据本身"。）
  const quietTz = quietTimezoneId()
  await petCdp.send('Emulation.setTimezoneOverride', { timezoneId: quietTz })
  const quietHour = await petCdp.evaluate(`new Date().getHours()`)
  console.log(`· 时区切到 ${quietTz}，宠物窗现在 ${quietHour} 点`)
  const quietLogOffset = logSize()
  // 上一次的审批已经响应掉了，再要一次
  await post('/command', {
    type: 'user:send',
    sessionKey: probeKey,
    content: PROBE_TEXT,
    msgId: randomUUID(),
  })
  console.log('· 已在免打扰时段下再触发一次审批，观察 40s…')

  let quietPermissionSeen = false
  let quietBubbleSeen = false
  const quietUntil = Date.now() + 40_000
  while (Date.now() < quietUntil) {
    await sleep(2000)
    const events = (await mainCdp.evaluate(`window.__probePermissionEvents`)) ?? []
    const reqIds = new Set(
      events.filter((e) => e.type === 'agent:permission:request').map((e) => e.requestId),
    )
    if (reqIds.size > 1) quietPermissionSeen = true
    const bubbles = (await petCdp.evaluate(BUBBLES_JS)) ?? []
    if (bubbles.some((b) => b.kind === 'notice')) {
      quietBubbleSeen = true
      break
    }
  }
  // 恢复时区（不恢复的话后面任何依赖小时的判断都会失真）
  await petCdp.send('Emulation.setTimezoneOverride', { timezoneId: '' })

  record(
    '免打扰：确实来了新审批（前置）',
    quietPermissionSeen,
    quietPermissionSeen ? undefined : '40s 内没等到第二次 permission',
  )
  record(
    '免打扰：不冒气泡（S5）',
    !quietBubbleSeen,
    quietBubbleSeen ? '免打扰时段仍然冒了气泡' : undefined,
  )
  const quietNotified = await waitForLog(quietLogOffset, '[DesktopNotify]')
  record(
    '免打扰：系统通知照发（S5）',
    quietNotified,
    quietNotified ? undefined : '免打扰把系统通知也吞了——真卡住的事不能等到早上',
  )

  // ---- 10. 清场：删 probe 会话 + 恢复自动审批 ----
  //
  // ⚠️ 这一步**不能只在 catch 里做**。首跑时漏了它，结果是：自动审批被留成关闭
  // （改了用户的设置）、probe 会话留在列表里——而脚本还打印了"✓ 通过"。
  // 成功的路径同样需要清场。
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
  console.log('✓ 通知链路（事件 → 气泡 → 销账撤下）：实测通过')
} else {
  console.log('✗ 有判据未过——看上面逐条')
  process.exitCode = 1
}
