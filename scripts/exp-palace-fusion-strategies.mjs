#!/usr/bin/env node
/**
 * 融合策略对比 —— 无条件 RRF 是不是错的选择？
 *
 * ## 问题
 *
 * 生产用 `RRF(k=60)` **无条件**融合 FTS 与向量。v6 实测（n=31）：
 * 纯 FTS R@1=19/31，无条件融合 7/31。`diag-rrf-displacement.mjs` 已定位机制：
 * RRF 奖励「两边都还行」，而 gold 常是「FTS #1 + 向量缺席」，于是被
 * 「FTS #10 + 向量 #1」压过。
 *
 * 本脚本把几种**替代策略**放在同一套查询上比：
 *
 * | 策略 | 做法 |
 * |---|---|
 * | `fts` | 对照组 |
 * | `rrf60` | 当前生产 |
 * | `rrf10` / `rrf200` | 换 k：k 越小越看重头部，越大越"民主" |
 * | `vec-only` | 只用向量（看它单独能做到什么） |
 * | `fts-then-vec` | **条件启用**：FTS 有结果就用 FTS，只在其为空时用向量 |
 * | `rrf-on-weak` | 只在 FTS 结果不足 `--weak-threshold` 条时才融合 |
 *
 * ## 判据
 *
 * 与生产一致：gold 命中即算，记 R@1/5/10。**不用会话过滤**（v6 的查询是
 * "跨会话回忆"形态，与生产 `searchPalace` 在无 sessionKey 时的行为一致）。
 *
 * 用法：node scripts/exp-palace-fusion-strategies.mjs [--set <path>] [--weak-threshold 5]
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
const WEAK = Number(arg('--weak-threshold', 5))

const SEARCH_CANDIDATE_POOL = 30
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
function rrf(lists, k) {
  const s = new Map()
  for (const l of lists) l.forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1 / (k + i + 1)))
  return s
}

const DB = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const db = new DatabaseSync(DB)
const docs = db.prepare('SELECT drawer_id AS id, content FROM palace_drawers WHERE deleted_at IS NULL').all()
const byId = new Map(docs.map((d) => [d.id, d.content]))

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
async function embed(t) {
  const r = await ext(t, { pooling: 'mean', normalize: true })
  return r.data instanceof Float32Array ? r.data : Float32Array.from(r.data)
}

// 用**库里的**向量（= 生产索引，w300 口径）
const vecRows = db
  .prepare(
    `SELECT e.drawer_id AS id, e.embedding AS emb FROM palace_drawer_embeddings e
       JOIN palace_drawers d ON d.drawer_id = e.drawer_id WHERE d.deleted_at IS NULL`,
  )
  .all()
const vecs = new Map(
  vecRows.map((r) => [r.id, new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.length / 4)]),
)
console.log(`语料 ${docs.length} 条 / 向量 ${vecs.size} 条`)

const set = JSON.parse(fs.readFileSync(SET, 'utf8'))

const STRATEGIES = {
  fts: (f, v) => f,
  rrf10: (f, v) => mergeRRF(f, v, 10),
  rrf60: (f, v) => mergeRRF(f, v, 60),
  rrf200: (f, v) => mergeRRF(f, v, 200),
  'vec-only': (f, v) => v,
  'fts-then-vec': (f, v) => (f.length > 0 ? f : v),
  'rrf-on-weak': (f, v) => (f.length < WEAK ? mergeRRF(f, v, 60) : f),
}

function mergeRRF(f, v, k) {
  const m = rrf([f, v], k)
  const all = new Set([...f, ...v])
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter((id) => all.has(id))
}

const names = Object.keys(STRATEGIES)
const stats = Object.fromEntries(names.map((n) => [n, { r1: 0, r5: 0, r10: 0 }]))
let n = 0

for (const q of set.queries) {
  const isGold = (id) => {
    const c = byId.get(id)
    return c ? q.expect.some((e) => c.includes(e)) : false
  }
  const f = ftsRanked(q.query)
  const qv = await embed(prodPrefix(q.query))
  const v = docs
    .map((d) => ({ id: d.id, s: vecs.has(d.id) ? cos(qv, vecs.get(d.id)) : -1 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, SEARCH_CANDIDATE_POOL)
    .map((x) => x.id)

  n++
  for (const name of names) {
    const ranked = STRATEGIES[name](f, v)
    const idx = ranked.findIndex(isGold)
    if (idx >= 0 && idx < 1) stats[name].r1++
    if (idx >= 0 && idx < 5) stats[name].r5++
    if (idx >= 0 && idx < TOP_K) stats[name].r10++
  }
}

console.log(`\n═══ 融合策略对比（n=${n}，R@${TOP_K}）═══`)
console.log('  策略'.padEnd(18) + 'R@1      R@5      R@10')
const order = ['fts', 'vec-only', 'rrf10', 'rrf60', 'rrf200', 'fts-then-vec', 'rrf-on-weak']
for (const name of order) {
  const s = stats[name]
  const mark = name === 'rrf60' ? '  ← 当前生产' : ''
  console.log(
    `  ${name.padEnd(16)} ${String(s.r1).padStart(2)}/${n}    ${String(s.r5).padStart(2)}/${n}    ${String(s.r10).padStart(2)}/${n}${mark}`,
  )
}
console.log(`\n（rrf-on-weak 的阈值：FTS 结果 < ${WEAK} 条时才融合）`)
db.close()
