#!/usr/bin/env node
/**
 * 宫殿对照集 v6 —— 真实用户提问 × 前序归档（**无循环、可扩到 500+**）
 *
 * ## 为什么这一版才是对的
 *
 * v1 我挑 gold 我编查询（挑样偏差）；v3/v4 挖回忆式提问（本机只有 4~7 条，
 * 样本量不够）；v5 从 gold 里摘句子（**循环**——查询取自被检索的文档本身，
 * 重叠必然 1.0，测的是"抄得准不准"不是"找得到吗"）。
 *
 * v6 用真实用户提问当查询，但**不问它的来源会话**（那是循环），而问：
 * **这条提问之*后*归档的抽屉（同一会话、更晚时间）**。
 *
 * 判据是`char_count`。`palace_drawers.created_at` 是归档时刻，`char_count` 是
 * **归档那一刻**的字符数——当时这段原文只到那里。用**当前**原文去核
 * `slice(0, char_count)` 里的词语**确实都在**（模型问的、它自己说过的话）。
 *
 * 这是**真实的记忆检索场景**：同一会话跨天继续，用户提起之前的某事，
 * 归档里存着当时的原话。措辞必然与归档不完全一致（那是不同轮次的话），
 * 但**指向同一段上下文**——正是语义检索该起作用的地方。
 *
 * ## 已知局限（必须随结果一起报告）
 *
 * - 提问与「前序归档」的距离是**时间**上的，不是语义上的。同一会话里
 *   用户可能在聊完全无关的新话题——那这条 gold 就是错的。故额外记录
 *   `ctxOverlap`（提问与前序归档的 bigram 覆盖率），**按它分层统计**：
 *   低重叠档里混着"其实不该命中"的噪声，高重叠档才有干净的信号。
 * - 会话级过滤：生产 `memory_search` 只在**指定会话**时才查宫殿
 *   （`drawerIdsForSession`），而本集子给的是"会后会话提问"的形态。
 *   跑分脚本据此**不启用会话过滤**（`palace-prod-ab.mjs --no-session-filter`），
 *   与「跨会话回忆」这一真实用法一致。
 *
 * 用法：node scripts/mine-palace-eval-v6.mjs [--max 120]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const MAX = argv.includes('--max') ? Number(argv[argv.indexOf('--max') + 1]) : 120
const OUT = argv.includes('--out')
  ? argv[argv.indexOf('--out') + 1]
  : 'docs/test/memory-eval/palace-eval-set-v6.json'

// ── 与生产同口径的分词（内联自 segmentation.ts）──
const CJK_RE = /[㐀-䶿一-鿿]/
const TOKEN_SEG_RE = /[㐀-䶿一-鿿]+|[a-z0-9]+/g
function tokenizeBigram(text) {
  const t = new Set()
  if (!text) return t
  const m = text.toLowerCase().match(TOKEN_SEG_RE)
  if (!m) return t
  for (const seg of m) {
    if (CJK_RE.test(seg[0])) {
      if (seg.length === 1) t.add(seg)
      else for (let i = 0; i < seg.length - 1; i++) t.add(seg.slice(i, i + 2))
    } else t.add(seg)
  }
  return t
}

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'))

// 宫殿抽屉按会话 × 时间排序（升序）——用于给每条提问找"前序归档"
const drawerRows = db
  .prepare(
    `SELECT conversation_id cid, drawer_id id, content, char_count n, created_at
       FROM palace_drawers
      WHERE deleted_at IS NULL AND conversation_id IS NOT NULL
      ORDER BY conversation_id, created_at`,
  )
  .all()
const byConv = new Map()
for (const r of drawerRows) {
  if (!byConv.has(r.cid)) byConv.set(r.cid, [])
  byConv.get(r.cid).push(r)
}

// 真实用户提问：排除 cron/探针/进化/自主（那些不是"用户会怎么问"）
const userMsgs = db
  .prepare(
    `SELECT conversation_id cid, content_json cj, timestamp ts
       FROM messages
      WHERE role = 'user'
        AND conversation_id NOT LIKE 'cron:%'
        AND conversation_id NOT LIKE 'probe-%'
        AND conversation_id NOT LIKE 'evolution:%'
        AND conversation_id NOT LIKE 'autonomous%'
      ORDER BY timestamp`,
  )
  .all()

const set = []
const seenQuery = new Set()
for (const m of userMsgs) {
  let text = ''
  try {
    const o = JSON.parse(m.cj)
    text = typeof o.text === 'string' ? o.text.trim() : ''
  } catch {
    continue
  }
  if (!text || text.length < 12 || text.length > 80) continue
  // 排除语音转录（带方括号前缀）、文件引用、斜杠指令
  if (/^\[语音转录|^@|^\/|^\{/.test(text)) continue
  const key = text.slice(0, 30)
  if (seenQuery.has(key)) continue

  const drawers = byConv.get(m.cid)
  if (!drawers || drawers.length < 2) continue

  // 找"这条提问之前已归档、且归档时间早于提问"的抽屉里**最近的那条**。
  // 更早的也可以算 gold，但最近的那条是"同一会话上下文"最强的锚。
  const prior = drawers.filter((d) => d.created_at < m.ts)
  if (!prior.length) continue
  const gold = prior[prior.length - 1]

  // 因果校验：提问里的词，用**归档当时的原文**能不能核对上？
  // content.slice(0, char_count) 是归档那一刻的内容——之后的轮次不在里面。
  const snapshot = gold.content.slice(0, gold.n)
  if (snapshot.length < 100) continue

  const qt = tokenizeBigram(text)
  const dt = tokenizeBigram(snapshot)
  let inter = 0
  for (const t of qt) if (dt.has(t)) inter++
  const ctxOverlap = qt.size ? inter / qt.size : 0

  seenQuery.add(key)
  set.push({
    id: `v6-${gold.id.slice(0, 8)}-${m.ts.slice(11, 19).replace(/:/g, '')}`,
    query: text,
    gold: gold.id,
    expect: [text],
    ctxOverlap: Number(ctxOverlap.toFixed(3)),
    goldChars: gold.n,
    snapshotChars: snapshot.length,
    conversation: m.cid,
    askedAt: m.ts,
    goldArchivedAt: gold.created_at,
  })
}

// 分层：低重叠档才是"措辞不同但指同一段"，高重叠档接近抄写（对照用）
const buckets = { '0.00-0.20': 0, '0.20-0.40': 0, '0.40-0.60': 0, '0.60-0.80': 0, '0.80-1.00': 0 }
for (const s of set) {
  const o = s.ctxOverlap
  if (o < 0.2) buckets['0.00-0.20']++
  else if (o < 0.4) buckets['0.20-0.40']++
  else if (o < 0.6) buckets['0.40-0.60']++
  else if (o < 0.8) buckets['0.60-0.80']++
  else buckets['0.80-1.00']++
}
console.log(`可构造 ${set.length} 条（真实提问 × 前序归档）`)
console.log('按 ctxOverlap 分层：')
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: ${v}`)

// 取样：优先取 ctxOverlap 在 0.2~0.6 的"中等错配"档——那是最能分辨两套方案的区间；
// 不足再补高重叠档（它们当"精确类不能掉"的对照）
const mid = set.filter((s) => s.ctxOverlap >= 0.2 && s.ctxOverlap < 0.6)
const high = set.filter((s) => s.ctxOverlap >= 0.6)
const chosen = [...mid, ...high].slice(0, MAX)

console.log(`\n取 ${chosen.length} 条（中等错配 ${Math.min(mid.length, MAX)} 优先，高重叠补足）：`)
for (const s of chosen.slice(0, 12)) {
  console.log(`  [重叠${s.ctxOverlap} ${s.goldChars}字] ${s.query.slice(0, 52)}`)
}

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      _comment:
        'v6：查询=真实用户提问，gold=**同一会话中该提问之前归档的最近一条抽屉**。' +
        '因果性由 palace_drawers.created_at（归档时刻）与 messages.timestamp 的时间序保证；' +
        'ctxOverlap = 提问与「归档当时原文切片」的 bigram 覆盖率，用于分层——' +
        '低重叠档混有"用户其实在聊别的"的噪声，高重叠档才是干净信号。',
      generatedAt: new Date().toISOString(),
      buckets,
      all: set,
      queries: chosen,
    },
    null,
    2,
  ),
  'utf-8',
)
console.log(`\n→ ${OUT}（all=${set.length}, queries=${chosen.length}）`)
db.close()
