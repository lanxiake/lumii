#!/usr/bin/env node
/**
 * 重排序实验 —— 召回够了，排序是短板
 *
 * ## 为什么做这个
 *
 * v7 实测（判据=drawer_id）：纯 FTS **Recall@30 = 0.897 但 R@1 只有 16/34**，
 * 凸组合把 Recall@30 提到 **1.000**、R@1 到 20/34。也就是说 **gold 基本都在
 * 候选池里，只是没排到前面**——这是 cross-encoder rerank 的教科书场景。
 *
 * 注意：旧报告（子串判据）因为 R@1 虚高到 19/31，完全没看出这个信号。
 *
 * ## 模型选择
 *
 * `Xenova/bge-reranker-base`（XLM-R-base，278M，512 上下文，量化 ONNX 267MB）。
 * 选它的理由：中文强、transformers.js 直接可用、512 窗口对"截到 512 token 的
 * 候选"够用。更强的 bge-reranker-v2-m3（568M/8192ctx）留作后续对比。
 * jina-reranker-v2 是 CC-BY-NC，排除。
 *
 * ## 延迟实测：**本机不可行**（先说结论，省得别人再试一遍）
 *
 * i5-14400（16 核）+ transformers.js WASM 后端，量化 ONNX：
 *
 * | 变量 | 实测 | 结论 |
 * |---|---|---|
 * | 单对延迟 | **~1.0~1.1s** | 决定性瓶颈 |
 * | 文档 200 字 vs 1200 字 | 1094ms vs 985ms | **长度无关**——截短文档不省时间 |
 * | 批处理 N=1 vs 16 | 920ms vs 789ms/对 | **几乎无规模效应** |
 * | `env.backends.onnx.wasm.numThreads=14` | 无变化（1101ms） | WASM 后端在 Node 下不并行 |
 *
 * 即瓶颈是**单次前向的固定开销**，不是计算量。rerank 20 条 ≈ 20s/查询，
 * 生产不可接受。真要上，得换**原生 onnxruntime-node**——但那会撞上已修的
 * DLL 版本冲突（见 docs/design/工程基建/2026-09-18-原生ONNX运行时加载顺序闸.md），
 * 属于另一个工程决策。
 *
 * 所以本脚本的目的**不是**验证可用性，而是量**增益上界**：如果增益很大，
 * 才值得为它付换 runtime 的代价。故默认只 rerank top-8。
 *
 * 用法：node scripts/exp-palace-rerank.mjs [--top 8] [--doc-chars 1200]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env, AutoTokenizer, AutoModelForSequenceClassification } from '@xenova/transformers'

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const SET = arg('--set', 'docs/test/memory-eval/palace-eval-set-v7-seed.json')
const TOP = Number(arg('--top', 8))
const DOC_CHARS = Number(arg('--doc-chars', 1200))
const POOL = 30
const ALPHA = 0.6

const CJK = /[㐀-䶿一-鿿]/
const SEG = /[㐀-䶿一-鿿]+|[a-z0-9]+/g
function tok(t) {
  const s = new Set()
  const m = (t || '').toLowerCase().match(SEG)
  if (!m) return s
  for (const g of m) {
    if (CJK.test(g[0])) {
      if (g.length === 1) s.add(g)
      else for (let i = 0; i < g.length - 1; i++) s.add(g.slice(i, i + 2))
    } else s.add(g)
  }
  return s
}

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'))
const docs = db.prepare('SELECT drawer_id id, content FROM palace_drawers WHERE deleted_at IS NULL').all()
const byId = new Map(docs.map((d) => [d.id, d.content]))

function ftsScored(query) {
  const ts = [...tok(query)]
  if (!ts.length) return []
  const match = ts.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
  const need = ts.length >= 2 ? 2 : 1
  let rows
  try {
    rows = db
      .prepare(
        `SELECT d.drawer_id id, bm25(palace_drawers_fts) s, palace_drawers_fts.content fc
           FROM palace_drawers_fts JOIN palace_drawers d ON d.rowid=palace_drawers_fts.rowid
          WHERE palace_drawers_fts MATCH ? AND d.deleted_at IS NULL
          ORDER BY bm25(palace_drawers_fts) LIMIT ?`,
      )
      .all(match, POOL)
  } catch {
    return []
  }
  return rows
    .filter((r) => {
      let h = 0
      for (const t of ts) if (r.fc.includes(t)) h++
      return h >= need
    })
    .map((r) => ({ id: r.id, s: r.s }))
}

const CACHE = path.join(os.homedir(), '.lumii', 'models', 'wiki-embeddings', 'Xenova')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE
env.allowRemoteModels = false
const ext = await pipeline('feature-extraction', 'multilingual-e5-small', {
  quantized: true,
  local_files_only: true,
})
const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
const prefix = (t) => (t.trim().length < 200 ? 'query: ' + t : 'passage: ' + t)
async function embed(t) {
  const r = await ext(t, { pooling: 'mean', normalize: true })
  return r.data instanceof Float32Array ? r.data : Float32Array.from(r.data)
}
const embRows = db
  .prepare(
    `SELECT e.drawer_id id, e.embedding emb FROM palace_drawer_embeddings e
       JOIN palace_drawers d ON d.drawer_id=e.drawer_id WHERE d.deleted_at IS NULL`,
  )
  .all()
const vecs = embRows.map((r) => ({
  id: r.id,
  v: new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.length / 4),
}))

// ── reranker（独立 cacheDir，避免和 e5 抢同一目录）──
const RERANK_DIR = path.join(os.homedir(), '.lumii', 'models', 'rerank')
const tokenizer = await AutoTokenizer.from_pretrained('Xenova/bge-reranker-base', {
  cache_dir: RERANK_DIR,
  local_files_only: true,
})
const reranker = await AutoModelForSequenceClassification.from_pretrained('Xenova/bge-reranker-base', {
  cache_dir: RERANK_DIR,
  local_files_only: true,
  quantized: true,
})
console.log('reranker 已加载：Xenova/bge-reranker-base (quantized)')

/** cross-encoder 打分：一次一对，返回 logit（越大越相关） */
async function rerankScore(query, doc) {
  const inputs = tokenizer(query, {
    text_pair: doc,
    padding: true,
    truncation: true,
    max_length: 512,
  })
  const out = await reranker(inputs)
  const l = out.logits.data
  return l[0]
}

function minmaxBm25(list) {
  if (!list.length) return new Map()
  const v = list.map((x) => x.s)
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1
  return new Map(list.map((x) => [x.id, 1 - (x.s - lo) / span]))
}
function minmax(list) {
  if (!list.length) return new Map()
  const v = list.map((x) => x.s)
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1
  return new Map(list.map((x) => [x.id, (x.s - lo) / span]))
}
function convex(f, v, alpha) {
  const fm = minmaxBm25(f), vm = minmax(v)
  const all = new Set([...fm.keys(), ...vm.keys()])
  return [...all]
    .map((id) => [id, alpha * (fm.get(id) ?? 0) + (1 - alpha) * (vm.get(id) ?? 0)])
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
}
function ndcg(ranked, golds, k = 10) {
  let d = 0
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (golds.has(ranked[i])) d += 1 / Math.log2(i + 2)
  const ideal = [...golds].slice(0, k).reduce((a, _, i) => a + 1 / Math.log2(i + 2), 0)
  return ideal ? d / ideal : 0
}
function rr(ranked, golds, k = 10) {
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (golds.has(ranked[i])) return 1 / (i + 1)
  return 0
}

const rawSet = JSON.parse(fs.readFileSync(SET, 'utf8'))
const excluded = rawSet.queries.filter((q) => q.disputed)
const set = { ...rawSet, queries: rawSet.queries.filter((q) => !q.disputed) }
if (excluded.length) console.log(`已排除 ${excluded.length} 条争议样本：${excluded.map((q) => q.id).join(', ')}`)
const acc = {
  fts: { ndcg: 0, mrr: 0, r1: 0 },
  convex: { ndcg: 0, mrr: 0, r1: 0 },
  'fts+rerank': { ndcg: 0, mrr: 0, r1: 0 },
  'convex+rerank': { ndcg: 0, mrr: 0, r1: 0 },
}
const latencies = []
const rows = []

for (const q of set.queries) {
  const golds = new Set(q.golds ?? [q.gold])
  const f = ftsScored(q.query)
  const qv = await embed(prefix(q.query))
  const v = vecs
    .map((x) => ({ id: x.id, s: cos(qv, x.v) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, POOL)

  const ftsRanked = f.map((x) => x.id)
  const cvxRanked = convex(f, v, ALPHA)

  // rerank 两条基线的前 TOP 条
  const doRerank = async (ranked) => {
    const head = ranked.slice(0, TOP)
    const t0 = Date.now()
    const scored = []
    for (const id of head) {
      const doc = (byId.get(id) ?? '').slice(0, DOC_CHARS)
      scored.push({ id, s: await rerankScore(q.query, doc) })
    }
    latencies.push({ n: head.length, ms: Date.now() - t0 })
    scored.sort((a, b) => b.s - a.s)
    return [...scored.map((x) => x.id), ...ranked.slice(TOP)]
  }
  const ftsRe = await doRerank(ftsRanked)
  const cvxRe = await doRerank(cvxRanked)

  const variants = { fts: ftsRanked, convex: cvxRanked, 'fts+rerank': ftsRe, 'convex+rerank': cvxRe }
  const pos = {}
  for (const [k, r] of Object.entries(variants)) {
    acc[k].ndcg += ndcg(r, golds)
    acc[k].mrr += rr(r, golds)
    if (golds.has(r[0])) acc[k].r1++
    const i = r.findIndex((id) => golds.has(id))
    pos[k] = i < 0 ? null : i + 1
  }
  rows.push({ id: q.id, intent: q.intent, pos })
  process.stderr.write('.')
}
process.stderr.write('\n')

const n = set.queries.length
const totalPairs = latencies.reduce((a, l) => a + l.n, 0)
const totalMs = latencies.reduce((a, l) => a + l.ms, 0)
console.log(`\n═══ 延迟（CPU，bge-reranker-base quantized，doc 截 ${DOC_CHARS} 字）═══`)
console.log(`  总计 ${totalPairs} 对 / ${(totalMs / 1000).toFixed(1)}s`)
console.log(`  单对平均 ${(totalMs / totalPairs).toFixed(0)}ms`)
console.log(`  → rerank ${TOP} 条候选 ≈ **${((totalMs / totalPairs) * TOP / 1000).toFixed(1)}s/查询**`)

console.log(`\n═══ 重排序增益（n=${n}）═══`)
console.log('  方案'.padEnd(20) + 'nDCG@10  MRR@10  R@1')
for (const [k, s] of Object.entries(acc)) {
  console.log(`  ${k.padEnd(18)} ${(s.ndcg / n).toFixed(3)}    ${(s.mrr / n).toFixed(3)}   ${String(s.r1).padStart(2)}/${n}`)
}

console.log('\n  逐条（gold 位次；→ 表示 rerank 前后变化）：')
for (const r of rows) {
  const a = r.pos['convex'], b = r.pos['convex+rerank']
  const mark = a && b ? (b < a ? ' ↑' : b > a ? ' ↓' : '  ') : '  '
  console.log(
    `    ${r.id} [${(r.intent ?? '?').padEnd(10)}] fts=${String(r.pos['fts'] ?? 'MISS').padStart(4)}` +
      `  convex=${String(a ?? 'MISS').padStart(4)} → +rerank=${String(b ?? 'MISS').padStart(4)}${mark}`,
  )
}
db.close()
