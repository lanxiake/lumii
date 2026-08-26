#!/usr/bin/env node
/**
 * Agent 能力 CLI E2E 执行器：按用例发消息、轮询消息/日志、写入 evidence JSONL。
 * 用法：node docs/test/run-agent-capability-suite.mjs
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

/** 调用 lumii-ui，返回 stdout 文本 */
function ui(args, input) {
  const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 20 * 1024 * 1024,
  })
  return {
    code: r.status ?? 1,
    out: (r.stdout || '') + (r.stderr || ''),
  }
}

/** 追加一条证据 */
function logEv(id, status, note, extra = {}) {
  const row = { ts: new Date().toISOString(), id, status, note, ...extra }
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n', 'utf8')
  console.log(`[${id}] ${status} — ${note}`)
}

/** 读取日志自 marker 起的文本（Windows 下文件可能短暂 EBUSY） */
function logAfter(marker) {
  if (!fs.existsSync(LOG)) return ''
  let all = ''
  for (let i = 0; i < 8; i++) {
    try {
      all = fs.readFileSync(LOG, 'utf8')
      break
    } catch (e) {
      if (e && e.code === 'EBUSY') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
        continue
      }
      throw e
    }
  }
  if (!all) return ''
  const i = all.lastIndexOf(marker)
  return i >= 0 ? all.slice(i) : all.slice(-200000)
}

/** 解析 messages items */
function loadMessages(session) {
  const { out } = ui(['context', 'messages', '--session', session, '--limit', '80'])
  try {
    return JSON.parse(out)
  } catch {
    return { items: [], raw: out.slice(0, 500) }
  }
}

/** 从 assistant contentJson 提取 tools / 可见文本 */
function extractAssistant(items) {
  const tools = []
  const texts = []
  for (const m of items || []) {
    if (m.role !== 'assistant') continue
    try {
      const cj = JSON.parse(m.contentJson || '{}')
      for (const p of cj.parts || []) {
        if (p.type === 'tool') {
          tools.push({
            name: p.name,
            args: p.args,
            isError: !!p.isError,
            result: p.result,
          })
        }
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

/** 轮询直到 pred 为真或超时 */
async function waitUntil(pred, { timeoutMs = 180000, intervalMs = 4000, label = '' } = {}) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeoutMs) {
    last = await pred()
    if (last) return last
    process.stdout.write(`.`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  console.log(`\n[timeout ${label}]`)
  return null
}

function createSession(title) {
  const { out } = ui(['conversation', 'create', '--title', title])
  try {
    return JSON.parse(out).sessionKey
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
  fs.appendFileSync(LOG, `\n=== ${tag} ${new Date().toISOString()} ===\n`, 'utf8')
  return tag
}

async function caseB01() {
  const id = 'B-01'
  const s = createSession('cap-B01')
  mark(`TEST_${id}`)
  send(s, '只回复四个字：测试通过。不要调用工具。')
  const ok = await waitUntil(() => {
    const { texts, joined, tools } = extractAssistant(loadMessages(s).items)
    if (tools.length > 0) return null
    if (/测试通过/.test(joined) && texts.some((t) => t.includes('测试通过'))) {
      return { joined: joined.slice(0, 200) }
    }
    return null
  }, { label: id, timeoutMs: 90000 })
  if (ok) logEv(id, 'PASS', '指令遵循', { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', '未看到测试通过', { session: s?.slice(0, 8) })
}

async function caseB02() {
  const id = 'B-02'
  const s = createSession('cap-B02')
  mark(`TEST_${id}`)
  send(s, '请记住暗号 ALPHA-42。本轮只回复：已记住。不要调用工具。')
  await waitUntil(() => /已记住|ALPHA-42/.test(extractAssistant(loadMessages(s).items).joined), {
    timeoutMs: 90000,
    label: `${id}-1`,
  })
  send(s, '暗号是什么？只回复暗号本身。不要调用工具。')
  const ok = await waitUntil(() => {
    const { joined } = extractAssistant(loadMessages(s).items)
    // 第二轮 assistant 需含暗号；避免仅用户消息
    const items = loadMessages(s).items || []
    const assistants = items.filter((m) => m.role === 'assistant')
    if (assistants.length < 2) return null
    const last = extractAssistant([assistants[assistants.length - 1]]).joined
    return /ALPHA-42/.test(last) ? { last } : null
  }, { timeoutMs: 90000, label: id })
  if (ok) logEv(id, 'PASS', '多轮保持 ALPHA-42', { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', '第二轮未复述暗号', { session: s?.slice(0, 8) })
}

async function caseC01() {
  const id = 'C-01'
  const s = createSession('cap-C01')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    '请立刻调用一次 spawn_agent：mode=sync，agentType=builtin:explore，name=sync-1，prompt=只回复一句：SYNC_OK。然后把工具返回里的关键结果原文贴出。禁止编造。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const finalized = /registerRun.*sync-1.*mode=sync/.test(after) && /finalizeRun.*succeeded/.test(after)
    const { tools, joined } = extractAssistant(loadMessages(s).items)
    const spawn = tools.find((t) => t.name === 'spawn_agent' && t.args?.name === 'sync-1')
    const resultStr = JSON.stringify(spawn?.result || {})
    if (finalized && spawn && (/SYNC_OK/.test(resultStr) || /SYNC_OK/.test(joined))) {
      return true
    }
    return null
  }, { timeoutMs: 180000, label: id })
  if (ok) logEv(id, 'PASS', 'sync spawn+finalize', { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', 'sync 未完成', { session: s?.slice(0, 8) })
}

async function caseC02() {
  const id = 'C-02'
  const s = createSession('cap-C02')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    '请严格执行：1) 两次 spawn_agent mode=async agentType=builtin:explore：name=async-a prompt=只回复：A_OK；name=async-b prompt=只回复：B_OK。2) 等待两条系统完成通知后，用两行汇总 A_OK 与 B_OK。禁止编造。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const a = /registerRun.*async-a/.test(after)
    const b = /registerRun.*async-b/.test(after)
    const delA = /delivered.*async-a|name=async-a status=succeeded/.test(after)
    const delB = /delivered.*async-b|name=async-b status=succeeded/.test(after)
    const destroyed = (after.match(/child destroyed after delivery/g) || []).length >= 2
    const { joined } = extractAssistant(loadMessages(s).items)
    if (a && b && delA && delB && destroyed && /A_OK/.test(joined) && /B_OK/.test(joined)) return true
    return null
  }, { timeoutMs: 240000, label: id })
  if (ok) logEv(id, 'PASS', '双 async 投递+汇总', { session: s.slice(0, 8) })
  else {
    const after = logAfter(marker)
    logEv(id, 'FAIL', '双 async 未满足', {
      session: s?.slice(0, 8),
      hints: {
        a: /async-a/.test(after),
        b: /async-b/.test(after),
        delivery: (after.match(/subagent-delivery/g) || []).length,
      },
    })
  }
}

async function caseC04(dependsMarkerHint = 'TEST_C-02') {
  const id = 'C-04'
  const after = logAfter(dependsMarkerHint)
  const n = (after.match(/\[Subagent\] complete/g) || []).length
  if (n >= 2) logEv(id, 'PASS', `IPC complete x${n}`)
  else logEv(id, 'FAIL', `IPC complete only ${n}`)
}

async function caseD01D02() {
  const id1 = 'D-01'
  const id2 = 'D-02'
  const s = createSession('cap-D01')
  const marker = mark(`TEST_${id1}`)
  send(
    s,
    '请执行长任务：依次调用 skill_search(agent)、memory_search(agent)、web_search(TypeScript agent)，然后写 1000 字分析。逐步执行不要跳过。',
  )
  await waitUntil(() => {
    const after = logAfter(marker)
    return /ToolRunner →|prompt\] start/.test(after) ? true : null
  }, { timeoutMs: 60000, label: `${id1}-wait` })
  abort(s)
  await new Promise((r) => setTimeout(r, 2500))
  const after = logAfter(marker)
  const aborted = /Aborted agent/.test(after) && /abortSession/.test(after)
  if (aborted) logEv(id1, 'PASS', 'abort 生效', { session: s.slice(0, 8) })
  else logEv(id1, 'FAIL', '未见 abort 日志', { session: s.slice(0, 8) })

  mark(`TEST_${id2}`)
  send(s, '刚才已中止。请只回复四个字：恢复成功。不要调用工具。')
  const ok = await waitUntil(() => {
    const items = loadMessages(s).items || []
    const assistants = items.filter((m) => m.role === 'assistant')
    if (!assistants.length) return null
    const last = extractAssistant([assistants[assistants.length - 1]]).joined
    return /恢复成功/.test(last) ? true : null
  }, { timeoutMs: 90000, label: id2 })
  if (ok) logEv(id2, 'PASS', 'abort 后可恢复', { session: s.slice(0, 8) })
  else logEv(id2, 'FAIL', '恢复回复缺失', { session: s.slice(0, 8) })
}

async function caseD03() {
  const id = 'D-03'
  const s = createSession('cap-D03')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    '立刻两次 spawn_agent mode=async agentType=builtin:explore：name=long-a prompt=先 web_search orchestration 再写500字；name=long-b prompt=先 skill_search agent 再写500字。启动后只等待完成通知，不要总结。',
  )
  await waitUntil(() => {
    const after = logAfter(marker)
    return /registerRun.*long-a/.test(after) && /registerRun.*long-b/.test(after) ? true : null
  }, { timeoutMs: 180000, label: `${id}-spawn` })
  abort(s)
  await new Promise((r) => setTimeout(r, 3500))
  const after = logAfter(marker)
  const cascades = (after.match(/Aborted agent \(cascade\)/g) || []).length
  if (cascades >= 2) logEv(id, 'PASS', `cascade abort x${cascades}`, { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', `cascade=${cascades}`, { session: s.slice(0, 8) })
}

async function caseE01E02() {
  const s = createSession('cap-E')
  const marker = mark('TEST_E-01')
  send(
    s,
    '请依次真实调用：1) skill_search query=agent 2) memory_search query=agent。然后用两行报告命中概况。禁止编造工具结果。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const sk = /ToolRunner → skill_search/.test(after)
    const mem = /ToolRunner → memory_search/.test(after)
    const { tools } = extractAssistant(loadMessages(s).items)
    const hasSk = tools.some((t) => t.name === 'skill_search')
    const hasMem = tools.some((t) => t.name === 'memory_search')
    return sk && mem && hasSk && hasMem ? true : null
  }, { timeoutMs: 180000, label: 'E' })
  if (ok) {
    logEv('E-01', 'PASS', 'skill_search', { session: s.slice(0, 8) })
    logEv('E-02', 'PASS', 'memory_search', { session: s.slice(0, 8) })
  } else {
    logEv('E-01', 'FAIL', 'skill_search 未确认', { session: s?.slice(0, 8) })
    logEv('E-02', 'FAIL', 'memory_search 未确认', { session: s?.slice(0, 8) })
  }
}

async function caseE03() {
  const id = 'E-03'
  const s = createSession('cap-E03')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    '请调用 wiki_overview 或 wiki_search（关键词 agent）。若无内容请诚实说明。禁止编造页面。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const hit = /ToolRunner → wiki_overview|ToolRunner → wiki_search/.test(after)
    const { tools } = extractAssistant(loadMessages(s).items)
    const t = tools.find((x) => x.name === 'wiki_overview' || x.name === 'wiki_search')
    return hit && t && !t.isError ? true : null
  }, { timeoutMs: 120000, label: id })
  if (ok) logEv(id, 'PASS', 'wiki 工具', { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', 'wiki 工具未确认', { session: s?.slice(0, 8) })
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
3) spawn_agent mode=async agentType=builtin:explore name=repo-scout prompt=一句话：agent-runtime 主要职责是什么？
4) 等待完成通知
5) 输出：
## 复杂任务报告
- 技能命中数: <n>
- 记忆命中: <有/无>
- 子Agent结论: <一句>
- 状态: DONE`,
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const delivered = /delivered.*repo-scout|name=repo-scout status=succeeded/.test(after)
    const { tools, joined } = extractAssistant(loadMessages(s).items)
    const need = ['skill_search', 'memory_search', 'spawn_agent']
    const hasTools = need.every((n) => tools.some((t) => t.name === n))
    return delivered && hasTools && /状态:\s*\*?\*?DONE/.test(joined) ? true : null
  }, { timeoutMs: 300000, label: id })
  if (ok) logEv(id, 'PASS', '多工具+子Agent报告', { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', '复杂编排未完成', { session: s?.slice(0, 8) })
}

async function caseF03() {
  const id = 'F-03'
  const s = createSession('cap-F03')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    '请并行 spawn 两个 async explore：name=fact-a prompt=只回复：地球是行星；name=fact-b prompt=只回复：月球是卫星。等待两条完成后，用两句对比它们的异同。禁止编造。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const a = /registerRun.*fact-a/.test(after) && /delivered.*fact-a|name=fact-a status=succeeded/.test(after)
    const b = /registerRun.*fact-b/.test(after) && /delivered.*fact-b|name=fact-b status=succeeded/.test(after)
    const { joined } = extractAssistant(loadMessages(s).items)
    return a && b && /行星|卫星/.test(joined) ? true : null
  }, { timeoutMs: 240000, label: id })
  if (ok) logEv(id, 'PASS', '并行调研综合', { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', '并行综合失败', { session: s?.slice(0, 8) })
}

async function caseG01() {
  const id = 'G-01'
  const s = createSession('cap-G01')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    '请立刻连续 6 次 spawn_agent（不要等待），全部 mode=async agentType=builtin:explore，name=c1..c6，prompt=只回复：OK。然后逐条列出工具返回原文（含失败原因）。禁止编造成功。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const denied = /acquire denied/.test(after) && /spawn denied concurrency/.test(after)
    const { tools } = extractAssistant(loadMessages(s).items)
    const spawns = tools.filter((t) => t.name === 'spawn_agent')
    const err = spawns.some((t) => /concurrency|limit|max 5/i.test(JSON.stringify(t.result || {})))
    return denied && err && spawns.length >= 6 ? true : null
  }, { timeoutMs: 240000, label: id })
  if (ok) logEv(id, 'PASS', '第6次并发拒绝', { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', '并发拒绝未确认', { session: s?.slice(0, 8) })
}

async function caseG02() {
  const id = 'G-02'
  const s = createSession('cap-G02')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    '请 spawn_agent mode=async agentType=builtin:general name=depth-child，prompt=立刻再调用 spawn_agent mode=async name=grandchild prompt=HI，并原样写出工具返回。你自己不要嵌套。等待子完成后转述二次 spawn 结果。',
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const child = /registerRun.*depth-child/.test(after)
    const grandchild = /registerRun.*grandchild/.test(after)
    const delivered = /delivered.*depth-child|name=depth-child status=succeeded/.test(after)
    // 通过：有子完成，且无孙 registerRun
    if (child && delivered && !grandchild) return true
    // 或明确 depth deny
    if (/denied depth|maxSpawnDepth/.test(after)) return true
    return null
  }, { timeoutMs: 240000, label: id })
  if (ok) logEv(id, 'PASS', '无成功孙 Agent 链', { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', '深度行为未确认', { session: s?.slice(0, 8) })
}

async function caseG03() {
  const id = 'G-03'
  const all = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
  if (/startStaleMonitor/.test(all)) logEv(id, 'PASS', 'stale monitor 已启动')
  else logEv(id, 'WARN', '未见 startStaleMonitor')
}

async function caseH01H02() {
  const s = createSession('cap-H')
  send(s, '只回复：H')
  await waitUntil(() => extractAssistant(loadMessages(s).items).joined.length > 0, {
    timeoutMs: 60000,
    label: 'H-prep',
  })
  const usage = ui(['context', 'usage', '--session', s])
  try {
    const j = JSON.parse(usage.out)
    if (j && (j.usedTokens != null || j.contextWindow != null || j.ok !== false)) {
      logEv('H-01', 'PASS', 'context usage', { preview: JSON.stringify(j).slice(0, 180) })
    } else logEv('H-01', 'FAIL', usage.out.slice(0, 200))
  } catch {
    logEv('H-01', 'FAIL', usage.out.slice(0, 200))
  }
  const msgs = loadMessages(s)
  if (Array.isArray(msgs.items) && msgs.items.length <= 80) logEv('H-02', 'PASS', `items=${msgs.items.length}`)
  else logEv('H-02', 'FAIL', 'messages 异常')
}

async function main() {
  console.log('Agent capability suite starting...')
  fs.appendFileSync(LOG, `\n=== AGENT_CAP_SUITE_RUNNER ${new Date().toISOString()} ===\n`, 'utf8')

  // A already partially done; re-check A-01
  const tools = ui(['tools', 'list'])
  if (/spawn_agent/.test(tools.out)) logEv('A-01', 'PASS', 'spawn_agent present')
  else logEv('A-01', 'FAIL', 'no spawn_agent')

  await caseB01()
  await caseB02()
  await caseC01()
  await caseC02()
  await caseC04('TEST_C-02')
  await caseD01D02()
  await caseD03()
  await caseE01E02()
  await caseE03()
  await caseF01()
  await caseF03()
  await caseG01()
  await caseG02()
  await caseG03()
  await caseH01H02()

  console.log('\nDone. Evidence:', EVID)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
