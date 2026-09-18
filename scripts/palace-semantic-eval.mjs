#!/usr/bin/env node
/**
 * 宫殿侧语义检索对照（含**生产口径**这一路）
 *
 * ## 为什么必须重建对照
 *
 * T1 的跑分台 `semantic-eval.mjs` 查的是 `agent_memories`（工作记忆，285 条**结构化摘要**），
 * 而 T3 接的向量检索查的是 `palace_drawers`（宫殿，1058 条**逐轮会话原文**）。
 * 实测：T1 那 15 条的 gold **6 条在宫殿里 0 命中**（含 s01/s04/s08/s10 这些关键改善项）
 * ——用工作记忆的打分证明宫殿通道有效，是本仓「用 A 口径证明、用 B 口径上线」的老毛病。
 *
 * ## 三路并排，第三路是关键
 *
 * | 路 | 文档前缀 | 查询前缀 | 说明 |
 * |---|---|---|---|
 * | bigram | — | — | 纯 FTS，开关关闭时的实际行为 |
 * | t1      | passage: | query: | **T1 跑分台口径**（理想 E5 约定） |
 * | prod    | 长度启发式 | 长度启发式 | **生产真实口径**（wiki-transformers-embedder.ts:165） |
 *
 * 第三路是这次要回答的问题：生产 embed() 用 `trimmed.length < 200 ? 'query:' : 'passage:'`
 * 决定前缀，是**长度启发式**而非 E5 的角色约定。宫殿 261/1058 条（25%）内容 <200 字，
 * 会被当成查询编码——与 T1 打分时用的 passage: 不是一回事。
 *
 * 用法：
 *   node scripts/palace-semantic-eval.mjs
 *   node scripts/palace-semantic-eval.mjs --k 5
 *
 * 口径与生产一致：向量语料 content.slice(0,300)、mean pooling + L2、线性余弦、RRF(k=60)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'

const RRF_K = 60
function reciprocalRankFusion(lists, k = RRF_K) {
  const scores = new Map()
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)))
  }
  return scores
}

const argv = process.argv.slice(2)
const TOP_K = argv.includes('--k') ? Number(argv[argv.indexOf('--k') + 1]) : 5
const SET = 'docs/test/memory-eval/palace-eval-set.json'
if (!fs.existsSync(SET)) {
  console.error(`对照集不存在：${SET}`)
  process.exit(2)
}

/** 生产前缀启发式：与 wiki-transformers-embedder.ts:165 逐字一致 */
const prodPrefix = (text) => (text.trim().length < 200 ? 'query: ' + text : 'passage: ' + text)

// ── bigram（与 PalaceRepo 同口径）──
const CJK = /[㐀-䶿一-鿿]/
const SEG = /[㐀-䶿一-鿿]+|[a-z0-9]+/g
const toks = (t) => {
  const o = new Set()
  for (const x of t.toLowerCase().match(SEG) ?? []) {
    if (CJK.test(x[0])) {
      if (x.length === 1) o.add(x)
      else for (let i = 0; i < x.length - 1; i++) o.add(x.slice(i, i + 2))
    } else o.add(x)
  }
  return o
}

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'), {
  readOnly: true,
})
const docs = db
  .prepare('SELECT drawer_id AS id, content FROM palace_drawers WHERE deleted_at IS NULL')
  .all()
console.log(`宫殿语料 ${docs.length} 条`)

const docToks = docs.map((d) => toks(d.content))
function bigramRank(query) {
  const q = [...toks(query)]
  if (!q.length) return []
  return docs
    .map((d, i) => ({ id: d.id, hits: q.filter((t) => docToks[i].has(t)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((x) => x.id)
}

// ── 向量：三路前缀分别编码 ──
const CACHE = path.join(os.homedir(), '.lumii', 'models', 'wiki-embeddings', 'Xenova')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE
env.allowRemoteModels = false
const t0 = Date.now()
const ext = await pipeline('feature-extraction', 'multilingual-e5-small', {
  quantized: true,
  local_files_only: true,
})
console.log(`模型加载 ${Date.now() - t0}ms`)

const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
async function encode(texts) {
  const out = await ext(texts, { pooling: 'mean', normalize: true })
  const dims = out.dims
  const n = dims[0]
  const dim = dims[1]
  const data = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data)
  return Array.from({ length: n }, (_, i) => data.subarray(i * dim, (i + 1) * dim))
}
async function encodeVector(texts) {
  // 批量会串味（不同前缀混在一批里），逐条编码更安全也便于对比
  const out = []
  for (const t of texts) {
    const r = await ext(t, { pooling: 'mean', normalize: true })
    const data = r.data instanceof Float32Array ? r.data : Float32Array.from(r.data)
    out.push(Array.from(data))
  }
  return out
}

const corpus = docs.map((d) => d.content.slice(0, 300))
const t1 = Date.now()
const docVecsT1 = await encodeVector(corpus.map((c) => 'passage: ' + c))
const docVecsProd = await encodeVector(corpus.map((c) => prodPrefix(c)))
console.log(`索引 ${docs.length} 条 ×2 路用时 ${Date.now() - t1}ms`)

const rank = (qv, docVecs) =>
  docs
    .map((d, i) => ({ id: d.id, s: cos(qv, docVecs[i]) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.id)

// ── 跑分 ──
const set = JSON.parse(fs.readFileSync(SET, 'utf8'))
const byId = new Map(docs.map((d) => [d.id, d.content]))
const modes = ['bigram', 't1', 'prod', 'rrf-t1', 'rrf-prod']
const stats = {}
for (const m of modes) stats[m] = {}

console.log('\n逐条（期望项排名）:')
for (const q of set.queries) {
  const isGold = (id) => {
    const c = byId.get(id)
    return c ? q.expect.some((e) => c.includes(e)) : false
  }
  const b = bigramRank(q.query)
  const vT1 = rank((await encodeVector(['query: ' + q.query]))[0], docVecsT1)
  const vProd = rank((await encodeVector([prodPrefix(q.query)]))[0], docVecsProd)
  const rrfT1 = [...reciprocalRankFusion([b, vT1].filter((l) => l.length)).entries()]
    .sort((a, b2) => b2[1] - a[1])
    .map((x) => x[0])
  const rrfProd = [...reciprocalRankFusion([b, vProd].filter((l) => l.length)).entries()]
    .sort((a, b2) => b2[1] - a[1])
    .map((x) => x[0])

  const ranked = { bigram: b, t1: vT1, prod: vProd, 'rrf-t1': rrfT1, 'rrf-prod': rrfProd }
  const pos = {}
  for (const m of modes) {
    const idx = ranked[m].findIndex(isGold)
    pos[m] = idx < 0 ? 'MISS' : `#${idx + 1}`
    const s = (stats[m][q.category] ??= { n: 0, hits: 0 })
    s.n++
    if (idx >= 0 && idx < TOP_K) s.hits++
  }
  console.log(
    `  ${q.id.padEnd(20)} [${q.category}] ` +
      modes.map((m) => `${m}=${pos[m]}`).join(' '),
  )
}

console.log(`\n═══ 宫殿语义检索对照（R@${TOP_K}）═══`)
const cats = [...new Set(set.queries.map((q) => q.category))]
const pad = (s, n) => String(s).padEnd(n)
console.log(pad('类别', 14) + modes.map((m) => pad(m, 14)).join(''))
for (const c of cats) {
  console.log(
    pad(c, 14) +
      modes.map((m) => {
        const s = stats[m][c]
        return pad(s ? `${s.hits}/${s.n}` : '-', 14)
      }).join(''),
  )
}
console.log(
  pad('合计', 14) +
    modes
      .map((m) => {
        const t = Object.values(stats[m]).reduce((a, s) => ({ n: a.n + s.n, h: a.h + s.hits }), {
          n: 0,
          h: 0,
        })
        return pad(`${t.h}/${t.n}`, 14)
      })
      .join(''),
)
db.close()
