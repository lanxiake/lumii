/**
 * 语义/同义改写检索对照（T1 的跑分台）
 *
 * 三组并排：纯 bigram / 纯向量 / RRF 融合。分类别报 R@k 与 MRR——
 * **必须分类报**，整体数字会把「精确类掉了、语义类涨了」平均掉，那正是要防的事故。
 *
 * 用法：
 *   node scripts/semantic-eval.mjs              # 默认对照集
 *   node scripts/semantic-eval.mjs --k 10
 *   node scripts/semantic-eval.mjs --no-vector  # 只跑 bigram（不需要模型）
 *
 * 与线上同口径：向量语料 content.slice(0,300)、E5 的 query:/passage: 前缀、
 * mean pooling + L2 归一化、线性余弦。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'
// RRF 内联：与 packages/agent-runtime/src/wiki/wiki-vector.ts:89 的实现逐字一致。
// 不从 @mtbot/agent-runtime 导入——该包 main 指向 TS 源码，node 解析不了 .js 后缀。
const RRF_K = 60
function reciprocalRankFusion(lists, k = RRF_K) {
  const scores = new Map()
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)))
  }
  return scores
}

const argv = process.argv.slice(2)
const TOP_K = argv.includes('--k') ? Number(argv[argv.indexOf('--k') + 1]) : 10
const noVector = argv.includes('--no-vector')
const SET = 'docs/test/memory-eval/semantic-eval-set.json'

// ── bigram（与 memory-repo.search 同口径）──
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

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'), { readOnly: true })
const docs = db
  .prepare(
    `SELECT id, content FROM agent_memories
      WHERE user_id='local-user' AND is_archived=0 AND deleted_at IS NULL AND superseded_at IS NULL`,
  )
  .all()
console.log(`语料 ${docs.length} 条`)

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

// ── 向量 ──
let vecReady = false
let docVecs = []
if (!noVector) {
  const CACHE = path.join(os.homedir(), '.lumii', 'models', 'wiki-embeddings', 'Xenova')
  env.allowLocalModels = true; env.cacheDir = CACHE; env.localModelPath = CACHE; env.allowRemoteModels = false
  const t0 = Date.now()
  const ext = await pipeline('feature-extraction', 'multilingual-e5-small', { quantized: true, local_files_only: true })
  console.log(`模型加载 ${Date.now() - t0}ms`)

  const t1 = Date.now()
  for (const d of docs) {
    const o = await ext('passage: ' + d.content.slice(0, 300), { pooling: 'mean', normalize: true })
    docVecs.push(Array.from(o.data))
  }
  console.log(`索引 ${docs.length} 条用时 ${Date.now() - t1}ms（${((Date.now() - t1) / docs.length).toFixed(1)}ms/条）`)
  vecReady = true
}
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
async function vectorRank(q, ext) {
  const o = await ext('query: ' + q, { pooling: 'mean', normalize: true })
  const qv = Array.from(o.data)
  return docs.map((d, i) => ({ id: d.id, s: cos(qv, docVecs[i]) })).sort((a, b) => b.s - a.s).map((x) => x.id)
}

// ── 跑分 ──
const set = JSON.parse(fs.readFileSync(SET, 'utf8'))
const ext = vecReady ? await pipeline('feature-extraction', 'multilingual-e5-small', { quantized: true, local_files_only: true }) : null

const modes = vecReady ? ['bigram', 'vector', 'rrf'] : ['bigram']
const stats = {}
for (const m of modes) stats[m] = {}

for (const q of set.queries) {
  const isGold = (id) => {
    const d = docs.find((x) => x.id === id)
    return d ? q.expect.some((e) => d.content.includes(e)) : false
  }
  const b = bigramRank(q.query)
  const v = vecReady ? await vectorRank(q.query, ext) : []
  const rrf = vecReady
    ? [...reciprocalRankFusion([b, v].filter((l) => l.length)).entries()].sort((a, b2) => b2[1] - a[1]).map((x) => x[0])
    : []
  const ranked = { bigram: b, vector: v, rrf }

  for (const m of modes) {
    const list = ranked[m] ?? []
    const idx = list.findIndex(isGold)
    const s = (stats[m][q.category] ??= { n: 0, hits: 0, rr: 0 })
    s.n++
    if (idx >= 0 && idx < TOP_K) s.hits++
    if (idx >= 0) s.rr += 1 / (idx + 1)
  }
}

console.log(`\n═══ 语义检索对照（R@${TOP_K}）═══`)
const cats = [...new Set(set.queries.map((q) => q.category))]
const pad = (s, n) => String(s).padEnd(n)
console.log(pad('类别', 14) + modes.map((m) => pad(m, 12)).join(''))
for (const c of cats) {
  console.log(
    pad(c, 14) +
      modes.map((m) => { const s = stats[m][c]; return pad(s ? `${s.hits}/${s.n}` : '-', 12) }).join(''),
  )
}
console.log(
  pad('合计', 14) +
    modes.map((m) => {
      const t = Object.values(stats[m]).reduce((a, s) => ({ n: a.n + s.n, h: a.h + s.hits }), { n: 0, h: 0 })
      return pad(`${t.h}/${t.n}`, 12)
    }).join(''),
)
console.log('\n逐条（各模式期望项排名）:')
for (const q of set.queries) {
  const isGold = (id) => { const d = docs.find((x) => x.id === id); return d ? q.expect.some((e) => d.content.includes(e)) : false }
  const b = bigramRank(q.query); const bi = b.findIndex(isGold)
  const v = vecReady ? await vectorRank(q.query, ext) : []
  const vi = v.findIndex(isGold)
  console.log(`  ${q.id.padEnd(18)} [${q.category}] bigram#${bi < 0 ? 'MISS' : bi + 1}  vector#${vi < 0 ? 'MISS' : vi + 1}`)
}
db.close()
