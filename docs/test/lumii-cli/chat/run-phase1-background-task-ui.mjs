/**
 * Phase 1 / 1.1 后台任务卡 — 真实客户端 CLI 验收
 *
 * 前置：客户端已用远程调试启动
 *   powershell -File scripts/start-dev.ps1 -Force -RemoteDebug 9222
 *
 *   node docs/test/lumii-cli/chat/run-phase1-background-task-ui.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LUMII_UI, okJson, ui, assert, sleep } from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, 'artifacts')
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const TITLE = '[phase1-ui] background-task card probe'

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
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

/** 定位主窗口 CDP target */
async function findMainPage() {
  const targets = await cdpList()
  return targets.find(
    (t) => t.type === 'page' && t.webSocketDebuggerUrl && /灵栖|Lumii/i.test(t.title || '') && !String(t.url).startsWith('devtools:'),
  ) || targets.find((t) => t.type === 'page' && /127\.0\.0\.1:\d+/.test(t.url || '') && t.webSocketDebuggerUrl)
}

/** 在主窗口注入一条 Phase 1.1 后台任务事件（含 warn + 本步 startTime + 图片） */
async function injectTask(sessionKey) {
  const page = await findMainPage()
  if (!page) throw new Error('找不到主窗口')

  const now = Date.now()
  const event = {
    type: 'agent:background-task',
    taskId: `phase1-ui-probe-${now.toString(36)}`,
    sessionKey,
    toolName: 'mcp__comfyui-remote__enqueue_workflow',
    label: 'Phase1 UI 探针任务',
    status: 'running',
    startedAt: now - 30_000,
    progress: 70,
    currentStep: '渲染',
    note: 'ComfyUI 渲染中',
    logs: [
      { level: 'info', message: '已入队', timestamp: now - 25_000 },
      { level: 'info', message: '渲染中', timestamp: now - 5_000 },
      { level: 'warn', message: '显存占用偏高', timestamp: now - 2_000 },
    ],
    milestones: [
      { step: '入队', status: 'completed', duration: 1200 },
      { step: '排队', status: 'completed', duration: 3400 },
      { step: '渲染', status: 'in-progress', startTime: now - 12_000 },
      { step: '保存结果', status: 'pending' },
    ],
    outputs: [
      {
        name: 'probe.png',
        path: 'probe.png',
        kind: 'image',
        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
    ],
  }

  const expr = `(async () => {
    const evt = ${JSON.stringify(event)};
    const mod = await import('/hooks/business/useAgentRuntime/event-handler.ts');
    mod.handleRuntimeEvent(evt);
    const storeMod = await import('/hooks/business/useAgentRuntime/agent-runtime-store.ts');
    const switchMod = await import('/hooks/business/useAgentRuntime/switch-session.ts');
    if (typeof switchMod.switchSession === 'function') {
      await switchMod.switchSession(evt.sessionKey);
    } else {
      storeMod.runtimeStore.setState((s) => ({ ...s, currentSessionKey: evt.sessionKey }));
    }
    await new Promise((r) => setTimeout(r, 300));
    const sess = storeMod.runtimeStore.getState().sessions.get(evt.sessionKey);
    const task = (sess?.backgroundTasks || []).find((t) => t.taskId === evt.taskId);
    const body = document.body?.innerText || '';
    return {
      ok: !!task,
      progress: task?.progress,
      currentStep: task?.currentStep,
      logs: task?.logs?.length ?? 0,
      milestones: task?.milestones?.length ?? 0,
      currentSessionKey: storeMod.runtimeStore.getState().currentSessionKey,
      seesProgressText: /进行中\\s*\\(70%\\)/.test(body),
      seesLabel: body.includes('Phase1 UI 探针任务'),
      seesMilestone: /里程碑/.test(body),
      seesLogBtn: /日志/.test(body),
      seesStepWait: /本步/.test(body),
      seesHealthWarn: body.includes('有警告'),
      seesWarnLog: body.includes('显存占用偏高'),
    };
  })()`

  const s = cdpSession(page.webSocketDebuggerUrl)
  try {
    const r = await s.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
    return { page: { title: page.title, url: page.url }, result: r.result.value, taskId: event.taskId }
  } finally {
    s.close()
  }
}

/** 读页面信号：计时、健康态、进度可点、折叠态缩略图 */
async function readBodySignals() {
  const page = await findMainPage()
  if (!page) return null
  const s = cdpSession(page.webSocketDebuggerUrl)
  try {
    const r = await s.send('Runtime.evaluate', {
      expression: `(() => {
        const body = document.body?.innerText || '';
        const progress = document.querySelector('progress[aria-label="任务进度"]');
        const progressToggle = document.querySelector('[aria-label="展开或收起任务详情"]');
        const thumb = document.querySelector('[aria-label="预览图片 probe.png"]');
        return {
          seesProgressText: /进行中\\s*\\(70%\\)/.test(body),
          seesLabel: body.includes('Phase1 UI 探针任务'),
          seesMilestone: /里程碑\\s*\\(/.test(body),
          seesLogBtn: /日志\\s*\\(/.test(body),
          seesStep: body.includes('渲染'),
          seesElapsed: /已用/.test(body),
          seesStepWait: /本步/.test(body),
          seesEta: /预计/.test(body),
          seesHealthWarn: body.includes('有警告'),
          seesWarnLog: body.includes('显存占用偏高'),
          hasProgressEl: !!progress,
          progressValue: progress ? Number(progress.value) : null,
          hasProgressToggle: !!progressToggle,
          hasThumbButton: !!thumb,
        };
      })()`,
      returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  } finally {
    s.close()
  }
}

/**
 * 点击进度区收起，再确认折叠态缩略图可点。
 * 限定在含探针标签的任务卡内，点击后等待一帧再读 DOM。
 */
async function clickProgressThenCheckThumb() {
  const page = await findMainPage()
  if (!page) return null
  const s = cdpSession(page.webSocketDebuggerUrl)
  try {
    const r = await s.send('Runtime.evaluate', {
      expression: `(async () => {
        const cards = Array.from(document.querySelectorAll('[role="listitem"]'));
        const card = cards.find((el) => (el.innerText || '').includes('Phase1 UI 探针任务'));
        if (!card) return { ok: false, reason: 'no-probe-card' };
        const toggle = card.querySelector('[aria-label="展开或收起任务详情"]');
        if (!toggle) return { ok: false, reason: 'no-progress-toggle' };
        const beforeExpanded = /里程碑\\s*\\(/.test(card.innerText || '');
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        const afterText = card.innerText || '';
        const milestoneGone = !/里程碑\\s*\\(/.test(afterText);
        const thumb = card.querySelector('[aria-label="预览图片 probe.png"]');
        let lightboxOpen = false;
        if (thumb) {
          thumb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          await new Promise((resolve) => setTimeout(resolve, 150));
          lightboxOpen = Boolean(
            document.querySelector('[aria-modal="true"]')
            || document.querySelector('[role="dialog"]')
            || Array.from(document.querySelectorAll('img')).some((img) => img.alt === 'probe.png' && img.closest('[aria-modal="true"], [role="dialog"]')),
          );
        }
        return {
          ok: true,
          beforeExpanded,
          collapsedMilestones: milestoneGone,
          hasThumbButton: !!thumb,
          thumbClicked: !!thumb,
          lightboxOpen,
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  } finally {
    s.close()
  }
}

async function main() {
  console.log('== Phase 1.1 BackgroundTaskCard 真实 CLI 验收 ==')

  const st = ui(['status'], { retries: 1 })
  if (/connection_failed/.test(st.out + st.stderr) || st.json?.error === 'connection_failed') {
    fail('客户端未运行。请先: powershell -File scripts/start-dev.ps1 -Force -RemoteDebug 9222')
  }
  console.log('OK lumii-ui status')

  try {
    await cdpList()
  } catch (e) {
    fail(`CDP :${CDP_PORT} 不可用（${e.message}）。需带 --remoteDebuggingPort=9222 启动`)
  }
  console.log(`OK CDP :${CDP_PORT}`)

  const created = okJson(ui(['conversation', 'create', '--title', TITLE]), 'conversation create')
  const sk = created.sessionKey || created.id
  console.log('OK session', sk)

  ui(['goto', '--view', 'chat'], { retries: 1 })
  sleep(1000)

  const injected = await injectTask(sk)
  console.log('OK inject', JSON.stringify(injected.result))
  assert(injected.result?.ok, `store 未写入任务: ${JSON.stringify(injected.result)}`)
  assert(injected.result.progress === 70, 'progress 应为 70')
  assert(injected.result.logs >= 2, 'logs 应写入')
  assert(injected.result.milestones === 4, 'milestones 应为 4')

  sleep(600)
  const signals = await readBodySignals()
  console.log('OK body signals', JSON.stringify(signals))

  assert(
    signals?.hasProgressEl || signals?.seesProgressText || signals?.seesLabel || injected.result.seesProgressText,
    `前端未见任务卡进度/标签。signals=${JSON.stringify(signals)}`,
  )
  assert(signals?.hasProgressToggle, '进度区应可点（展开或收起任务详情）')
  assert(signals?.seesStepWait || injected.result.seesStepWait, '应显示本步已等待文案')
  assert(signals?.seesHealthWarn || injected.result.seesHealthWarn, '有 warn 时应显示健康态「有警告」')
  assert(signals?.seesWarnLog || injected.result.seesWarnLog, 'warn 日志应默认可见')
  assert(signals?.seesMilestone || injected.result.seesMilestone, '运行中应默认展开里程碑')

  const clickResult = await clickProgressThenCheckThumb()
  console.log('OK click progress / thumb', JSON.stringify(clickResult))
  assert(clickResult?.ok, `进度点击失败: ${JSON.stringify(clickResult)}`)
  assert(clickResult.collapsedMilestones, '点击进度区后应收起里程碑')
  assert(clickResult.hasThumbButton, '折叠态应出现可点缩略图')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const shot = path.join(OUT_DIR, `phase1-ui-${Date.now()}.jpg`)
  const shotRes = ui(['screenshot', '--annotate', '--target', 'main', '--out', shot], { retries: 2 })
  okJson(shotRes, 'screenshot')
  console.log('OK screenshot', shotRes.json?.path || shot)

  console.log('')
  console.log('PASS 真实客户端前端 Phase 1.1 后台任务卡体验补丁已生效')
  console.log(JSON.stringify({
    sessionKey: sk,
    taskId: injected.taskId,
    store: injected.result,
    signals,
    clickResult,
    screenshot: shotRes.json?.path || shot,
  }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
