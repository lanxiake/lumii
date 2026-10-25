/**
 * 时间线卡片注册表 — 真实 renderer 验收
 *
 * 两段：
 * 1. **内置三卡**：「迁移到注册表后卡片仍然渲染在折叠区之外」——这是唯一会静默退化的点：
 *    卡片照常出现，但被塞进「执行过程」里，用户点不到确认按钮 / 看不到 summary。
 * 2. **外部插件端到端**：往 `~/.lumii/plugins/` 临时落一个插件，
 *    验「文件 → 协议 → 注入脚本 → 工厂 → api → 注册表」整条链，再删目录验注销。
 *    只凭代码推理说「插件能用」不算数，这条链一个字都看不见才算验过。
 *
 * 用法：
 *   node docs/test/lumii-cli/chat/run-timeline-cards.mjs [sessionKey]
 *   （不给 sessionKey 时自动找一个含 spawn_agent 的历史会话）
 *   CDP_PORT=9222 可用环境变量改端口。
 *
 * ⚠️ 第二段会**往真实插件目录写一个临时插件**（名字固定，跑完即删）。
 *    脚本被强杀时会残留 `~/.lumii/plugins/__tt-timeline-probe/`，手工删掉即可。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const CLI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const CDP_PORT = Number(process.env.CDP_PORT || 9222)

/** 客户端数据根，与主进程 `client-data-root.ts` 同一口径 */
function clientStateDir() {
  const override = (process.env.LUMII_CLIENT_DATA_DIR || '').trim()
  return override ? path.resolve(override) : path.join(os.homedir(), '.lumii')
}

// id 必须小写字母/数字开头（主进程 `client-plugin-meta.ts` 的规则），
// 前导下划线会让清单判成不兼容、插件根本不激活。
const PROBE_ID = 'tt-timeline-probe'
const PROBE_MARK = 'TT_PROBE_CARD'

/** 落一个临时外部插件。**不覆盖**同名目录：已存在就当测试自己上次没清干净。 */
function writeProbePlugin() {
  const dir = path.join(clientStateDir(), 'plugins', PROBE_ID)
  if (fs.existsSync(dir)) throw new Error(`临时插件目录已存在，先手工删掉：${dir}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ id: PROBE_ID, name: '时间线卡片探针', version: '0.0.1', origin: 'user' }, null, 2),
    'utf8',
  )
  // 匹配所有工具调用并固定文案：只要时间线上有任意工具，就一定能看到标记
  fs.writeFileSync(
    path.join(dir, 'client.js'),
    `__LUMII_REGISTER_PLUGIN__('${PROBE_ID}', (api) => {
  const h = api.React.createElement
  api.registerTimelineCard({
    id: '${PROBE_ID}.all',
    match: () => true,
    // pinned：不写就落进「执行过程」折叠区，而折叠区收起时内容根本不挂载，
    // 断言 body.textContent 会误判成「插件没渲染」。
    pinned: true,
    component: () => h('div', null, '${PROBE_MARK}'),
  })
})
`,
    'utf8',
  )
  return dir
}

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

  await externalPluginCase(sk)

  console.log('\nPASS 时间线卡片注册表在真实客户端生效')
  console.log(JSON.stringify({ sessionKey: sk, cards: report.cards.length }, null, 2))
}

/** 切到指定会话（DOM 会整段重挂，从而绕过 React.memo 对注册表变化的迟钝） */
async function switchTo(sessionKey) {
  const r = await evaluate(`(async () => {
    const mod = await import('/hooks/business/useAgentRuntime/switch-session.ts');
    await mod.switchSession(${JSON.stringify(sessionKey)});
    return { ok: true };
  })()`)
  assert(r.ok, '切换会话失败: ' + JSON.stringify(r))
  // 长会话（上百条消息）载入 + 窗口化渲染要 2 秒上下，短了会读到空 DOM
  await sleep(2000)
}

/**
 * 外部插件端到端：落文件 → 宿主轮询发现 → 注入脚本 → 工厂拿到 api → 注册表生效 → 删目录注销。
 *
 * 注册表变化**不会**触发已挂载消息重渲染（`ChatMessage` 是 `React.memo`），
 * 所以每一段都靠切会话把列表重挂一次再看 DOM——这不是测试的将就，是真实用户的路径：
 * 插件装好后，下一次切回会话时新卡片就在了。
 *
 * DOM 断言还要挑对会话，否则会误判成「插件没渲染」：
 * - 内置三卡 order 10/20/30，`spawn_agent` / `task_complete` / `propose_dev_handoff`
 *   永远先被它们命中，探针（order 100）**根本轮不到**；
 * - 子 Agent 的运行内容折叠在委托卡片里，未展开时不挂载。
 * 所以只有「顶层时间线上有其它工具（如 bash）」的会话能看见探针卡。逐个会话试，
 * 命中的那个留着做下载前后两次 DOM 对照。
 */
async function externalPluginCase(sk) {
  console.log('\n=== 外部插件端到端 ===')

  const allKeys = (cli(['conversation', 'list']).json || []).map((s) => s.sessionKey)
  // 已按 updatedAt 降序，取最近的若干个即可（避免逐个加载上百个会话）
  const candidates = [...new Set([sk, ...allKeys])].slice(0, 8)
  if (candidates.length < 2) {
    console.log('NOTE 只有一个会话，跳过外部插件端到端（需要切走再切回才能触发重渲染）')
    return
  }

  let dir = null
  try {
    dir = writeProbePlugin()
    console.log('  已落临时插件:', dir)

    // 宿主 1 秒轮询一次清单；留出脚本下载 + 激活的余量
    await sleep(2500)

    const registered = await evaluate(`(async () => {
      const reg = await import('/pages/ChatPage/components/TimelineCards/registry.ts');
      return reg.listTimelineCards().map((c) => ({ id: c.id, owner: c.owner, order: c.order }));
    })()`)
    const probeCard = registered.find((c) => c.id === PROBE_ID + '.all')
    assert(probeCard, '外部插件的卡片没进注册表：' + JSON.stringify(registered))
    assert(probeCard.owner === PROBE_ID, `owner 应被宿主强制为插件 id，实际是 ${probeCard.owner}`)
    assert(probeCard.order === 100, `插件卡默认 order 应为 100，实际是 ${probeCard.order}`)
    console.log(`  OK 已注册 ${probeCard.id}（owner=${probeCard.owner}, order=${probeCard.order}）`)

    let shownIn = null
    for (const key of candidates) {
      await switchTo(key)
      if (await evaluate(`document.body.textContent.includes(${JSON.stringify(PROBE_MARK)})`)) {
        shownIn = key
        break
      }
    }
    assert(shownIn, `插件卡片已进注册表，但 ${candidates.length} 个会话里都没渲染出来`)
    console.log(`  OK 插件卡片渲染到了时间线上（${shownIn}）`)

    // 删目录后先切走再切回：卡片按定义挂载，必须靠重挂才能看出它消失了
    const away = candidates.find((k) => k !== shownIn)
    fs.rmSync(dir, { recursive: true, force: true })
    dir = null
    await sleep(2500)

    const afterRemove = await evaluate(`(async () => {
      const reg = await import('/pages/ChatPage/components/TimelineCards/registry.ts');
      return reg.listTimelineCards().some((c) => c.id === ${JSON.stringify(PROBE_ID + '.all')});
    })()`)
    assert(!afterRemove, '删掉插件目录后卡片仍留在注册表里（注销没生效）')

    await switchTo(away)
    await switchTo(shownIn)
    const gone = await evaluate(`!document.body.textContent.includes(${JSON.stringify(PROBE_MARK)})`)
    assert(gone, '插件已卸载，卡片文案仍留在时间线上')
    console.log('  OK 插件被移除后卡片随之注销并消失')
  } finally {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
      console.log('  （清理临时插件目录）')
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
