#!/usr/bin/env node
/**
 * 指针使用探针 —— 测「注入块里的 `[d:xxxx]` 会不会被模型用上」。
 *
 * 判据是**数据库里的工具调用记录**，不是回答质量（后者要人判断，不可重复）。
 * 每轮记录：调了哪些记忆工具、有没有 memory_read、读的是哪个 drawer。
 *
 * 用法：
 *   node scripts/probe-pointer-usage.mjs <标签>
 * 输出：控制台 + ~/.lumii/data/probe-pointer-<标签>.json
 *
 * 为什么需要它：2026-09-18 实测模型**不用**注入的指针——它自己发起 memory_search、
 * 从摘录拼答案，`memory_read` 一次不调。改文案（图例 / 工具描述）的效果很难凭直觉
 * 预测，只能实测对比。
 */

import { request } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DATA = join(homedir(), '.lumii', 'data')
const DB = join(DATA, 'agent-runtime.db')
const cfg = JSON.parse(readFileSync(join(homedir(), '.lumii', 'runtime', 'app-ui.json'), 'utf8'))

/**
 * 探针：每个都用「注入摘要明显答不全、原文很厚」的记忆。
 *
 * 关键设计——**问题措辞不能要求"读原文"**，否则测的是服从性而不是自发性。
 * 只表达"我要细节/完整过程"，是否值得翻原文由模型自己判断。
 */
const PROBES = [
  {
    id: 'sjzh-service',
    drawer: '6888ae869706a8fd',
    q: 'sjzh-service 那个启动故障，当时排查的完整过程是什么',
    summaryChars: 296,
    originalChars: 48042,
  },
  {
    id: 'logs-12328',
    drawer: '3f36f1551df45a84',
    q: '12328 报送日志里那些反复出现的报错模式，具体是哪些，怎么处理的',
    summaryChars: 492,
    originalChars: 85033,
  },
  {
    id: 'tocc-sync',
    drawer: '851dc2648492000e',
    q: 'TOCC 数据同步到 12345 那个问题，排查的细节和结论是什么',
    summaryChars: 235,
    originalChars: 5511,
  },
]

const label = process.argv[2]
if (!label) {
  console.error('用法: node scripts/probe-pointer-usage.mjs <标签>')
  process.exit(2)
}

function send(sessionKey, content) {
  const body = JSON.stringify({
    type: 'user:send',
    sessionKey,
    content,
    msgId: `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`,
  })
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: cfg.port,
        path: '/command',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.token}`,
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => resolve(d))
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * 从库里取某会话的记忆工具调用序列。
 *
 * **字段名坑**：工具调用存在 `parts` 里、`type === 'tool'`，工具名在 `name`、
 * 参数在 `args`。一开始按 `type: 'tool_call'` / `toolName` 去找，永远匹配不到，
 * 得出过「模型没调 memory_read」的错误结论（实测它调了 4 次）。判据写错会得出
 * 完全相反的结果——这个函数的正确性比探针本身还重要。
 */
function toolCalls(convId) {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    const msgs = db
      .prepare('SELECT role, content_json FROM messages WHERE conversation_id = ? ORDER BY timestamp')
      .all(convId)
    const calls = []
    for (const m of msgs) {
      let o
      try {
        o = JSON.parse(m.content_json)
      } catch {
        continue
      }
      for (const p of Array.isArray(o.parts) ? o.parts : []) {
        if (p.type === 'tool' && typeof p.name === 'string' && /^memory_/.test(p.name)) {
          calls.push({ tool: p.name, args: p.args ?? {} })
        }
      }
    }
    return calls
  } finally {
    db.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
for (const p of PROBES) {
  const sessionKey = `probe-${label}-${p.id}-${Date.now()}`
  console.log(`\n▶ [${label}] ${p.id}  摘要${p.summaryChars}字/原文${p.originalChars}字`)
  console.log(`  Q: ${p.q}`)
  await send(sessionKey, p.q)
  // 等轮次跑完（工具调用 + 后续生成）
  await sleep(75_000)

  const calls = toolCalls(sessionKey)
  const seq = calls.map((c) => c.tool)
  const readIdx = seq.indexOf('memory_read')
  const searchIdx = seq.indexOf('memory_search')

  // **核心指标**：第一次读原文用的是不是注入里的那个 drawer
  const usedInjectPointer = calls.some(
    (c) =>
      c.tool === 'memory_read' && String(c.args.drawerId ?? '').toLowerCase() === p.drawer,
  )
  // **更锐利**：读原文发生在任何搜索**之前** → 只可能来自注入的指针（搜索还没发生）
  const readBeforeSearch = readIdx >= 0 && (searchIdx < 0 || readIdx < searchIdx)
  const searched = seq.filter((t) => t === 'memory_search').length
  const read = seq.filter((t) => t === 'memory_read').length

  console.log(`  工具: ${seq.join(' → ') || '（无）'}`)
  console.log(
    `  用过注入的指针: ${usedInjectPointer ? '✅' : '❌'}   搜索前先读原文: ${readBeforeSearch ? '✅' : '❌'}` +
      `   搜索 ${searched} / 读 ${read}`,
  )

  results.push({
    probe: p.id,
    drawer: p.drawer,
    seq,
    searched,
    read,
    usedInjectPointer,
    readBeforeSearch,
    calls,
  })
}

const out = join(DATA, `probe-pointer-${label}.json`)
writeFileSync(out, JSON.stringify({ label, at: new Date().toISOString(), results }, null, 2), 'utf-8')

console.log(`\n═══ [${label}] 汇总 ═══`)
const hit = results.filter((r) => r.usedInjectPointer).length
const early = results.filter((r) => r.readBeforeSearch).length
console.log(`  用过注入的指针: ${hit}/${results.length}`)
console.log(`  搜索前先读原文: ${early}/${results.length}  ← 只可能来自注入的指针`)
console.log(`  总搜索 ${results.reduce((a, r) => a + r.searched, 0)} 次 / 总读原文 ${results.reduce((a, r) => a + r.read, 0)} 次`)
console.log(`  明细: ${out}`)
