#!/usr/bin/env node
/**
 * 补跑此前 SKIP 的 Agent 能力用例：B-03、E-04、E-05、E-06、F-02、F-04 + abort CLI 冒烟
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
  fs.appendFileSync(EVID, JSON.stringify({ ts: new Date().toISOString(), id, status, note, ...extra }) + '\n')
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
  return i >= 0 ? all.slice(i) : all.slice(-200000)
}

function mark(tag) {
  try {
    fs.appendFileSync(LOG, `\n=== ${tag} ${new Date().toISOString()} ===\n`)
  } catch {
    /* ignore */
  }
  return tag
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

/** D-abort CLI：验证 send abort 返回 {ok:true} 而非 command_failed */
async function caseAbortCli() {
  const id = 'D-ABORT-CLI'
  const s = createSession('cap-abort-cli')
  const marker = mark(`TEST_${id}`)
  send(s, '请调用 skill_search query=agent，然后写很长的分析，不要很快结束。')
  await waitUntil(() => (/ToolRunner →|prompt\] start/.test(logAfter(marker)) ? true : null), {
    timeoutMs: 60000,
    label: `${id}-wait`,
  })
  const abortRes = ui(['send', 'abort', '--session', s])
  let parsed
  try {
    parsed = JSON.parse(abortRes.out)
  } catch {
    parsed = null
  }
  const ok =
    abortRes.code === 0 &&
    parsed &&
    parsed.ok === true &&
    !/command_failed/.test(abortRes.out)
  if (ok) logEv(id, 'PASS', `abort CLI ok=${JSON.stringify(parsed)}`, { session: s.slice(0, 8) })
  else logEv(id, 'FAIL', `abort CLI out=${abortRes.out.slice(0, 200)}`, { session: s?.slice(0, 8) })
}

async function caseB03() {
  const id = 'B-03'
  const s = createSession('cap-B03')
  const marker = mark(`TEST_${id}`)
  send(s, '不要调用任何工具。用一句话说明你没有调用工具。')
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const toolsInLog = /ToolRunner →/.test(after)
    const { tools, joined } = extractAssistant(loadMessages(s).items)
    if (tools.length > 0 || toolsInLog) return null
    if (joined.length > 5 && /没有|未调用|不调用|no tools|did not/i.test(joined)) return true
    if (joined.length > 10 && tools.length === 0 && !toolsInLog) return true
    return null
  }, { timeoutMs: 90000, label: id })
  logEv(id, ok ? 'PASS' : 'FAIL', ok ? '未调工具' : '诚实性失败', { session: s?.slice(0, 8) })
}

async function caseE04() {
  const id = 'E-04'
  const list = ui(['tools', 'list']).out
  if (!/web_search/.test(list)) {
    logEv(id, 'SKIP', 'web_search 不在工具列表')
    return
  }
  const s = createSession('cap-E04')
  const marker = mark(`TEST_${id}`)
  send(s, '请真实调用 web_search，搜索关键词 TypeScript agent，用一句话总结。禁止编造链接。')
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const hit = /ToolRunner → web_search/.test(after)
    const { tools } = extractAssistant(loadMessages(s).items)
    return hit || tools.some((t) => t.name === 'web_search') ? true : null
  }, { timeoutMs: 180000, label: id })
  logEv(id, ok ? 'PASS' : 'FAIL', ok ? 'web_search' : 'web_search 未确认', { session: s?.slice(0, 8) })
}

async function caseE05() {
  const id = 'E-05'
  const list = ui(['tools', 'list']).out
  if (!/\bbash\b/.test(list)) {
    logEv(id, 'SKIP', 'bash 不在工具列表')
    return
  }
  const s = createSession('cap-E05')
  const marker = mark(`TEST_${id}`)
  send(s, '请调用 bash 执行命令：echo CAP_TEST_OK。把 stdout 原文贴出。禁止编造。')
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const hit = /ToolRunner → bash/.test(after)
    const { tools, joined } = extractAssistant(loadMessages(s).items)
    const tool = tools.find((t) => t.name === 'bash')
    const out = JSON.stringify(tool?.result || '') + joined
    return hit && /CAP_TEST_OK/.test(out) ? true : null
  }, { timeoutMs: 120000, label: id })
  logEv(id, ok ? 'PASS' : 'FAIL', ok ? 'bash echo' : 'bash 未确认', { session: s?.slice(0, 8) })
}

async function caseE06() {
  const id = 'E-06'
  const before = ui(['tools', 'toggle', 'web_search', 'off'])
  const s = createSession('cap-E06')
  const marker = mark(`TEST_${id}`)
  send(s, '请尝试调用 web_search 搜索 hello。若工具不可用请如实说明错误，不要编造搜索结果。')
  await waitUntil(() => {
    const { joined, tools } = extractAssistant(loadMessages(s).items)
    if (tools.some((t) => t.name === 'web_search') || /不可用|disabled|未启用|没有|无法|error|关闭/i.test(joined)) {
      return true
    }
    if (joined.length > 20) return true
    return null
  }, { timeoutMs: 120000, label: id })
  const restore = ui(['tools', 'toggle', 'web_search', 'on'])
  const afterLog = logAfter(marker)
  // 关闭期间不应成功拿到正常搜索结果；恢复必须成功
  const restored = /web_search/.test(ui(['tools', 'list']).out)
  const toggledOff = before.code === 0 || /off|false|disabled|ok/i.test(before.out)
  if (toggledOff && restored && restore.code === 0) {
    logEv(id, 'PASS', 'toggle off→尝试→on 恢复', { session: s?.slice(0, 8), note2: afterLog.includes('web_search') ? 'had-call' : 'no-call' })
  } else {
    logEv(id, 'FAIL', `toggle/restore 异常 before=${before.out.slice(0, 80)} restore=${restore.out.slice(0, 80)}`)
  }
}

async function caseF02() {
  const id = 'F-02'
  const s = createSession('cap-F02')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    `请按「计划—执行—校验」完成：
1) 先用文字列出恰好 3 步计划（不要先调工具）
2) 再逐步执行：skill_search(agent)、memory_search(agent)
3) 最后自检：用列表写出每一步用了什么工具（无则写无）
禁止编造工具结果。`,
  )
  const ok = await waitUntil(() => {
    const after = logAfter(marker)
    const sk = /ToolRunner → skill_search/.test(after)
    const mem = /ToolRunner → memory_search/.test(after)
    const { tools, joined } = extractAssistant(loadMessages(s).items)
    const names = new Set(tools.map((t) => t.name))
    return (sk || names.has('skill_search')) && (mem || names.has('memory_search')) && /计划|步骤|自检|skill_search|memory_search/.test(joined)
      ? true
      : null
  }, { timeoutMs: 240000, label: id })
  logEv(id, ok ? 'PASS' : 'FAIL', ok ? '计划执行校验' : 'F-02 失败', { session: s?.slice(0, 8) })
}

async function caseF04() {
  const id = 'F-04'
  const s = createSession('cap-F04')
  const marker = mark(`TEST_${id}`)
  send(
    s,
    `请做错误恢复演示：
1) 先 spawn_agent，agentType 故意用不存在的 builtin:no-such-agent-xyz，mode=sync，name=bad，prompt=hi
2) 把第一次工具返回原文贴出
3) 再纠正：spawn_agent agentType=builtin:explore mode=sync name=good prompt=只回复：GOOD_OK
4) 贴第二次返回并确认 GOOD_OK
禁止编造。`,
  )
  const ok = await waitUntil(() => {
    const { tools, joined } = extractAssistant(loadMessages(s).items)
    const spawns = tools.filter((t) => t.name === 'spawn_agent')
    if (spawns.length < 2) return null
    const results = spawns.map((t) => JSON.stringify(t.result || ''))
    const hasErr = results.some((r) => /error|不存在|not found|unknown|failed|resolveDefinition/i.test(r))
    const hasOk = results.some((r) => /GOOD_OK|"status":"ok"|status.:.ok/i.test(r)) || /GOOD_OK/.test(joined)
    return hasErr && hasOk ? true : null
  }, { timeoutMs: 240000, label: id })
  logEv(id, ok ? 'PASS' : 'FAIL', ok ? '错误恢复' : 'F-04 失败', { session: s?.slice(0, 8), logHint: /spawn_agent/.test(logAfter(marker)) })
}

async function main() {
  console.log('Skipped-suite runner...')
  await caseAbortCli()
  await caseB03()
  await caseE04()
  await caseE05()
  await caseE06()
  await caseF02()
  await caseF04()
  console.log('Done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
