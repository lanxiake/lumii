#!/usr/bin/env node
/**
 * check-notice-focus.mjs — 验「去审批」的深链（S3）
 *
 * 设计与实施：docs/plans/客户端UI/2026-09-23-Agent通知与审批闭环实施计划.md §四 S3
 *
 * ## 为什么单独一个脚本
 *
 * S2 验的是"通知**叫得动**"（气泡出现、可点、销账撤下）；S3 验的是"**送得到**"——
 * 点了「去审批」之后，人是不是真的站到了**那张卡**前面。后者会**点掉**那条通知
 * （`handleFocusNotice` 撤气泡），所以没法塞进 `check-agent-notice.mjs` 的判据序列里。
 *
 * ## 判据（读两边的 DOM，不看画面）
 *
 *   1. 气泡出现（前置：没有它后面无从谈起）
 *   2. **hover 上报把 `pet-bubble` 加进可点来源** —— 气泡是"指针压上来才吃事件"，
 *      不上报的话窗口还在穿透态，真实鼠标根本点不到它（DOM 的 `.click()` 会绕过这一层，
 *      所以这条必须单独验，否则"可点"是假的）
 *   3. 点击后**宠物窗气泡撤下**（点完不撤，用户会以为没反应）
 *   4. 点击后**主窗拿到焦点**（人被带到前台了）
 *   5. 主窗出现**高亮的审批卡**（`[data-highlight="true"]`）—— 这就是"送到卡前面"
 *   6. 高亮 ~2.5s 后**自己消失**（一次性意图，不是常驻选中态）
 *
 * ## 用法（客户端需带调试端口启动：`pnpm dev:debug`）
 *
 *   node verify/pet-sprite/check-notice-focus.mjs
 *   node verify/pet-sprite/check-notice-focus.mjs --keep
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const KEEP = process.argv.includes('--keep')
const AUTO_APPROVE_KEY = 'mtbot-auto-approve'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

// ── DOM 查询 ──────────────────────────────────────────────────────────────

const BUBBLES_JS = `(() => {
  return [...document.querySelectorAll('[data-pet-bubble]')].map((el) => ({
    kind: el.getAttribute('data-pet-bubble'),
    text: (el.textContent || '').trim(),
    button: (el.querySelector('button')?.textContent || '').trim(),
  }))
})()`

const CLICK_BUBBLE_BUTTON_JS = `(() => {
  const el = [...document.querySelectorAll('[data-pet-bubble="notice"]')][0]
  const btn = el?.querySelector('button')
  if (!btn) return false
  btn.click()
  return true
})()`

/** 高亮卡片的判据：`ConfirmationDialog` 根节点上的 `data-highlight`（别删，脚本靠它） */
const HIGHLIGHT_CARD_JS = `(() => {
  const el = document.querySelector('[data-highlight="true"]')
  return el ? (el.textContent || '').trim().slice(0, 80) : null
})()`

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
  // ---- 1. 就绪 ----
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

  // ---- 3. 造一条真审批 ----
  const created = await mainCdp.evaluate(
    `window.electronAPI.agentRuntime.sendCommand({ type: 'conversation:create', title: '[探针] 通知深链' })`,
  )
  probeKey = created?.sessionKey
  if (!probeKey) throw new Error(`创建 probe 会话失败: ${JSON.stringify(created)}`)
  console.log(`· probe 会话已建 sessionKey=${probeKey}`)

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
  console.log('· 已发送触发消息，等通知气泡…')

  let seen = null
  const until = Date.now() + 120_000
  while (Date.now() < until) {
    await sleep(2000)
    seen = (await petCdp.evaluate(BUBBLES_JS))?.find((b) => b.kind === 'notice') ?? null
    if (seen) break
  }
  record('气泡出现（前置）', Boolean(seen), seen ? `text="${seen.text}"` : '120s 内没等到')
  if (!seen) throw new Error('气泡没出现，后续判据无从谈起')

  // ---- 4. hover 上报 → 窗口切回可点 ----
  //
  // `.click()` 是 DOM API，绕过 `setIgnoreMouseEvents`；真实鼠标走的是另一条路
  // （mousemove 转发 → mouseenter → 上报 → 主进程开可点）。这条不验的话，
  // "可点"就只是纸面上的。
  //
  // ⚠️ 必须派发 **`mouseover`** 而不是 `mouseenter`：React 的 `onMouseEnter` 是**合成**的
  // （在 root 上监听 mouseout/mouseover 自己配对），派发原生 mouseenter 它收不到——
  // 首跑就是这么写的，判据一直是 false，看起来像功能坏了。
  await petCdp.evaluate(
    `(() => {
      const el = document.querySelector('[data-pet-bubble="notice"]')
      if (!el) return false
      el.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true,
        cancelable: true,
        relatedTarget: null,
      }))
      return true
    })()`,
  )
  await sleep(600)
  const ignoreState = await petCdp.evaluate(`window.electronAPI.pet.getMouseIgnoreState()`)
  record(
    'hover 上报后 pet-bubble 进可点来源',
    Boolean(ignoreState?.components?.includes('pet-bubble')),
    JSON.stringify(ignoreState),
  )

  // ---- 5. 点「去审批」----
  const clicked = await petCdp.evaluate(CLICK_BUBBLE_BUTTON_JS)
  record('点到了「去审批」按钮', clicked === true)

  await sleep(400)
  const bubblesAfterClick = (await petCdp.evaluate(BUBBLES_JS)) ?? []
  record(
    '点完气泡撤下（不是"点了没反应"）',
    !bubblesAfterClick.some((b) => b.kind === 'notice'),
    JSON.stringify(bubblesAfterClick),
  )

  // ---- 6. 主窗拿到焦点 + 那张卡被高亮 ----
  let focused = false
  let highlighted = null
  const focusUntil = Date.now() + 15_000
  while (Date.now() < focusUntil) {
    focused = Boolean(await mainCdp.evaluate(`document.hasFocus()`))
    highlighted = await mainCdp.evaluate(HIGHLIGHT_CARD_JS)
    if (focused && highlighted) break
    await sleep(500)
  }
  record('主窗被带到前台', focused, focused ? undefined : '15s 内主窗没拿到焦点')
  record(
    '审批卡被高亮（送到了那张卡前面）',
    Boolean(highlighted),
    highlighted ? `card="${highlighted}"` : '15s 内没看到 [data-highlight="true"]',
  )

  // ---- 7. 高亮是一次性的：自己熄掉 ----
  if (highlighted) {
    let clearedMs = null
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      if (!(await mainCdp.evaluate(HIGHLIGHT_CARD_JS))) {
        clearedMs = (i + 1) * 500
        break
      }
    }
    record(
      '高亮自己消失（一次性，不是常驻选中态）',
      clearedMs !== null,
      clearedMs === null ? '>10s 仍高亮' : `${clearedMs}ms 后消失`,
    )
  }

  // ---- 8. 清场 ----
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
  console.log('✓ 深链（点「去审批」→ 主窗前台 + 那张卡高亮）：实测通过')
} else {
  console.log('✗ 有判据未过——看上面逐条')
  process.exitCode = 1
}
