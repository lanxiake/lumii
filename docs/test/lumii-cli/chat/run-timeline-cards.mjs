/**
 * 时间线卡片注册表 — 真实 renderer 验收
 *
 * 验的是「迁移到注册表后，卡片仍然渲染在折叠区之外」——这是唯一会静默退化的点：
 * 卡片照常出现，但被塞进「执行过程」里，用户点不到确认按钮 / 看不到 summary。
 *
 * 用法：
 *   node docs/test/lumii-cli/chat/run-timeline-cards.mjs [sessionKey]
 *   （不给 sessionKey 时自动找一个含 spawn_agent 的历史会话）
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evaluate(expression) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl
    && !String(t.url).startsWith('devtools:')
    && (/灵栖|Lumii/i.test(t.title || '') || /127\.0\.0\.1:\d+/.test(t.url || '')))
  if (!page) throw new Error('找不到主窗口（启动时加 -RemoteDebug 9222）')
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

async function main() {
  console.log('== 时间线卡片注册表 · 真实 renderer 验收 ==')
  let sk = process.argv[2]

  if (!sk) {
    const list = cli(['conversation', 'list'])
    const sessions = list.json || []
    // 并行链路用例的会话里一定有 spawn_agent 卡片
    const candidate = sessions.find((s) => /\[trace\]|\[journey\]|并行/.test(s.title || ''))
    sk = candidate?.sessionKey
  }
  assert(sk, '找不到含委托卡片的会话，请显式传 sessionKey')
  console.log('session', sk)

  cli(['goto', '--view', 'chat'])
  await sleep(600)

  // 切到该会话并等消息渲染
  const switched = await evaluate(`(async () => {
    const mod = await import('/hooks/business/useAgentRuntime/switch-session.ts');
    if (typeof mod.switchSession !== 'function') return { ok: false, why: 'no switchSession' };
    await mod.switchSession(${JSON.stringify(sk)});
    return { ok: true };
  })()`)
  assert(switched.ok, '切换会话失败: ' + JSON.stringify(switched))
  await sleep(2500)

  // 读注册表状态 + DOM
  const report = await evaluate(`(async () => {
    const reg = await import('/pages/ChatPage/components/TimelineCards/registry.ts');
    const cards = reg.listTimelineCards().map((c) => ({ id: c.id, order: c.order, pinned: !!c.pinned, owner: c.owner }));

    // 折叠区 = 带「执行过程 / 工作过程」的可展开按钮
    const folds = Array.from(document.querySelectorAll('button[aria-expanded]'))
      .filter((el) => /执行过程|工作过程/.test(el.textContent || ''));

    // 卡片按**文本徽标**定位：CSS Modules 的类名在 dev 下是哈希，选择器不可靠
    const badges = Array.from(document.querySelectorAll('span'))
      .filter((el) => (el.textContent || '').trim() === '团队委托');
    const spawnRoots = badges.map((badge) => {
      let root = badge.parentElement;
      while (root && root.parentElement && !/执行过程|workflow/i.test(root.className || '')) {
        if (root.querySelector('[class*="runs"], [data-instance-id]')) break;
        root = root.parentElement;
      }
      return root;
    });

    const inFold = (el) => !!el && folds.some((f) => f.contains(el));

    return {
      cards,
      foldCount: folds.length,
      spawnCardCount: spawnRoots.length,
      spawnInsideFold: spawnRoots.filter(inFold).length,
      hasTimeline: document.querySelectorAll('[class*="parts-timeline"], [class*="partsTimeline"]').length,
    };
  })()`)

  console.log('\n=== 注册表 ===')
  for (const c of report.cards) {
    console.log(`  ${String(c.order).padStart(3)} ${c.id.padEnd(24)} pinned=${c.pinned} owner=${c.owner}`)
  }

  const ids = report.cards.map((c) => c.id)
  assert(ids.includes('builtin.handoff'), '缺少内置转交卡片')
  assert(ids.includes('builtin.spawn'), '缺少内置委托卡片')
  assert(ids.includes('builtin.task-complete'), '缺少内置任务完成卡片')
  const orders = report.cards.map((c) => c.order)
  assert(orders.every((o, i) => i === 0 || o >= orders[i - 1]), '卡片未按 order 升序')
  assert(report.cards.every((c) => c.pinned), '三张内置卡片都应 pinned（露在折叠区外）')
  console.log('OK 内置三卡已注册且全部 pinned')

  console.log('\n=== DOM ===')
  console.log(`  折叠区 ${report.foldCount} 个 · 委托卡片 ${report.spawnCardCount} 个 · 落在折叠区内 ${report.spawnInsideFold} 个`)
  assert(report.hasTimeline > 0, '当前会话没有渲染出 parts 时间线（可能选错了会话）')
  if (report.spawnCardCount > 0) {
    assert(report.spawnInsideFold === 0,
      `${report.spawnInsideFold} 张委托卡片被折叠进了「执行过程」——注册表的 pinned 语义没生效`)
    console.log('OK 委托卡片全部露在折叠区外')
  } else {
    console.log('NOTE 该会话没有委托卡片，折叠区位置未验证（换一个含 spawn_agent 的会话再跑）')
  }

  console.log('\nPASS 时间线卡片注册表在真实客户端生效')
  console.log(JSON.stringify({ sessionKey: sk, cards: report.cards.length }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
