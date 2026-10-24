/**
 * 并行看板 — 真实 renderer 验收（注入 snapshot 事件）
 *
 * 用真实事件链路（handleRuntimeEvent → store → React）验：
 * 1. 单个子 Agent 不显示看板，≥2 才出现
 * 2. 名字优先用委托名、状态/耗时/取消按钮正确
 * 3. 点「取消」发出 agentInstance:abort 命令
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const CLI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const CDP_PORT = Number(process.env.CDP_PORT || 9222)

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' })
  let json = null
  try { json = JSON.parse((r.stdout || '').trim()) } catch {}
  return { json, out: r.stdout, err: r.stderr }
}

function fail(msg) { console.error('FAIL: ' + msg); process.exit(1) }
function assert(c, m) { if (!c) fail(m) }

async function evaluate(expression) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl
    && !String(t.url).startsWith('devtools:')
    && (/灵栖|Lumii/i.test(t.title || '') || /127\.0\.0\.1:\d+/.test(t.url || '')))
  if (!page) throw new Error('找不到主窗口')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')) })
  let id = 0
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== myId) return
      ws.removeEventListener('message', onMsg)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  ws.close()
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

/** 注入一次活动快照（走真实 event-handler） */
function injectSnapshot(sessionKey, agents) {
  // 顺序要紧：switchSession 会把 activeAgents 重置为 []，所以先切会话再注入快照
  return evaluate(`(async () => {
    const switchMod = await import('/hooks/business/useAgentRuntime/switch-session.ts');
    if (typeof switchMod.switchSession === 'function') await switchMod.switchSession(${JSON.stringify(sessionKey)});
    const mod = await import('/hooks/business/useAgentRuntime/event-handler.ts');
    mod.handleRuntimeEvent({
      type: 'agent:activity:snapshot',
      rootSessionKey: ${JSON.stringify(sessionKey)},
      agents: ${JSON.stringify(agents)},
    });
    await new Promise((r) => setTimeout(r, 300));
    const storeMod = await import('/hooks/business/useAgentRuntime/agent-runtime-store.ts');
    return (storeMod.runtimeStore.getState().sessions.get(${JSON.stringify(sessionKey)})?.activeAgents || []).length;
  })()`)
}

async function readDashboard() {
  return evaluate(`(() => {
    const section = document.querySelector('[aria-label="并行子 Agent 看板"]');
    if (!section) return { present: false };
    const items = Array.from(section.querySelectorAll('li')).map((li) => {
      const buttons = Array.from(li.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
      return { text: (li.innerText || '').replace(/\\n/g, ' | '), buttons };
    });
    return { present: true, header: (section.querySelector('header')?.innerText || '').replace(/\\n/g, ' '), items };
  })()`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('== 并行子 Agent 看板 · 真实 renderer 验收 ==')
  const st = cli(['status'])
  if (/connection_failed|app_not_running/.test(st.out + st.err)) fail('客户端未运行')

  const created = cli(['conversation', 'create', '--title', '[dashboard] 并行看板验收'])
  const sk = created.json?.sessionKey || created.json?.id
  assert(sk, '建会话失败: ' + created.out)
  cli(['goto', '--view', 'chat'])
  await sleep(800)
  console.log('OK session', sk)

  // ── 1. 单个子 Agent：不显示 ───────────────────────
  const now = Date.now()
  await injectSnapshot(sk, [
    { instanceId: 'main-1', name: '主助手', state: 'running', isSubAgent: false },
    { instanceId: 'c1', name: '安全审查', state: 'running', isSubAgent: true, mode: 'sync', status: 'running', startedAt: now - 8000 },
  ])
  await sleep(300)
  const one = await readDashboard()
  assert(!one.present, '单个子 Agent 时不应显示看板')
  console.log('OK single sub-agent -> dashboard hidden')

  // ── 2. 三个并行：看板出现 ─────────────────────────
  await injectSnapshot(sk, [
    { instanceId: 'main-1', name: '主助手', state: 'running', isSubAgent: false },
    { instanceId: 'c1', name: '安全审查', state: 'running', isSubAgent: true, mode: 'sync', status: 'running', startedAt: now - 12000 },
    { instanceId: 'c2', name: '性能审查', state: 'running', isSubAgent: true, mode: 'sync', status: 'running', startedAt: now - 9000 },
    { instanceId: 'c3', name: '一致性审查', state: 'idle', isSubAgent: true, mode: 'async', status: 'succeeded', startedAt: now - 30000 },
  ])
  await sleep(600)
  const three = await readDashboard()
  console.log('dashboard:', JSON.stringify(three))
  assert(three.present, '3 个子 Agent 时应显示看板')
  assert(three.items.length === 3, `应有 3 张卡，实际 ${three.items.length}`)
  assert(/3 个 · 2 个进行中/.test(three.header), `总览文案不对: ${three.header}`)
  assert(three.items.some((i) => i.text.includes('安全审查')), '应显示委托名「安全审查」')
  assert(three.items.some((i) => i.text.includes('一致性审查') && i.text.includes('已完成')), '已完成卡片应显示终态')
  assert(three.items.some((i) => i.text.includes('后台')), 'async 子 Agent 应带「后台」标记')
  const cancelButtons = three.items.filter((i) => i.buttons.includes('取消'))
  assert(cancelButtons.length === 2, `应只有 2 个进行中的卡带取消按钮，实际 ${cancelButtons.length}`)
  console.log('OK 3 parallel agents rendered')

  // ── 3. 取消按钮 ───────────────────────────────────
  // 注意：preload 暴露的 electronAPI 是冻结对象，测试无法 monkeypatch sendCommand
  // 来偷看命令。这里分两步验证：
  //   a) 点按钮不抛错、卡片不会被本地乐观删除（真实取消失效时也不会假装成功）；
  //   b) 同一条命令走真实命令总线能通（bogus id 也返回 ok:true，因为 abort 幂等）。
  // 「按钮 → onCancel(instanceId)」这层契约由 AgentDashboard.test.tsx 单测覆盖。
  const clicked = await evaluate(`(async () => {
    const section = document.querySelector('[aria-label="并行子 Agent 看板"]');
    const li = Array.from(section?.querySelectorAll('li') || [])
      .find((el) => (el.innerText || '').includes('安全审查'));
    const btn = li ? Array.from(li.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '取消') : null;
    if (!btn) return { ok: false };
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await new Promise((r) => setTimeout(r, 500));
    const stillThere = Array.from(document.querySelectorAll('[aria-label="并行子 Agent 看板"] li'))
      .some((el) => (el.innerText || '').includes('安全审查'));
    return { ok: true, stillThere };
  })()`)
  console.log('cancel click:', JSON.stringify(clicked))
  assert(clicked?.ok, '找不到「安全审查」卡的取消按钮')
  assert(clicked.stillThere, '点取消后卡片应仍在（状态变更由主进程快照驱动，不是本地删除）')

  const busAbort = cli(['command', 'agentInstance:abort', '--data', JSON.stringify({
    type: 'agentInstance:abort', instanceId: 'no-such-instance',
  })])
  assert(busAbort.json?.ok === true, `agentInstance:abort 命令总线应可用，实际 ${JSON.stringify(busAbort.json)}`)
  console.log('OK cancel button + command bus reachable')

  // ── 4. 快照清空后看板消失 ─────────────────────────
  await injectSnapshot(sk, [
    { instanceId: 'main-1', name: '主助手', state: 'idle', isSubAgent: false },
  ])
  await sleep(400)
  const gone = await readDashboard()
  assert(!gone.present, '子 Agent 结束后看板应消失')
  console.log('OK dashboard disappears after agents finish')

  console.log('\nPASS 并行看板真实 renderer 验收通过')
  console.log(JSON.stringify({ sessionKey: sk, dashboard: three }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
