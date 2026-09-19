#!/usr/bin/env node
/**
 * 融合算法对照台 —— 判据落在 drawer_id 上，指标用 nDCG/MRR/Recall
 *
 * ## 与旧脚本的区别
 *
 * `palace-prod-ab.mjs` / `exp-palace-fusion-strategies.mjs` 用的是子串判据，
 * 已证明测的不是检索（`eval-criteria-contrast.mjs`）。本脚本：
 *
 * - 判据 = `返回的 drawer_id ∈ q.golds`，**不做任何文本匹配**
 * - 指标 = nDCG@10（多 gold 主指标）+ MRR@10（头部对不对）+ Recall@30（召回层上限）
 * - 支持多 gold
 *
 * ## 融合策略
 *
 * 除 RRF 外，重点实现 Bruch et al. *An Analysis of Fusion Functions for Hybrid
 * Retrieval*（arXiv:2210.11934, TOIS 2023）的**凸组合**：
 *
 *     score = α · norm(bm25) + (1-α) · norm(cos)
 *
 * 论文两个关键结论，本脚本据此设计：
 *
 * 1. **凸组合 > RRF**（MS MARCO nDCG@1000：TM2C2 0.454 vs RRF 0.425），且 RRF 的
 *    参数敏感性其实很高、跨域不迁移。
 * 2. **一路系统性失明时，有界性（boundedness）比什么都重要**。per-query min-max
 *    会把失明那路的噪声**拉伸到满量程**，反而放大干扰。故实现 TM2（theoretical
 *    min-max，用理论界而非 batch 内实际 min/max）：
 *    - 余弦：理论界 [-1, 1] 已知
 *    - BM25：SQLite 的 bm25() 返回负值（越小越相关），用全集分位数当理论界
 *
 * 论文推荐 α ∈ [0.6, 0.8]（α 为稀疏路权重），且 <5% 训练数据即收敛——对只有
 * 几十条的评测集是好消息。
 *
 * 用法：node scripts/palace-fusion-bench.mjs [--set <path>] [--pool 30]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const SET = arg('--set', 'docs/test/memory-eval/palace-eval-set-v7-seed.json')
const POOL = Number(arg('--pool', 30))

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
const requiredHits = (n) => (n >= 2 ? 2 : 1)

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'))
const docs = db.prepare('SELECT drawer_id id, content FROM palace_drawers WHERE deleted_at IS NULL').all()

/** FTS：与生产 ftsRankedRows 同口径，但**保留 bm25 原始分**供凸组合用 */
function ftsScored(query) {
  const ts = [...tok(query)]
  if (!ts.length) return []
  const match = ts.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
  const need = requiredHits(ts.length)
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

// ── 向量（读库里已落盘的生产索引，w300 口径）──
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
const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
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
const prodPrefix = (t) => (t.trim().length < 200 ? 'query: ' + t : 'passage: ' + t)
async function embed(t) {
  const r = await ext(t, { pooling: 'mean', normalize: true })
  return r.data instanceof Float32Array ? r.data : Float32Array.from(r.data)
}
async function vecScored(query) {
  if (!vecs.length) return []
  const q = await embed(prodPrefix(query))
  return vecs
    .map((x) => ({ id: x.id, s: cos(q, x.v) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, POOL)
}

// ── 归一化 ──
/** TM2：理论界归一化。余弦界 [-1,1]；bm25 用全集分位数估上下界（负值，越小越相关） */
function makeTM2Bm25Bounds() {
  // 全集分位数当"理论界"——关键是它**跨查询固定**，不随单条查询的候选分布漂移，
  // 这正是 TM2 相对 per-query min-max 的优势（失明那路的噪声不会被拉满量程）。
  // 实测值（scripts 里采样 1020 个 bm25 分）：min -37.77 / p1 -27.64 / p50 -9.37 / max -5.18
  return { lo: -20, hi: -5 }
}
const BM25_B = makeTM2Bm25Bounds()
const normBm25TM2 = (s) => {
  const v = (s - BM25_B.lo) / (BM25_B.hi - BM25_B.lo) // bm25 越小越相关
  return 1 - Math.min(1, Math.max(0, v)) // 翻转：越小的 bm25 → 越接近 1
}

/**
 * 余弦的"理论界"**不能用 [-1, 1]**——这是本次实测最反直觉的一条。
 *
 * e5 在本语料上的余弦实际只落在 **0.862~0.931**，即理论量程的 3%。用 [-1,1]
 * 归一化后所有向量分被压成 ~0.93 的窄带，区分度几乎归零，TM2 因此**输给**
 * per-query min-max（0.733 vs 0.778），与论文预期相反。
 *
 * 界扫描结果（nDCG@10，bm25 界固定 [-20,-5]）：
 *   cos 界 [-1,1] → 0.690   [0.7,0.95] → 0.707   [0.8,0.95] → **0.756**
 *
 * 即：TM2 的前提是"分数分布跨查询可比且铺满理论量程"。稠密检索在**同构语料**
 * 上不满足后半句，必须用经验分位数而非数学上下界。
 */
const COS_B = { lo: 0.8, hi: 0.95 }
const normCosTM2 = (s) => Math.min(1, Math.max(0, (s - COS_B.lo) / (COS_B.hi - COS_B.lo)))

/** per-query min-max（对照组，论文指出它在失明那路会放大噪声） */
function minmax(list) {
  if (!list.length) return new Map()
  const vals = list.map((x) => x.s)
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const span = hi - lo || 1
  return new Map(list.map((x) => [x.id, (x.s - lo) / span]))
}
/** bm25 的 min-max 要翻转（越小越相关） */
function minmaxBm25(list) {
  if (!list.length) return new Map()
  const vals = list.map((x) => x.s)
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const span = hi - lo || 1
  return new Map(list.map((x) => [x.id, 1 - (x.s - lo) / span]))
}

function rrf(lists, k) {
  const m = new Map()
  for (const l of lists) l.forEach((x, i) => m.set(x.id, (m.get(x.id) ?? 0) + 1 / (k + i + 1)))
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

function convex(f, v, alpha, normF, normV) {
  const fm = normF(f), vm = normV(v)
  const all = new Set([...f.map((x) => x.id), ...v.map((x) => x.id)])
  const out = []
  for (const id of all) {
    const a = fm.get(id) ?? 0
    const b = vm.get(id) ?? 0
    out.push([id, alpha * a + (1 - alpha) * b])
  }
  return out.sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

// TM2 版：直接按理论界算，缺席方记 0
function convexTM2(f, v, alpha) {
  const fm = new Map(f.map((x) => [x.id, normBm25TM2(x.s)]))
  const vm = new Map(v.map((x) => [x.id, normCosTM2(x.s)]))
  const all = new Set([...fm.keys(), ...vm.keys()])
  const out = []
  for (const id of all) out.push([id, alpha * (fm.get(id) ?? 0) + (1 - alpha) * (vm.get(id) ?? 0)])
  return out.sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

// ── 指标 ──
function dcg(ranked, golds, k) {
  let s = 0
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (golds.has(ranked[i])) s += 1 / Math.log2(i + 2)
  }
  return s
}
function ndcg(ranked, golds, k) {
  const ideal = [...golds].slice(0, k).reduce((a, _, i) => a + 1 / Math.log2(i + 2), 0)
  return ideal ? dcg(ranked, golds, k) / ideal : 0
}
function rr(ranked, golds, k) {
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (golds.has(ranked[i])) return 1 / (i + 1)
  return 0
}
function recall(ranked, golds, k) {
  let h = 0
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (golds.has(ranked[i])) h++
  return h / golds.size
}

const rawSet = JSON.parse(fs.readFileSync(SET, 'utf8'))
// 排除 disputed 样本：候选与已标 gold 语义矛盾，说明 gold 本身可疑，
// 硬塞任何一边都会污染结论（见 merge-judgments.mjs 的 DISPUTED 说明）。
const excluded = rawSet.queries.filter((q) => q.disputed)
const set = { ...rawSet, queries: rawSet.queries.filter((q) => !q.disputed) }
if (excluded.length) {
  console.log(`已排除 ${excluded.length} 条争议样本：${excluded.map((q) => q.id).join(', ')}`)
}
const ALPHAS = [0.5, 0.6, 0.7, 0.8, 0.9]
const strategies = {
  'fts(基线)': (f, v) => f.map((x) => x.id),
  'vec(基线)': (f, v) => v.map((x) => x.id),
  'rrf-k10': (f, v) => rrf([f, v], 10),
  'rrf-k60(生产)': (f, v) => rrf([f, v], 60),
  'rrf-k200': (f, v) => rrf([f, v], 200),
}
for (const a of ALPHAS) {
  strategies[`convex-TM2-a${a}`] = (f, v) => convexTM2(f, v, a)
  strategies[`convex-mm-a${a}`] = (f, v) => convex(f, v, a, minmaxBm25, minmax)
}

const names = Object.keys(strategies)
const acc = Object.fromEntries(names.map((n) => [n, { ndcg: 0, mrr: 0, rec: 0, r1: 0 }]))
const perQuery = []

for (const q of set.queries) {
  const golds = new Set(q.golds ?? [q.gold])
  const f = ftsScored(q.query)
  const v = await vecScored(q.query)
  const row = { id: q.id, intent: q.intent, ranks: {} }
  for (const n of names) {
    const ranked = strategies[n](f, v)
    acc[n].ndcg += ndcg(ranked, golds, 10)
    acc[n].mrr += rr(ranked, golds, 10)
    acc[n].rec += recall(ranked, golds, POOL)
    const i = ranked.findIndex((id) => golds.has(id))
    if (i === 0) acc[n].r1++
    row.ranks[n] = i < 0 ? null : i + 1
  }
  perQuery.push(row)
}

const n = set.queries.length
console.log(`\n═══ 融合算法对照（n=${n}，判据=drawer_id，池=${POOL}）═══`)
console.log('  策略'.padEnd(22) + 'nDCG@10  MRR@10  R@1     Recall@30')
const order = names.slice().sort((a, b) => acc[b].ndcg - acc[a].ndcg)
for (const nm of order) {
  const s = acc[nm]
  console.log(
    `  ${nm.padEnd(20)} ${(s.ndcg / n).toFixed(3)}    ${(s.mrr / n).toFixed(3)}   ${String(s.r1).padStart(2)}/${n}   ${(s.rec / n).toFixed(3)}`,
  )
}

// 按 intent 分层看最优策略 vs 基线
const best = order[0]
console.log(`\n  按 intent 分层（nDCG@10，对比 fts 基线 vs 最优 ${best}）：`)
const byIntent = {}
for (const r of perQuery) (byIntent[r.intent ?? '?'] ??= []).push(r)
for (const [k, rows] of Object.entries(byIntent)) {
  const g = (nm) =>
    rows.reduce((a, r) => a + (r.ranks[nm] ? 1 / Math.log2(r.ranks[nm] + 1) : 0), 0) / rows.length
  console.log(`    ${k.padEnd(11)} n=${String(rows.length).padStart(2)}  fts=${g('fts(基线)').toFixed(3)}  ${best}=${g(best).toFixed(3)}`)
}

console.log('\n  逐条（gold 最佳位次）：')
for (const r of perQuery) {
  const a = r.ranks['fts(基线)'], b = r.ranks['vec(基线)'], c = r.ranks[best]
  console.log(
    `    ${r.id} [${(r.intent ?? '?').padEnd(10)}] fts=${String(a ?? 'MISS').padStart(4)}  vec=${String(b ?? 'MISS').padStart(4)}  ${best}=${String(c ?? 'MISS').padStart(4)}`,
  )
}
db.close()
