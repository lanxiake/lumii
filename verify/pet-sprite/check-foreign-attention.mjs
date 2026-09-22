#!/usr/bin/env node
/**
 * check-foreign-attention.mjs — 验「别的会话在等你出手」跨会话抢占头顶符号（带来源角标）
 *
 * 覆盖 febe813f（多 Agent/会话并发）里唯一没实测到的一支：当时造不出
 * 「别的会话触发 permission」的现场，来源角标只有单测覆盖。本脚本把它补上，
 * 并在第一次跑通时**顺带发现了一个真缺陷**（见下）。
 *
 * ## 判据（读宠物窗 DOM，不看画面）
 *
 *   1. probe 会话挂起 permission 后，宠物头顶出现 alert 档符号
 *   2. 该符号 `aria-label` = 「另一个会话在等你确认」，且**带来源角标**（内部小块 span）
 *   3. 出现后 3s 仍挂着 —— 证明它真的在等人，不是被自动放行后还留着的残影
 *   4. 响应（allow-once）后 2s 内销账 —— 走真实事件链路，不是靠删会话强行拔线
 *   5. 清场后符号消失（对照组，排除"它本来就挂着"的假阳性）
 *
 * ## 缺陷与修复（2026-09-22，本脚本首跑发现）
 *
 * 首跑时发现符号**在自动放行后仍会亮**：`granted/denied/timeout` 这族解除事件
 * 在客户端生产链路上**零产出**（内核不发；`requestPermission` 的各出口只返回决策
 * 不广播），于是 `session-activity` 的 waiting 只能靠 `turn:end` 兜底 ——
 * 表现为「另一个会话在等你确认」的误报，而那个会话根本没在等。
 * 修复：`bridge-instance-factory` 的 `requestPermission` 在**全部出口**统一广播
 * `forwardPermissionResolved`（见 `bridge-permission-ipc-forward.ts`）。
 *
 * ⚠️ 关自动审批要**两处一起**：
 *   · 主进程 `user:auto-approve:set`（内存态）
 *   · 渲染层 localStorage `mtbot-auto-approve`（ChatPage 的兜底自动审批读它，
 *     `useAnyPendingPermission` 对**任意会话**生效——只关主进程那一半，
 *     probe 的 permission 会在毫秒级被兜底放行，符号根本立不住）
 * 本脚本改 localStorage 后 `Page.reload` 让 ChatPage 重新读；结束时按原值恢复。
 *
 * ## 用法（客户端需带调试端口启动：`pnpm dev:debug`）
 *
 *   node verify/pet-sprite/check-foreign-attention.mjs            # 一条龙（人工等待语义）
 *   node verify/pet-sprite/check-foreign-attention.mjs --keep-aa  # 对照实验：自动审批原样
 *                                                                 # （修复后应**看不到**符号）
 *   node verify/pet-sprite/check-foreign-attention.mjs --keep     # 出错时保留现场
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const KEEP = process.argv.includes('--keep')
/** 对照实验：不动自动审批，观察默认设置下的行为（修复后应无符号） */
const KEEP_AA = process.argv.includes('--keep-aa')
const AUTO_APPROVE_KEY = 'mtbot-auto-approve'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 控制口 ────────────────────────────────────────────────────────────────

const cfg = JSON.parse(
  readFileSync(join(homedir(), '.lumii', 'runtime', 'app-ui.json'), 'utf-8'),
)
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
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
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
 * 头顶符号清单。`PetStatusGlyph` 是 `role=img` + `aria-label` 的 div，
 * 来源角标是它内部那个 `aria-hidden` 的小块（见 `PetStatusGlyph.tsx`）。
 */
const GLYPHS_JS = `(() => {
  return [...document.querySelectorAll('[role="img"][aria-label]')].map((g) => ({
    label: g.getAttribute('aria-label'),
    char: (g.textContent || '').trim(),
    hasBadge: !!g.querySelector('span[aria-hidden="true"]'),
  }))
})()`

async function readGlyphs(c) {
  try {
    return (await c.evaluate(GLYPHS_JS)) ?? []
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
  // 用一个短命连接发 reload（主窗 target 不变，但连接是 per-page 的）
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

  // ---- 2. 关自动审批（两处一起，见文件头注释）----
  savedAutoApprove = await mainCdp.evaluate(`localStorage.getItem(${JSON.stringify(AUTO_APPROVE_KEY)})`)
  if (!KEEP_AA) {
    if (savedAutoApprove !== 'false') {
      await mainCdp.evaluate(`localStorage.setItem(${JSON.stringify(AUTO_APPROVE_KEY)}, 'false')`)
      autoApproveTouched = true
      await reloadMainWindow()
      await sleep(2000)
      console.log(`· 自动审批已临时关闭（原值 ${JSON.stringify(savedAutoApprove)}，结束后恢复）`)
    } else {
      console.log('· 自动审批本来就是关的，不动它')
    }
  } else {
    console.log('· --keep-aa：自动审批原样不动（对照实验）')
  }

  // ---- 3. 基线：不该有某个会话在等你 ----
  const subjectKey = await mainCdp.evaluate(`window.electronAPI.pet.getActiveSessionKey()`)
  const baseline = await readGlyphs(petCdp)
  console.log(`· 主体会话（宠物绑定）= ${subjectKey ?? '(空)'}`)
  console.log(`· 基线头顶符号 = ${JSON.stringify(baseline)}`)
  const foreignLabel = '另一个会话在等你确认'
  record(
    '基线无跨会话告警',
    !baseline.some((g) => g.label === foreignLabel),
    baseline.some((g) => g.label === foreignLabel) ? '启动时就有该符号，判据会失真' : undefined,
  )

  // ---- 4. 新建 probe 会话并发送触发消息 ----
  const created = await mainCdp.evaluate(
    `window.electronAPI.agentRuntime.sendCommand({ type: 'conversation:create', title: '[探针] 跨会话抢占-来源角标' })`,
  )
  probeKey = created?.sessionKey
  if (!probeKey) throw new Error(`创建 probe 会话失败: ${JSON.stringify(created)}`)
  console.log(`· probe 会话已建 sessionKey=${probeKey}`)

  // 事件收集器先挂上再发消息：requestId 只在事件里出现，DOM 上没有，事后补挂抓不到
  await mainCdp.evaluate(`(() => {
    window.__probePermissionEvents = []
    window.electronAPI.agentRuntime.onEvent((e) => {
      if (typeof e?.type === 'string' && e.type.startsWith('agent:permission')) {
        window.__probePermissionEvents.push({
          type: e.type,
          requestId: e.requestId,
          rootSessionKey: e.rootSessionKey,
        })
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

  // ---- 5. 轮询：等来源角标出现 ----
  let seen = null
  let requestId = null
  // 对照实验只需证明「不出现」，等不到就是结论，不必耗满 120s
  const until = Date.now() + (KEEP_AA ? 45_000 : 120_000)
  let lastGlyphs = []
  while (Date.now() < until) {
    await sleep(2000)
    lastGlyphs = await readGlyphs(petCdp)
    if (!requestId) {
      const events = await mainCdp.evaluate(`window.__probePermissionEvents`)
      requestId = events?.find((e) => e.type === 'agent:permission:request')?.requestId ?? null
    }
    const hit = lastGlyphs.find((g) => g.label === foreignLabel)
    if (hit) {
      seen = hit
      break
    }
  }

  console.log(`· 轮询结束，最后一次头顶符号 = ${JSON.stringify(lastGlyphs)}`)
  const collected = (await mainCdp.evaluate(`window.__probePermissionEvents`)) ?? []
  console.log(`· 期间收到的 permission 事件 = ${JSON.stringify(collected)}`)
  record('跨会话告警符号出现', Boolean(seen), seen ? `char=${seen.char}` : '120s 内没等到')
  record(
    '符号带来源角标',
    Boolean(seen?.hasBadge),
    seen ? (seen.hasBadge ? '角标在' : '符号在但角标没渲染') : '符号都没出现',
  )

  if (seen) {
    // ---- 6. 出现后先等 3s：证明真的在等（没被自动放行）----
    await sleep(3000)
    const still = (await readGlyphs(petCdp)).some((g) => g.label === foreignLabel)
    record('3s 后仍挂着（真在等人）', still, still ? undefined : '被自动放行/一闪而过')

    if (KEEP_AA) {
      // 对照实验：审批已被兜底放行，只追踪何时消失（修复正确的表现应为「压根不出现」）
      console.log('· 对照实验：不人工响应，追踪符号何时自然消失')
      let clearedMs = null
      for (let i = 0; i < 90; i++) {
        await sleep(1000)
        const now = await readGlyphs(petCdp)
        if (!now.some((g) => g.label === foreignLabel)) {
          clearedMs = (i + 1) * 1000
          break
        }
      }
      console.log(
        `· 符号从复核点起持续 ${clearedMs === null ? '>90s（超出观测窗）' : `${(clearedMs / 1000).toFixed(1)}s 后消失`}`,
      )
    } else if (requestId) {
      // ---- 7. 人工响应（点"允许"）→ 期望立即销账 ----
      console.log(`· 抓到 requestId=${requestId}，发 allow-once 应答…`)
      await mainCdp.evaluate(
        `window.electronAPI.agentRuntime.sendCommand({ type: 'user:permission:respond', requestId: ${JSON.stringify(requestId)}, decision: 'allow-once' })`,
      )
      let clearedMs = null
      for (let i = 0; i < 12; i++) {
        await sleep(500)
        const now = await readGlyphs(petCdp)
        if (!now.some((g) => g.label === foreignLabel)) {
          clearedMs = (i + 1) * 500
          break
        }
      }
      record(
        '响应后 2s 内销账',
        clearedMs !== null && clearedMs <= 2000,
        clearedMs === null ? '>6s 仍挂着' : `${clearedMs}ms 消失`,
      )
    } else {
      record('响应后 2s 内销账', false, '没抓到 requestId，无法应答')
    }
  }

  // ---- 8. 清场并复核（对照组）----
  await cleanup()
  await sleep(2000)
  const after = await readGlyphs(petCdp)
  record(
    '清场后符号消失',
    !after.some((g) => g.label === foreignLabel),
    JSON.stringify(after),
  )
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
  console.log('✓ 跨会话抢占的来源角标：链路与呈现实测通过')
} else {
  console.log('✗ 有判据未过——看上面逐条')
  process.exitCode = 1
}
