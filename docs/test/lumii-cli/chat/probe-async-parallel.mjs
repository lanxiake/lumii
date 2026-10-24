/**
 * 探测：真实 async spawn 是否能并行（看板的前提）
 *
 * 只有 mode:"async" 的 spawn 不会阻塞父回合——sync 会 await 到子 Agent 跑完，
 * 同一时刻最多一个子实例，"并行看板"根本不会出现。
 * 这里验真实链路：要求模型用 async 一次派 2 个子 Agent，然后观测 activeAgents。
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

async function evaluate(expression) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl
    && !String(t.url).startsWith('devtools:'))
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const created = cli(['conversation', 'create', '--title', '[probe] async parallel spawn'])
  const sk = created.json?.sessionKey || created.json?.id
  if (!sk) throw new Error('建会话失败: ' + created.out)
  cli(['goto', '--view', 'chat'])
  await sleep(1200)
  // 必须把 UI 切到该会话：看板只渲染当前会话的 activeAgents
  await evaluate(`(async () => {
    const m = await import('/hooks/business/useAgentRuntime/switch-session.ts');
    if (typeof m.switchSession === 'function') await m.switchSession(${JSON.stringify(sk)});
    await new Promise((r) => setTimeout(r, 300));
    return true;
  })()`)
  console.log('session', sk)

  cli(['command', 'user:send', '--data', JSON.stringify({
    type: 'user:send',
    sessionKey: sk,
    content: '请**并行**派两个后台子 Agent（mode 必须是 "async"，不要 sync，也不要等结果）：' +
      '①「统计」：用 bash 算 1 到 2000 的和；②「列举」：用 bash 列出当前目录前 3 个文件名。' +
      '两个都派出去之后立刻简短回复我"已派出"，不要等它们完成。',
  })])

  let maxSubs = 0
  let sawDashboard = false
  const frames = []
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    let snap
    try {
      snap = await evaluate(`(async () => {
        const m = await import('/hooks/business/useAgentRuntime/agent-runtime-store.ts');
        const st = m.runtimeStore.getState();
        const sess = st.sessions.get(${JSON.stringify(sk)});
        const subs = (sess?.activeAgents || []).filter((a) => a.isSubAgent);
        return {
          streaming: sess?.isStreaming ?? false,
          subs: subs.map((a) => ({ name: a.name, state: a.state, status: a.status })),
          dash: !!document.querySelector('[aria-label="并行子 Agent 看板"]'),
        };
      })()`)
    } catch (e) {
      snap = { error: String(e).slice(0, 120) }
    }
    if (snap.subs && snap.subs.length > maxSubs) maxSubs = snap.subs.length
    if (snap.dash) sawDashboard = true
    const sig = JSON.stringify({ subs: snap.subs, dash: snap.dash })
    if (frames.length === 0 || frames[frames.length - 1].sig !== sig) {
      frames.push({ t: i, sig })
      console.log(`t=${i}s`, sig, 'dash=', snap.dash)
    }
    if (!snap.streaming && i > 10 && (snap.subs || []).length === 0) break
  }

  console.log('\n=== max concurrent sub agents:', maxSubs, '| dashboard seen:', sawDashboard, '===')
  console.log(JSON.stringify(frames, null, 1))
}

main().catch((e) => { console.error(e); process.exit(1) })
