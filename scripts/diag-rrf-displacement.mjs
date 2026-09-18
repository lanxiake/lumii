#!/usr/bin/env node
/**
 * RRF 融合的「挤占」诊断 —— 谁把 gold 从 top-1 挤下去了？
 *
 * ## 背景
 *
 * v6 对照测（真实用户提问 × 前序归档）出现：R@1 `fts 19/31 → rrf 7/31`，
 * 而向量索引自洽性检查是 **60/60 自命中 #1**——通道本身没坏。故必须回答：
 * 融合时**是什么**排在 gold 前面。
 *
 * ## RRF 的算术（k=60）
 *
 * `score(d) = 1/(60+ftsRank(d)) + 1/(60+vecRank(d))`（缺席的项记 0）。
 * 只看 FTS：#1 得 0.0164。但一条 **FTS #2 + 向量 #1** 得 1/62+1/61 = 0.0327
 * ——**近乎两倍**。也就是说 RRF 奖励「两边都认可」，而这恰好惩罚了
 * 「FTS 独占第一、向量不待见」的条目。
 *
 * 于是问题变成：向量那一路的 top 是什么？如果它是**泛化的对话套话**
 * （"收到，先看一下…"这类开头，对任何查询余弦都高），那么融合会把这类
 * 噪声抬上来，同时把 FTS 的正确答案压下去。
 *
 * ## 本脚本输出
 *
 * 对每条失败的 case：
 * - gold 在两路的排名与得分
 * - 实际排在最前的那些，各自的 fts/vec 排名——**一眼看出是"两边都高"还是"向量单方面高"**
 *
 * 用法：node scripts/diag-rrf-displacement.mjs --set <path> [--limit 8]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const SET = arg('--set', 'docs/test/memory-eval/palace-eval-set-v6.json')
const LIMIT = Number(arg('--limit', 8))

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

const byId = new Map(
  db.prepare('SELECT drawer_id, content FROM palace_drawers WHERE deleted_at IS NULL').all().map((r) => [r.drawer_id, r.content]),
)
const vecs = db
  .prepare(
    `SELECT e.drawer_id AS id, e.embedding AS emb FROM palace_drawer_embeddings e
       JOIN palace_drawers d ON d.drawer_id = e.drawer_id WHERE d.deleted_at IS NULL`,
  )
  .all()
  .map((r) => ({ id: r.id, v: new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.length / 4) }))

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

async function vectorRanked(query) {
  const r = await ext(prodPrefix(query), { pooling: 'mean', normalize: true })
  const qv = r.data instanceof Float32Array ? r.data : Float32Array.from(r.data)
  return vecs
    .map((x) => ({ id: x.id, s: cos(qv, x.v) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, SEARCH_CANDIDATE_POOL)
    .map((x) => x.id)
}

const set = JSON.parse(fs.readFileSync(SET, 'utf8'))
const isGold = (q, id) => {
  const c = byId.get(id)
  return c ? q.expect.some((e) => c.includes(e)) : false
}

let shown = 0
for (const q of set.queries) {
  const f = ftsRanked(q.query)
  const v = await vectorRanked(q.query)
  const ftsPos = f.findIndex((id) => isGold(q, id))
  if (ftsPos !== 0) continue // 只看"FTS 本来第一"的

  const rrf = new Map()
  f.forEach((id, i) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + i + 1)))
  v.forEach((id, i) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + i + 1)))
  const ranked = [...rrf.entries()].sort((a, b) => b[1] - a[1])
  const goldId = f[ftsPos]
  const newPos = ranked.findIndex(([id]) => id === goldId)
  if (newPos === 0) continue // 融合后仍是第一，没问题

  const vPos = v.indexOf(goldId)
  console.log(`\n── ${q.id}  查询「${q.query.slice(0, 40)}」`)
  console.log(
    `   gold ${goldId.slice(0, 8)}: fts=#1 vec=${vPos < 0 ? '缺席' : '#' + (vPos + 1)} → rrf=#${newPos + 1}  ` +
      `（gold 内容开头: "${(byId.get(goldId) ?? '').slice(0, 44).replace(/\n/g, ' ')}"）`,
  )
  console.log('   挤在它前面的：')
  for (const [id, sc] of ranked.slice(0, Math.min(newPos, LIMIT))) {
    const fp = f.indexOf(id)
    const vp = v.indexOf(id)
    console.log(
      `     rrf=${sc.toFixed(4)}  fts=${fp < 0 ? '缺席' : '#' + (fp + 1)}  vec=${vp < 0 ? '缺席' : '#' + (vp + 1)}  ` +
        `"${(byId.get(id) ?? '').slice(0, 56).replace(/\n/g, ' ')}"`,
    )
  }
  shown++
  if (shown >= 6) break
}
db.close()
