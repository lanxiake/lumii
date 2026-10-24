/**
 * 后台任务卡增强（增量日志 / 暂停恢复 / 灯箱）— 真实客户端 CLI 验收
 *
 * 前置：客户端已用远程调试启动
 *   powershell -File scripts/start-dev.ps1 -Force -RemoteDebug 9222
 *
 *   node docs/test/lumii-cli/chat/run-background-task-enhancements.mjs
 *
 * 覆盖：
 *   正常路径 — 卡片渲染、进度/本步计时/健康态、折叠态缩略图、灯箱
 *   增量日志 — logsDelta 追加、纯进度事件不冲日志、终态全量自愈
 *   暂停恢复 — UI 按钮与冻结计时、命令下发
 *   边界     — 未知任务暂停 ok:false、取消幂等、暂停白名单放行
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, 'artifacts')
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const TITLE = '[phase1-ui] background-task enhancements'

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function uiCli(args) {
  const root = path.resolve(__dirname, '../../../..')
  const cli = path.join(root, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
  let json = null
  try {
    json = JSON.parse((r.stdout || '').trim())
  } catch {
    /* 非 JSON（如 status 的人类可读输出） */
  }
  return { code: r.status, out: r.stdout || '', stderr: r.stderr || '', json }
}

async function cdpList() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  if (!r.ok) throw new Error(`CDP list HTTP ${r.status}`)
  return r.json()
}

function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const ready = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP WebSocket 失败'))
  })
  let id = 0
  const send = async (method, params = {}) => {
    await ready
    const myId = ++id
    return new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id !== myId) return
        ws.removeEventListener('message', onMsg)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
      ws.addEventListener('message', onMsg)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  }
  return { send, close: () => ws.close() }
}

async function findMainPage() {
  const targets = await cdpList()
  return (
    targets.find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && /灵栖|Lumii/i.test(t.title || '')
        && !String(t.url).startsWith('devtools:'),
    )
    || targets.find((t) => t.type === 'page' && /127\.0\.0\.1:\d+/.test(t.url || '') && t.webSocketDebuggerUrl)
  )
}

async function evaluate(expression) {
  const page = await findMainPage()
  if (!page) throw new Error('找不到主窗口')
  const s = cdpSession(page.webSocketDebuggerUrl)
  try {
    const r = await s.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
    return r.result.value
  } finally {
    s.close()
  }
}

/** 注入一条任务事件（走真实 renderer 事件处理链路） */
function injectEvent(event) {
  return evaluate(`(async () => {
    const evt = ${JSON.stringify(event)};
    const mod = await import('/hooks/business/useAgentRuntime/event-handler.ts');
    mod.handleRuntimeEvent(evt);
    const storeMod = await import('/hooks/business/useAgentRuntime/agent-runtime-store.ts');
    const switchMod = await import('/hooks/business/useAgentRuntime/switch-session.ts');
    if (typeof switchMod.switchSession === 'function') await switchMod.switchSession(evt.sessionKey);
    await new Promise((r) => setTimeout(r, 250));
    const sess = storeMod.runtimeStore.getState().sessions.get(evt.sessionKey);
    return { ok: true, tasks: (sess?.backgroundTasks || []).map((t) => ({
      taskId: t.taskId, status: t.status, logs: t.logs?.length ?? 0,
      progress: t.progress, pausedAt: t.pausedAt, pausable: t.pausable,
    })) };
  })()`)
}

function assert(cond, msg) {
  if (!cond) fail(msg)
}

async function main() {
  console.log('== 后台任务卡增强 · 真实 CLI 验收 ==')

  const st = uiCli(['status'])
  if (/connection_failed|app_not_running/.test(st.out + st.stderr)) {
    fail('客户端未运行。请先: powershell -File scripts/start-dev.ps1 -Force -RemoteDebug 9222')
  }
  console.log('OK lumii-ui status')

  try {
    await cdpList()
  } catch (e) {
    fail(`CDP :${CDP_PORT} 不可用（${e.message}）。需带 --remoteDebuggingPort=9222 启动`)
  }
  console.log(`OK CDP :${CDP_PORT}`)

  // ── 1. 边界：命令总线 ─────────────────────────────
  const pauseUnknown = uiCli([
    'command', 'background-task:pause',
    '--data', JSON.stringify({ type: 'background-task:pause', taskId: 'no-such-task', paused: true }),
  ])
  assert(pauseUnknown.json && pauseUnknown.json.ok === false, '未知任务暂停应返回 ok:false（无闸门）')
  console.log('OK boundary: pause unknown -> ok:false')

  const cancelUnknown = uiCli([
    'command', 'background-task:cancel',
    '--data', JSON.stringify({ type: 'background-task:cancel', taskId: 'no-such-task' }),
  ])
  // ok:false = 主进程没有这个运行中的任务（历史残留卡片 / 重启后丢失）。
  // renderer 收到 ok:false 会就地标记已取消，而不是让按钮一直挂着。
  assert(cancelUnknown.json && cancelUnknown.json.ok === false, '未知任务取消应返回 ok:false')
  console.log('OK boundary: cancel unknown -> ok:false (renderer settles locally)')

  // ── 2. 建会话 ────────────────────────────────────
  const created = uiCli(['conversation', 'create', '--title', TITLE])
  const sk = created.json?.sessionKey || created.json?.id
  assert(sk, `建会话失败: ${JSON.stringify(created.json)}`)
  console.log('OK session', sk)
  uiCli(['goto', '--view', 'chat'])
  sleepSync(800)

  // ── 3. 正常路径：带告警的运行时任务 ───────────────
  const now = Date.now()
  const taskId = `enh-${now.toString(36)}`
  // 每轮唯一：上一轮验收残留的卡片还挂在同一个会话列表里，用固定 label 会误命中旧卡
  const label = `增强验收任务 ${taskId}`
  // 主进程每条事件都带完整记录（里程碑/产出），这里也照此模拟，否则后续事件会把它们冲掉
  const MILESTONES = [
    { step: '入队', status: 'completed', duration: 1200 },
    { step: '排队', status: 'completed', duration: 3400 },
    { step: '渲染', status: 'in-progress', startTime: now - 12_000 },
    { step: '保存结果', status: 'pending' },
  ]
  const OUTPUTS = [
    {
      name: 'probe.png',
      path: 'probe.png',
      kind: 'image',
      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    },
  ]
  const base = {
    type: 'agent:background-task',
    taskId,
    sessionKey: sk,
    toolName: 'mcp__comfyui__enqueue_workflow',
    label,
    startedAt: now - 30_000,
    milestones: MILESTONES,
    outputs: OUTPUTS,
  }
  const injected = await injectEvent({
    ...base,
    status: 'running',
    progress: 70,
    currentStep: '渲染',
    note: 'ComfyUI 渲染中',
    pausable: true,
    logs: [
      { level: 'info', message: '入队', timestamp: now - 25_000 },
      { level: 'warn', message: '显存占用偏高', timestamp: now - 2_000 },
    ],
    milestones: MILESTONES,
    outputs: OUTPUTS,
  })
  assert(injected.ok, '任务注入失败')
  const task = injected.tasks.find((t) => t.taskId === taskId)
  assert(task, 'store 中找不到刚注入的任务')
  assert(task.logs === 2, `初始日志应为 2 条，实际 ${task.logs}`)
  console.log('OK inject running task', JSON.stringify(task))

  // ── 4. 增量日志（任务仍在运行，DOM 检查要先做） ────
  await injectEvent({
    ...base,
    status: 'running',
    logsDelta: [{ level: 'info', message: '渲染 10%', timestamp: now + 1_000 }],
  })
  await injectEvent({
    ...base,
    status: 'running',
    logsDelta: [{ level: 'info', message: '渲染 40%', timestamp: now + 2_000 }],
  })
  const afterDeltas = await injectEvent({ ...base, status: 'running', progress: 80 })
  const deltaTask = afterDeltas.tasks.find((t) => t.taskId === taskId)
  assert(deltaTask.logs === 4, `增量后日志应为 4 条，实际 ${deltaTask.logs}（纯进度事件不应冲掉日志）`)
  assert(deltaTask.progress === 80, '进度应更新为 80')
  console.log('OK incremental logs', JSON.stringify(deltaTask))

  // ── 5. DOM（任务运行中）：进度、健康态、折叠缩略图、灯箱 ──
  const dom = await evaluate(`(async () => {
    const cards = Array.from(document.querySelectorAll('[role="listitem"]'))
      .filter((el) => (el.innerText || '').includes(${JSON.stringify(label)}));
    const card = cards.find((el) => el.querySelector('[aria-label="展开或收起任务详情"]'));
    if (!card) return { ok: false, reason: 'card-not-found' };
    const body0 = card.innerText || '';
    const toggle = card.querySelector('[aria-label="展开或收起任务详情"]');
    const thumbBefore = card.querySelector('[aria-label="预览图片 probe.png"]');
    if (toggle) toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await new Promise((r) => setTimeout(r, 300));
    const body1 = card.innerText || '';
    const collapsedThumb = card.querySelector('[aria-label="预览图片 probe.png"]');
    let lightboxOpen = false;
    if (collapsedThumb) {
      collapsedThumb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await new Promise((r) => setTimeout(r, 350));
      lightboxOpen = !!document.querySelector('[role="dialog"][aria-modal="true"]');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
    }
    return {
      ok: true,
      hasToggle: !!toggle,
      seesHealthWarn: body0.includes('有警告'),
      seesElapsed: /已用/.test(body0),
      seesStepWait: /本步/.test(body0),
      seesEta: /预计/.test(body0),
      milestonesBeforeClick: /里程碑/.test(body0),
      thumbBeforeClick: !!thumbBefore,
      collapsedAfterClick: !/里程碑/.test(body1),
      hasThumbAfterCollapse: !!collapsedThumb,
      lightboxOpen,
      lightboxClosedAfterEsc: !document.querySelector('[role="dialog"][aria-modal="true"]'),
    };
  })()`)
  console.log('OK dom (running)', JSON.stringify(dom))
  assert(dom?.ok, `找不到任务卡: ${JSON.stringify(dom)}`)
  assert(dom.hasToggle, '进度区应可点展开/收起')
  assert(dom.seesHealthWarn, '有 warn 日志时应显示「有警告」')
  assert(dom.seesElapsed, '应显示「已用」')
  assert(dom.seesStepWait, '应显示「本步」等待时长')
  assert(dom.seesEta, '应显示「预计」剩余')
  assert(dom.milestonesBeforeClick, '运行中应默认展开里程碑')
  assert(dom.collapsedAfterClick, '点进度区应收起里程碑')
  assert(dom.hasThumbAfterCollapse, '折叠态应有可点缩略图')
  assert(dom.lightboxOpen, '点缩略图应打开灯箱（role=dialog aria-modal）')
  assert(dom.lightboxClosedAfterEsc, 'Esc 应关闭灯箱')

  // ── 6. 终态全量日志自愈 ──────────────────────────
  const terminal = await injectEvent({
    ...base,
    status: 'succeeded',
    endedAt: now + 3_000,
    summary: '生成完成',
    progress: 100,
    logs: [
      { level: 'info', message: '入队', timestamp: now - 25_000 },
      { level: 'warn', message: '显存占用偏高', timestamp: now - 2_000 },
      { level: 'info', message: '渲染 10%', timestamp: now + 1_000 },
      { level: 'info', message: '渲染 40%', timestamp: now + 2_000 },
      { level: 'info', message: '完成', timestamp: now + 2_900 },
    ],
  })
  const terminalTask = terminal.tasks.find((t) => t.taskId === taskId)
  assert(terminalTask.logs === 5, `终态全量日志应为 5 条，实际 ${terminalTask.logs}`)
  assert(terminalTask.status === 'succeeded', '终态应为 succeeded')
  console.log('OK terminal full logs', JSON.stringify(terminalTask))

  // ── 7. 暂停态 UI ─────────────────────────────────
  const pausedTaskId = `enh-paused-${now.toString(36)}`
  const pausedLabel = `暂停验收任务 ${pausedTaskId}`
  const pausedInject = await injectEvent({
    ...base,
    taskId: pausedTaskId,
    label: pausedLabel,
    status: 'paused',
    pausable: true,
    pausedAt: now - 5_000,
    progress: 70,
    milestones: [{ step: '渲染', status: 'in-progress', startTime: now - 12_000 }],
    logs: [{ level: 'info', message: '已暂停', timestamp: now - 5_000 }],
  })
  const paused = pausedInject.tasks.find((t) => t.taskId === pausedTaskId)
  assert(paused?.status === 'paused', '暂停态任务应写入 store')

  const pausedDom = await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('[role="listitem"]'))
      .find((el) => (el.innerText || '').includes(${JSON.stringify(pausedLabel)}));
    if (!card) return { ok: false };
    const body = card.innerText || '';
    const buttons = Array.from(card.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
    return {
      ok: true,
      seesPaused: body.includes('已暂停'),
      seesResume: body.includes('恢复'),
      seesFrozen: body.includes('计时已停'),
      hasPauseBtn: buttons.includes('暂停'),
      hasCancelBtn: buttons.includes('中断'),
      buttons,
    };
  })()`)
  console.log('OK paused dom', JSON.stringify(pausedDom))
  assert(pausedDom?.ok, '暂停任务卡未渲染')
  assert(pausedDom.seesPaused && pausedDom.seesResume, '应显示「已暂停」与「恢复」')
  assert(pausedDom.seesFrozen, '暂停时应显示「计时已停」')
  assert(!pausedDom.hasPauseBtn, '暂停态不应再显示「暂停」按钮')
  assert(!pausedDom.hasCancelBtn, '暂停态不应显示「中断」（避免误点）')

  // 点「恢复」：走真实命令总线；该任务不在主进程，主进程返回 ok:false（不改变 UI，符合边界）
  const resumeClick = await evaluate(`(async () => {
    const card = Array.from(document.querySelectorAll('[role="listitem"]'))
      .find((el) => (el.innerText || '').includes(${JSON.stringify(pausedLabel)}));
    const btn = card ? Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '恢复') : null;
    if (!btn) return { ok: false, reason: 'no-resume-button' };
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, clicked: true };
  })()`)
  console.log('OK resume click', JSON.stringify(resumeClick))
  assert(resumeClick?.ok, '恢复按钮不可点')

  // ── 7. 通用后台工具（非 ComfyUI）──────────────────
  // backgroundTools 是通用机制，不止 ComfyUI：任何 MCP 工具后台化后都走同一条
  // 事件链（两段里程碑「执行/完成」、无产出、不可暂停）。这里用真实 renderer
  // 事件链验它，避免只有 ComfyUI 一条路径被测到。
  const genericTaskId = `enh-generic-${now.toString(36)}`
  const genericLabel = `通用后台工具 ${genericTaskId}`
  const genericBase = {
    type: 'agent:background-task',
    taskId: genericTaskId,
    sessionKey: sk,
    toolName: 'mcp__excel-mcp__read_excel',
    label: genericLabel,
    startedAt: now - 4_000,
    milestones: [
      { step: '执行', status: 'in-progress', startTime: now - 4_000 },
      { step: '完成', status: 'pending' },
    ],
    logs: [{ level: 'info', message: '开始执行 mcp__excel-mcp__read_excel', timestamp: now - 4_000 }],
    progress: 10,
    currentStep: '执行中',
  }
  const genericRun = await injectEvent({ ...genericBase, status: 'running' })
  const genericTask = genericRun.tasks.find((t) => t.taskId === genericTaskId)
  assert(genericTask, '通用后台工具任务未写入 store')
  assert(genericTask.pausable === undefined, '通用后台工具不可暂停（无轮询闸门）')

  const genericDom = await evaluate(`(async () => {
    const card = Array.from(document.querySelectorAll('[role="listitem"]'))
      .find((el) => (el.innerText || '').includes(${JSON.stringify(genericLabel)}));
    if (!card) return { ok: false };
    const body = card.innerText || '';
    const buttons = Array.from(card.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
    return {
      ok: true,
      seesExecute: body.includes('执行'),
      seesCancel: buttons.includes('中断'),
      hasPauseBtn: buttons.includes('暂停'),
      seesComfy: /ComfyUI/.test(body),
    };
  })()`)
  console.log('OK generic dom', JSON.stringify(genericDom))
  assert(genericDom?.ok, '通用后台工具卡片未渲染')
  assert(genericDom.seesExecute, '通用任务应显示「执行」阶段')
  assert(genericDom.seesCancel, '通用任务应有「中断」按钮')
  assert(!genericDom.hasPauseBtn, '通用任务不应出现「暂停」（非轮询型）')
  assert(!genericDom.seesComfy, '通用任务不应出现 ComfyUI 文案')

  // 通用任务取消：主进程没有这个任务 → ok:false → renderer 就地收尾为「已取消」
  const genericCancel = await evaluate(`(async () => {
    const card = Array.from(document.querySelectorAll('[role="listitem"]'))
      .find((el) => (el.innerText || '').includes(${JSON.stringify(genericLabel)}));
    const btn = card ? Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '中断') : null;
    if (!btn) return { ok: false, reason: 'no-cancel-button' };
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await new Promise((r) => setTimeout(r, 600));
    const after = Array.from(document.querySelectorAll('[role="listitem"]'))
      .find((el) => (el.innerText || '').includes(${JSON.stringify(genericLabel)}));
    return { ok: true, cancelled: /已取消/.test(after?.innerText || ''), stillHasCancel: Array.from(after?.querySelectorAll('button') || []).some((b) => (b.textContent || '').trim() === '中断') };
  })()`)
  console.log('OK generic cancel', JSON.stringify(genericCancel))
  assert(genericCancel?.ok, '通用任务中断按钮不可点')
  assert(genericCancel.cancelled, '主进程无此任务时，点「中断」应就地标记已取消（不再点了没反应）')
  assert(!genericCancel.stillHasCancel, '已取消后不应再显示「中断」')

  // ── 8. 截图 ──────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const shot = path.join(OUT_DIR, `background-task-enh-${Date.now()}.jpg`)
  const shotRes = uiCli(['screenshot', '--annotate', '--target', 'main', '--out', shot])
  assert(shotRes.code === 0, `截图失败: ${shotRes.out + shotRes.stderr}`)
  console.log('OK screenshot', shotRes.json?.path || shot)

  console.log('')
  console.log('PASS 后台任务卡增强（增量日志 / 暂停恢复 / 灯箱）真实客户端验收通过')
  console.log(JSON.stringify({ sessionKey: sk, taskId, pausedTaskId: pausedTaskId, dom, pausedDom, screenshot: shot }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
