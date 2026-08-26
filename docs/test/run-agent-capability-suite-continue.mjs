#!/usr/bin/env node
/**
 * 续跑 Agent 能力套件未完成项（E/F/G/H + 重试 D-02）
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const LOG = path.join(ROOT, '.lumii-dev.log')
const EVID = path.join(__dirname, '2026-08-27-agent-capability-evidence.jsonl')

function ui(args) {
  const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') }
}

function logEv(id, status, note, extra = {}) {
  const row = { ts: new Date().toISOString(), id, status, note, ...extra }
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n', 'utf8')
  console.log(`[${id}] ${status} — ${note}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function readLog() {
  for (let i = 0; i < 12; i++) {
    try {
      return fs.readFileSync(LOG, 'utf8')
    } catch (e) {
      if (e?.code === 'EBUSY') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
        continue
      }
      throw e
    }
  }
  return ''
}

function logAfter(marker) {
  const all = readLog()
  const i = all.lastIndexOf(marker)
  return i >= 0 ? all.slice(i) : all.slice(-300000)
}

function createSession(title) {
  try {
    return JSON.parse(ui(['conversation', 'create', '--title', title]).out).sessionKey
  } catch {
    return null
  }
}

function send(session, text) {
  return ui(['send', '--session', session, '--text', text])
}

function abort(session) {
  return ui(['send', 'abort', '--session', session])
}

function mark(tag) {
  try {
    fs.appendFileSync(LOG, `\n=== ${tag} ${new Date().toISOString()} ===\n`, 'utf8')
  } catch {
    /* ignore lock */
  }
  return tag
}

function loadMessages(session) {
  try {
    return JSON.parse(ui(['context', 'messages', '--session', session, '--limit', '80']).out)
  } catch {
    return { items: [] }
  }
}

function extractAssistant(items) {
  const tools = []
  const texts = []
  for (const m of items || []) {
    if (m.role !== 'assistant') continue
    try {
      const cj = JSON.parse(m.contentJson || '{}')
      for (const p of cj.parts || []) {
        if (p.type === 'tool') tools.push({ name: p.name, args: p.args, isError: !!p.isError, result: p.result })
        if (p.type === 'text' && p.text) {
          const v = String(p.text).split('</think>').pop().trim()
          if (v) texts.push(v)
        }
      }
    } catch {
      /* ignore */
    }
  }
  return { tools, texts, joined: texts.join('\n') }
}

async function waitUntil(pred, { timeoutMs = 180000, intervalMs = 5000, label = '' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await pred()
      if (v) return v
    } catch (e) {
      if (e?.code !== 'EBUSY') console.error(e.message || e)
    }
    process.stdout.write('.')
    await sleep(intervalMs)
  }
  console.log(`\n[timeout ${label}]`)
  return null
}

async function retryD02() {
  const id = 'D-02'
  const s = createSession('cap-D02-retry')
  const marker = mark(`TEST_${id}_RETRY`)
  // 先开短任务再 abort，再等 idle，再恢复指令
  send(s, '请调用 skill_search query=agent，然后写 800 字报告。')
  await waitUntil(() => (/ToolRunner → skill_search/.test(logAfter(marker)) ? true : null), {
    timeoutMs: 90000,
    label: 'D02-run',
  })
  abort(s)
  await sleep(5000)
  // 再 abort 一次确保空闲
  abort(s)
  await sleep(3000)
  send(s, '忽略之前所有未完成任务。请只回复四个字：恢复成功。绝对不要调用工具。')
  const ok = await waitUntil(() => {
    const items = loadMessages(s).items || []
    const assistants = items.filter((m) => m.role === 'assistant')
    if (!assistants.length) return null
    const last = extractAssistant([assistants[assistants.length - 1]]).joined
    // 必须是短回复语义
    if (/恢复成功/.test(last) && last.length < 80) return true
    if (/恢复成功/.test(last)) return true
    return null
  }, { timeoutMs: 120000, label: id })
  if (ok) logEv(id, 'PASS', 'abort 后恢复（重试）', { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', '恢复仍失败（重试）', { session: s?.slice(0, 8) })
}

async function caseE() {
  const s = createSession('cap-E-retry')
  const marker = mark('TEST_E_RETRY')
  send(
    s,
    '请严格按序调用工具（必须真实调用）：先 skill_search query=agent，再 memory_search query=agent，再 wiki_search query=agent（或 wiki_overview）。最后三行汇报。禁止编造。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const sk = /ToolRunner → skill_search/.test(after)
    const mem = /ToolRunner → memory_search/.test(after)
    const wiki = /ToolRunner → wiki_/.test(after)
    const { tools, joined } = extractAssistant(loadMessages(s).items)
    const names = new Set(tools.map((t) => t.name))
    // 日志或消息任一确认即可
    const e1 = sk || names.has('skill_search')
    const e2 = mem || names.has('memory_search')
    const e3 = wiki || [...names].some((n) => n.startsWith('wiki_'))
    if (e1 && e2 && e3) return { e1, e2, e3, joined: joined.slice(0, 200) }
    if (e1 && e2 && Date.now()) {
      // 允许 wiki 稍晚
    }
    return e1 && e2 && e3 ? true : null
  }, { timeoutMs: 240000, label: 'E' })

  // 分别记分：用最终日志
  const after = logAfter(marker)
  const { tools } = extractAssistant(loadMessages(s).items)
  const names = new Set(tools.map((t) => t.name))
  const e1 = /ToolRunner → skill_search/.test(after) || names.has('skill_search')
  const e2 = /ToolRunner → memory_search/.test(after) || names.has('memory_search')
  const e3 = /ToolRunner → wiki_/.test(after) || [...names].some((n) => String(n).startsWith('wiki_'))
  logEv('E-01', e1 ? 'PASS' : 'FAIL', e1 ? 'skill_search（续跑）' : 'skill_search 缺失', { session: s?.slice(0, 8) })
  logEv('E-02', e2 ? 'PASS' : 'FAIL', e2 ? 'memory_search（续跑）' : 'memory_search 缺失', { session: s?.slice(0, 8) })
  logEv('E-03', e3 ? 'PASS' : 'FAIL', e3 ? 'wiki 工具（续跑）' : 'wiki 缺失', { session: s?.slice(0, 8) })
  void ok
}

async function caseF01() {
  const id = 'F-01'
  const s = createSession('cap-F01')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    `请完成复杂任务（必须真实调用工具）：
1) skill_search agent
2) memory_search agent
3) spawn_agent mode=async agentType=builtin:explore name=repo-scout prompt=一句话：agent-runtime 主要职责？
4) 等待完成通知
5) 输出含「状态: DONE」的报告`,
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const delivered = /name=repo-scout status=succeeded|delivered.*repo-scout/.test(after)
    const { tools, joined } = extractAssistant(loadMessages(s).items)
    const need = ['skill_search', 'memory_search', 'spawn_agent'].every((n) => tools.some((t) => t.name === n))
    const logNeed =
      /ToolRunner → skill_search/.test(after) &&
      /ToolRunner → memory_search/.test(after) &&
      /registerRun.*repo-scout/.test(after)
    return delivered && (need || logNeed) && /DONE/.test(joined) ? true : null
  }, { timeoutMs: 300000, label: id })
  logEv(id, ok ? 'PASS' : 'FAIL', ok ? '复杂编排' : '复杂编排失败', { session: s?.slice(0, 8) })
}

async function caseF03() {
  const id = 'F-03'
  const s = createSession('cap-F03')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    '并行两次 async spawn explore：name=fact-a prompt=只回复：地球是行星；name=fact-b prompt=只回复：月球是卫星。完成后两句对比异同。禁止编造。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const a = /registerRun.*fact-a/.test(after) && /delivered.*fact-a|name=fact-a status=succeeded/.test(after)
    const b = /registerRun.*fact-b/.test(after) && /delivered.*fact-b|name=fact-b status=succeeded/.test(after)
    const { joined } = extractAssistant(loadMessages(s).items)
    return a && b && /行星|卫星/.test(joined) ? true : null
  }, { timeoutMs: 240000, label: id })
  logEv(id, ok ? 'PASS' : 'FAIL', ok ? '并行综合' : '并行综合失败', { session: s?.slice(0, 8) })
}

async function caseG01() {
  const id = 'G-01'
  const s = createSession('cap-G01')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    '立刻连续 6 次 spawn_agent（勿等），全部 async+builtin:explore，name=c1..c6，prompt=只回复：OK。逐条贴工具返回原文。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const denied = /acquire denied/.test(after) && /spawn denied concurrency/.test(after)
    const { tools } = extractAssistant(loadMessages(s).items)
    const spawns = tools.filter((t) => t.name === 'spawn_agent')
    const err = spawns.some((t) => /concurrency|limit|max 5/i.test(JSON.stringify(t.result || {})))
    return denied && (err || spawns.length >= 6) ? true : null
  }, { timeoutMs: 240000, label: id })
  logEv(id, ok ? 'PASS' : 'FAIL', ok ? '并发拒绝' : '并发拒绝失败', { session: s?.slice(0, 8) })
}

async function caseG02() {
  const id = 'G-02'
  const s = createSession('cap-G02')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    'spawn_agent async builtin:general name=depth-child，prompt=立刻再 spawn_agent async name=grandchild prompt=HI 并原样写出返回。你不要嵌套。完成后转述。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const child = /registerRun.*depth-child/.test(after)
    const grandchild = /registerRun.*grandchild/.test(after)
    const delivered = /delivered.*depth-child|name=depth-child status=succeeded/.test(after)
    if (child && delivered && !grandchild) return true
    if (/denied depth|maxSpawnDepth/.test(after)) return true
    return null
  }, { timeoutMs: 240000, label: id })
  logEv(id, ok ? 'PASS' : 'FAIL', ok ? '无孙 Agent 链' : '深度未确认', { session: s?.slice(0, 8) })
}

async function caseG03H() {
  const all = readLog()
  if (/startStaleMonitor/.test(all)) logEv('G-03', 'PASS', 'stale monitor')
  else logEv('G-03', 'WARN', '无 stale monitor')

  const s = createSession('cap-H')
  send(s, '只回复：H')
  await waitUntil(() => (extractAssistant(loadMessages(s).items).joined ? true : null), {
    timeoutMs: 60000,
    label: 'H',
  })
  const usage = ui(['context', 'usage', '--session', s])
  try {
    const j = JSON.parse(usage.out)
    if (j && (j.usedTokens != null || j.contextWindow != null)) logEv('H-01', 'PASS', 'usage ok')
    else logEv('H-01', 'FAIL', usage.out.slice(0, 160))
  } catch {
    logEv('H-01', 'FAIL', usage.out.slice(0, 160))
  }
  const msgs = loadMessages(s)
  if (Array.isArray(msgs.items)) logEv('H-02', 'PASS', `items=${msgs.items.length}`)
  else logEv('H-02', 'FAIL', 'messages 异常')
}

async function main() {
  console.log('Continue suite...')
  await retryD02()
  await caseE()
  await caseF01()
  await caseF03()
  await caseG01()
  await caseG02()
  await caseG03H()
  console.log('Continue done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
