#!/usr/bin/env node
/**
 * 指针使用探针 —— 测「注入块里的 `[d:xxxx]` 会不会被用上」。
 *
 * 判据是**数据库里的工具调用记录**，不是回答质量（后者要人判断，不可重复）。
 * 每轮记录：调了哪些记忆工具、有没有 memory_read、读的是不是注入给它的那个 drawer。
 *
 * 用法：
 *   node scripts/probe-pointer-usage.mjs <标签>
 * 输出：控制台 + ~/.lumii/data/probe-pointer-<标签>.json
 *
 * 为什么需要它：2026-09-18 想验证「注入的指针会不会被用上」，前两次都得出**相反
 * 结论**——第一次判据写错（字段名 `tool_call` vs 实际 `type:'tool'`）得出"模型从不
 * 读原文"，实际它一轮读了 4 次；第二次单轮 n=1 又读到 4 次。这说明：**改文案的效果
 * 既不能靠直觉预测，也不能靠单次运行判定。**
 *
 * 已用它得出的结论（每组 3 轮）：
 * - 旧文案（memory_read 写着"先用 memory_search"）→ 命中 1/3
 * - 只改注入块图例 → 1/3（**无效**，图例单独用等于没改）
 * - 改工具描述 + 记忆指南 → 6/9
 *
 * **局限**：n=3~9，且实测同一变体重跑会有 1/3 ↔ 3/3 的抖动（`logs-12328` 探针最明显）。
 * 它能区分"有效/无效"这种量级差异，区分不了 10% 级别的差异——小改动别指望它给结论。
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

/**
 * 一个探针跑一轮：发问 → 等轮次结束 → 取工具调用。
 *
 * **轮次完成的判据是「库里出现 assistant 消息」，不是固定 sleep**：固定 75s 在
 * 长轮次上会截断（实测有轮次跑了 2 分钟还在调工具），把"还在跑"误判成"没读原文"。
 */
async function runProbe(label, p, attempt) {
  const sessionKey = `probe-${label}-${p.id}-${Date.now()}`
  await send(sessionKey, p.q)

  let calls = []
  let prevCount = -1
  for (let i = 0; i < 40; i++) {
    await sleep(8000)
    calls = toolCalls(sessionKey)
    const hasReply = (() => {
      const db = new DatabaseSync(DB, { readOnly: true })
      try {
        return (
          (db
            .prepare(
              "SELECT COUNT(*) c FROM messages WHERE conversation_id = ? AND role = 'assistant'",
            )
            .get(sessionKey)?.c ?? 0) > 0
        )
      } finally {
        db.close()
      }
    })()
    // 已有回复且工具集连续两轮不变 → 视为结束（再等一轮防止工具调用与回复交错）
    if (hasReply && calls.length === prevCount) break
    prevCount = calls.length
  }

  const seq = calls.map((c) => c.tool)
  const readIdx = seq.indexOf('memory_read')
  const searchIdx = seq.indexOf('memory_search')
  const readIds = calls
    .filter((c) => c.tool === 'memory_read')
    .map((c) => String(c.args.drawerId ?? '').toLowerCase())
  // 核心指标：读了「注入块里给过指针」的那个抽屉
  const usedInjectPointer = readIds.includes(p.drawer)
  const readBeforeSearch = readIdx >= 0 && (searchIdx < 0 || readIdx < searchIdx)

  console.log(
    `  [${label}] ${p.id.padEnd(13)} 读${seq.filter((t) => t === 'memory_read').length}个` +
      ` 命中注入指针=${usedInjectPointer ? '✅' : '❌'} 开场即读=${readBeforeSearch ? '✅' : '❌'}` +
      `  | ${seq.join('→') || '(无)'}`,
  )

  return {
    probe: p.id,
    attempt,
    drawer: p.drawer,
    seq,
    searched: seq.filter((t) => t === 'memory_search').length,
    read: seq.filter((t) => t === 'memory_read').length,
    usedInjectPointer,
    readBeforeSearch,
  }
}


// 并发跑：三个探针互不影响（不同 sessionKey = 不同 Agent 实例）
const label = process.argv[2]
if (!label) {
  console.error('用法: node scripts/probe-pointer-usage.mjs <标签>')
  process.exit(2)
}

console.log(`▶ [${label}] 并发跑 ${PROBES.length} 个探针…`)
const results = await Promise.all(PROBES.map((p) => runProbe(label, p, 1)))

const out = join(DATA, `probe-pointer-${label}.json`)
writeFileSync(out, JSON.stringify({ label, at: new Date().toISOString(), results }, null, 2), 'utf-8')

console.log(`\n═══ [${label}] 汇总 ═══`)
const hit = results.filter((r) => r.usedInjectPointer).length
const early = results.filter((r) => r.readBeforeSearch).length
console.log(`  命中注入指针: ${hit}/${results.length}`)
console.log(`  开场即读原文: ${early}/${results.length}  ← 搜索之前读，只可能来自注入`)
console.log(
  `  总搜索 ${results.reduce((a, r) => a + r.searched, 0)} 次 / 总读原文 ${results.reduce((a, r) => a + r.read, 0)} 次`,
)
console.log(`  明细: ${out}`)

