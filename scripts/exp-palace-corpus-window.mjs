#!/usr/bin/env node
/**
 * 向量语料窗口的消融实验 —— `slice(0, 300)` 这个截断代价多大？
 *
 * ## 为什么做这个
 *
 * v6 对照测（真实提问 × 前序归档）显示：开启向量后 R@1 从 19/31 掉到 7/31。
 * 同时查明了 gold 的构成：31 条里 **17 条查询词只在 300 字之外命中**
 * ——而 `slice(0, 300)` 正是向量语料的**全部**。也就是说这一档里向量
 * **物理上看不见**用户问的东西。
 *
 * `palace-vector.ts` 的注释已经承认过这个缺口（"宫殿段均值 1673 字、
 * 最长 94479，slice(0,300) 只覆盖开头"），本脚本把它**量化**。
 *
 * ## 做法：同一套查询，换语料窗口重跑
 *
 * | 档 | 语料 | 说明 |
 * |---|---|---|
 * | `w300`   | `slice(0, 300)`   | **当前生产** |
 * | `w1000`  | `slice(0, 1000)`  | 放宽 |
 * | `w3000`  | `slice(0, 3000)`  | 大幅放宽 |
 * | `full`   | 全文（上限 4000） | 上界参考 |
 *
 * 每档重新编码全部抽屉（这批是离线实验，索引一次性成本可接受），
 * 再用**同一个** RRF 融合跑 R@1/5/10。
 *
 * **注意**：改语料窗口 = 换口径 = 需要重建生产索引。本脚本只负责回答
 * "值不值得改"，不负责改。
 *
 * 用法：node scripts/exp-palace-corpus-window.mjs --set <path> [--k 10]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const SET = arg('--set', 'docs/test/memory-eval/palace-eval-set-v6.json')
const TOP_K = Number(arg('--k', 10))

const SEARCH_CANDIDATE_POOL = 30
const RRF_K = 60
const MIN_QUERY_TOKEN_HITS = 2

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
const requiredTokenHits = (n) => (n >= MIN_QUERY_TOKEN_HITS ? MIN_QUERY_TOKEN_HITS : 1)
function countTokenHits(tokens, text) {
  let h = 0
  for (const t of tokens) if (text.includes(t)) h++
  return h
}

const DB = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const db = new DatabaseSync(DB)
const docs = db
  .prepare('SELECT drawer_id AS id, content FROM palace_drawers WHERE deleted_at IS NULL')
  .all()
const byId = new Map(docs.map((d) => [d.id, d.content]))
console.log(`宫殿语料 ${docs.length} 条`)

function ftsRanked(query) {
  const tokens = [...tokenizeBigram(query)]
  if (!tokens.length) return []
  const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
  const need = requiredTokenHits(tokens.length)
  let rows
  try {
    rows = db
      .prepare(
        `SELECT d.drawer_id AS id, palace_drawers_fts.content AS fts_content
           FROM palace_drawers_fts JOIN palace_drawers d ON d.rowid = palace_drawers_fts.rowid
          WHERE palace_drawers_fts MATCH ? AND d.deleted_at IS NULL
          ORDER BY bm25(palace_drawers_fts) LIMIT ?`,
      )
      .all(match, SEARCH_CANDIDATE_POOL)
  } catch {
    return []
  }
  return rows.filter((r) => countTokenHits(tokens, r.fts_content) >= need).map((r) => r.id)
}

const CACHE = path.join(os.homedir(), '.lumii', 'models', 'wiki-embeddings', 'Xenova')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE
env.allowRemoteModels = false
const ext = await pipeline('feature-extraction', 'multilingual-e5-small', { quantized: true, local_files_only: true })
const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
const prodPrefix = (t) => (t.trim().length < 200 ? 'query: ' + t : 'passage: ' + t)

async function embedAll(texts) {
  const out = []
  for (const t of texts) {
    const r = await ext(t, { pooling: 'mean', normalize: true })
    out.push(r.data instanceof Float32Array ? r.data : Float32Array.from(r.data))
  }
  return out
}

const set = JSON.parse(fs.readFileSync(SET, 'utf8'))
const WINDOWS = [
  { name: 'w300', slice: (c) => c.slice(0, 300) },
  { name: 'w1000', slice: (c) => c.slice(0, 1000) },
  { name: 'w3000', slice: (c) => c.slice(0, 3000) },
  { name: 'full4000', slice: (c) => c.slice(0, 4000) },
]

const results = {}
for (const w of WINDOWS) {
  const corpora = docs.map((d) => w.slice(d.content).trim())
  const t0 = Date.now()
  const docVecs = await embedAll(corpora.map((c) => prodPrefix(c)))
  console.log(`[${w.name}] 编码 ${docVecs.length} 条用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)

  const stats = { r1: 0, r5: 0, r10: 0, n: 0 }
  for (const q of set.queries) {
    const isGold = (id) => {
      const c = byId.get(id)
      return c ? q.expect.some((e) => c.includes(e)) : false
    }
    const f = ftsRanked(q.query)
    const qr = await ext(prodPrefix(q.query), { pooling: 'mean', normalize: true })
    const qv = qr.data instanceof Float32Array ? qr.data : Float32Array.from(qr.data)
    const v = docs
      .map((d, i) => ({ id: d.id, s: cos(qv, docVecs[i]) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, SEARCH_CANDIDATE_POOL)
      .map((x) => x.id)

    const rrf = new Map()
    f.forEach((id, i) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + i + 1)))
    v.forEach((id, i) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + i + 1)))
    const ranked = [...rrf.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)

    stats.n++
    const idx = ranked.findIndex(isGold)
    if (idx >= 0 && idx < 1) stats.r1++
    if (idx >= 0 && idx < 5) stats.r5++
    if (idx >= 0 && idx < TOP_K) stats.r10++
  }
  results[w.name] = stats
}

// 基线：纯 FTS
const ftsStats = { r1: 0, r5: 0, r10: 0, n: 0 }
for (const q of set.queries) {
  const isGold = (id) => {
    const c = byId.get(id)
    return c ? q.expect.some((e) => c.includes(e)) : false
  }
  const f = ftsRanked(q.query)
  ftsStats.n++
  const idx = f.findIndex(isGold)
  if (idx >= 0 && idx < 1) ftsStats.r1++
  if (idx >= 0 && idx < 5) ftsStats.r5++
  if (idx >= 0 && idx < TOP_K) ftsStats.r10++
}

const n = ftsStats.n
console.log(`\n═══ 语料窗口消融（R@${TOP_K}，n=${n}）═══`)
const row = (name, s) =>
  `  ${name.padEnd(10)} R@1=${String(s.r1).padStart(2)}/${n}  R@5=${String(s.r5).padStart(2)}/${n}  R@${TOP_K}=${String(s.r10).padStart(2)}/${n}`
console.log(row('fts(基线)', ftsStats))
for (const w of WINDOWS) console.log(row(w.name, results[w.name]))
db.close()
