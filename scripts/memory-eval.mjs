/**
 * 中文记忆检索评测（P2-1 · 评审 §2.5.2 / §7 P2-1）
 *
 * 为什么要有它：评审 §4.2 的教训——Mem0 / Zep / Letta 各自定基线、各自调超参，
 * 互相报出的分数差出天际。**只信自己数据上自己跑的数字**。
 * 而 §2.5.2 的实测已经显示本地向量并未强于 BM25，所以换检索栈之前必须先有基线。
 *
 * 本脚本直接复用**线上读路径的同一套逻辑**（bigram 分词 → FTS5 MATCH → bm25 排序），
 * 对真实 `agent_memories` 库跑标注好的查询集，输出 Recall@5 / Recall@10 / MRR。
 *
 * 用法：
 *   node scripts/memory-eval.mjs                       # 用默认评测集
 *   node scripts/memory-eval.mjs --set <path>          # 指定评测集
 *   node scripts/memory-eval.mjs --json                # 只输出 JSON（供回归对比）
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SET = path.join(HERE, '..', 'docs', 'test', 'memory-eval', 'eval-set.json')
const DB_PATH =
  process.env.LUMII_DB_PATH ?? path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')

const argv = process.argv.slice(2)
const setPath = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : DEFAULT_SET
const jsonOnly = argv.includes('--json')

// ── 与 memory/segmentation.ts:tokenizeBigram 完全一致 ──
const CJK_RE = /[㐀-䶿一-鿿]/
const SEG_RE = /[㐀-䶿一-鿿]+|[a-z0-9]+/g
function tokenizeBigram(text) {
  const out = new Set()
  for (const seg of text.toLowerCase().match(SEG_RE) ?? []) {
    if (CJK_RE.test(seg[0])) {
      if (seg.length === 1) out.add(seg)
      else for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
    } else out.add(seg)
  }
  return out
}

// ── 与 memory-repo.ts:search() 完全一致的查询构造 ──
function search(db, keyword, limit) {
  const tokens = [...tokenizeBigram(keyword)]
  if (tokens.length === 0) return []
  const q = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
  return db
    .prepare(
      `SELECT m.id, m.content
         FROM agent_memories_fts
         JOIN agent_memories m ON m.rowid = agent_memories_fts.rowid
        WHERE agent_memories_fts MATCH ?
          AND m.user_id = 'local-user'
          AND m.is_archived = 0
          AND m.deleted_at IS NULL
          AND m.superseded_at IS NULL
        ORDER BY bm25(agent_memories_fts)
        LIMIT ?`,
    )
    .all(q, limit)
}

const evalSet = JSON.parse(fs.readFileSync(setPath, 'utf-8'))
const db = new DatabaseSync(DB_PATH, { readOnly: true })

const K5 = 5
const K10 = 10
const rows = []
let hit5 = 0
let hit10 = 0
let mrrSum = 0
let missedQueries = 0

for (const item of evalSet.queries) {
  const results = search(db, item.query, K10)
  const isGold = (content) => item.gold.some((g) => content.includes(g))
  const firstGoldIdx = results.findIndex((r) => isGold(r.content))
  const rank = firstGoldIdx >= 0 ? firstGoldIdx + 1 : 0
  if (rank === 0) missedQueries++
  if (rank > 0 && rank <= K5) hit5++
  if (rank > 0 && rank <= K10) hit10++
  if (rank > 0) mrrSum += 1 / rank
  rows.push({
    id: item.id,
    type: item.type,
    query: item.query,
    rank,
    returned: results.length,
    top1: results[0]?.content?.slice(0, 44) ?? '(无命中)',
  })
}

const n = evalSet.queries.length
const summary = {
  corpus: db.prepare('SELECT COUNT(*) AS c FROM agent_memories').get().c,
  active: db
    .prepare(
      `SELECT COUNT(*) AS c FROM agent_memories
        WHERE user_id='local-user' AND is_archived=0 AND deleted_at IS NULL AND superseded_at IS NULL`,
    )
    .get().c,
  queries: n,
  recall_at_5: +(hit5 / n).toFixed(3),
  recall_at_10: +(hit10 / n).toFixed(3),
  mrr: +(mrrSum / n).toFixed(3),
  missed: missedQueries,
}

if (jsonOnly) {
  console.log(JSON.stringify({ summary, rows }, null, 2))
} else {
  console.log(`语料: ${summary.corpus} 条（可达 ${summary.active}）| 查询 ${n} 条`)
  console.log(`\n召回：Recall@5 = ${summary.recall_at_5}   Recall@10 = ${summary.recall_at_10}   MRR = ${summary.mrr}`)
  console.log(`未命中: ${summary.missed} 条\n`)
  console.log('逐条：')
  for (const r of rows) {
    const mark = r.rank === 0 ? 'MISS' : r.rank <= K5 ? ' ok ' : ' 10 '
    console.log(`  [${mark}] #${String(r.rank).padStart(2)} ${r.id.padEnd(16)} ${r.type.padEnd(22)} ${r.top1}`)
  }
}

db.close()
