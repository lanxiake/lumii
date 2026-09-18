#!/usr/bin/env node
/**
 * 向量的**救援价值**：FTS 完全找不到时，向量能不能找到？
 *
 * ## 为什么问这个
 *
 * 语料窗口消融（`exp-palace-corpus-window.mjs`）显示：把窗口从 300 放宽到 1000
 * 能让 R@1 从 7/31 回到 12/31，**但仍远低于纯 FTS 的 19/31**。也就是说
 * 「无条件融合」这条路在本人数据上是负收益，窗口只是加剧了它。
 *
 * 而这个功能立项时的**真实意图**是「语义改写检索」——治的是
 * 「用户措辞与库里有字面错配、FTS 压根找不到」那类场景（立项书原文：
 * "低重叠档…正是语义检索该救的地方"）。那么正确的问题就不是
 * 「融合后整体 R@1 多少」，而是：
 *
 *   **FTS 完全漏掉的那些查询里，向量救得回几个？**
 *
 * 这决定了这个功能该不该留、以及该配什么策略：
 * - 救得回 → 值得留，但应该改成**条件启用**（FTS 弱/空时才用向量），而不是无条件融合
 * - 救不回 → 在当前语料上这个通道对本场景没有价值
 *
 * 用法：node scripts/exp-palace-vector-rescue.mjs [--set <path>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const SET = arg('--set', 'docs/test/memory-eval/palace-eval-set-v6.json')

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

const set = JSON.parse(fs.readFileSync(SET, 'utf8'))
const isGoldOf = (q) => (id) => {
  const c = byId.get(id)
  return c ? q.expect.some((e) => c.includes(e)) : false
}

// 先算 FTS，挑出它漏掉的
const perQuery = []
for (const q of set.queries) {
  const isGold = isGoldOf(q)
  const f = ftsRanked(q.query)
  const idx = f.findIndex(isGold)
  perQuery.push({ q, isGold, ftsRank: idx < 0 ? null : idx + 1, ftsLen: f.length })
}

const ftsMiss = perQuery.filter((p) => p.ftsRank === null)
const ftsHit = perQuery.filter((p) => p.ftsRank !== null)
console.log(`共 ${perQuery.length} 条查询：FTS 命中 ${ftsHit.length} / **FTS 完全漏掉 ${ftsMiss.length}**`)
console.log(`\nFTS 漏掉的那些（向量是否有救）：`)

const WINDOWS = [
  { name: 'w300', f: (c) => c.slice(0, 300) },
  { name: 'w1000', f: (c) => c.slice(0, 1000) },
  { name: 'full4000', f: (c) => c.slice(0, 4000) },
]

const rescued = {}
for (const w of WINDOWS) {
  const docVecs = []
  for (const d of docs) docVecs.push(await embed(prodPrefix(w.f(d.content).trim())))
  let n = 0
  const detail = []
  for (const p of ftsMiss) {
    const qv = await embed(prodPrefix(p.q.query))
    const v = docs
      .map((d, i) => ({ id: d.id, s: cos(qv, docVecs[i]) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, SEARCH_CANDIDATE_POOL)
      .map((x) => x.id)
    const vi = v.findIndex(p.isGold)
    const ok = vi >= 0 // 进 top-30 候选池即算"救到"（生产中融合后还有 limit 截断，这里是上界）
    if (ok) n++
    detail.push({ id: p.q.id, vecRank: vi < 0 ? null : vi + 1 })
  }
  rescued[w.name] = { n, detail }
  console.log(`  [${w.name}] 救回 ${n}/${ftsMiss.length}`)
}

// 逐条明细（用 w300 那档）
console.log(`\n逐条（FTS 漏掉的 ${ftsMiss.length} 条）：`)
for (let i = 0; i < ftsMiss.length; i++) {
  const p = ftsMiss[i]
  const r300 = rescued['w300'].detail[i]
  const r1000 = rescued['w1000'].detail[i]
  const rfull = rescued['full4000'].detail[i]
  console.log(
    `  ${p.q.id.padEnd(22)} w300=${r300.vecRank ? '#' + r300.vecRank : 'MISS'}  ` +
      `w1000=${r1000.vecRank ? '#' + r1000.vecRank : 'MISS'}  full=${rfull.vecRank ? '#' + rfull.vecRank : 'MISS'}  ` +
      `「${p.q.query.slice(0, 34).replace(/\n/g, ' ')}」`,
  )
}

// 对照：FTS 命中的那些，向量会不会把它们的 gold 也带进来（会带来噪声但至少不丢）
console.log(`\n═══ 汇总 ═══`)
console.log(`  FTS 单独      : ${ftsHit.length}/${perQuery.length} 命中`)
for (const w of WINDOWS) {
  const gain = rescued[w.name].n
  console.log(`  FTS + 向量救援 : ${ftsHit.length + 0}/${perQuery.length} 保住，额外救回 ${gain} 条 → 上界 ${ftsHit.length + gain}/${perQuery.length}`)
}
db.close()
