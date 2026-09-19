#!/usr/bin/env node
/**
 * 分块索引消融 —— 替代 `content.slice(0, 300)`
 *
 * ## 为什么必须改
 *
 * 生产的向量语料是 `content.slice(0, 300)`，而宫殿抽屉**开头常是原始日志粘贴**
 * （最长 4 万字，平均 1673 字）。等于在给日志头建索引，文档主体完全不可见。
 *
 * ## 方案与约束
 *
 * Late chunking（arXiv:2409.04701）在长文档上 nDCG 增益可观（NFCorpus 23.46→29.98），
 * 但它要求**整篇过一遍 transformer** 再按 chunk 边界 mean-pool ——
 * **e5-small 只有 512 token 窗口，做不了**。这是硬约束，不是取舍。
 *
 * 退路是朴素 **chunk + max-pooling**：切块、逐块编码、文档分 = 各块余弦最大值。
 * 论文里 "no chunking" 在部分数据集上反而略胜 late chunking，说明差距不大，
 * 而这条路在本机可落地。
 *
 * ## 本脚本比什么
 *
 * | 配置 | 语料 |
 * |---|---|
 * | `head300` | 当前生产：前 300 字 |
 * | `head1000` | 前 1000 字（旧消融的最优档） |
 * | `chunk-max` | 切 N 字块、逐块编码、取 max 余弦 |
 * | `chunk-max-delog` | 同上，但**先剥掉开头的原始日志/命令块** |
 *
 * 判据与 `palace-fusion-bench.mjs` 一致（drawer_id + nDCG/MRR/Recall），
 * 并同时报"纯向量"与"凸组合 α=0.6"两种用法下的表现——因为分块的价值可能
 * 只在融合里体现。
 *
 * 用法：node scripts/exp-palace-chunking.mjs [--chunk 350] [--set <path>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const SET = arg('--set', 'docs/test/memory-eval/palace-eval-set-v7-seed.json')
const CHUNK = Number(arg('--chunk', 350))
const MAX_CHUNKS = Number(arg('--max-chunks', 12)) // 4 万字的抽屉别切出 114 块
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

/**
 * 剥掉开头的原始日志/命令块。判据是"看起来不像自然语言的行"：
 * shell 提示符、docker/mysql 命令、ISO 时间戳行、纯 ASCII 长行。
 * 只剥**开头连续**的这类行——中间的代码块是有信息的，不能删。
 */
/**
 * 剥掉开头的原始日志/命令块。
 *
 * 注意 `user: ` 前缀——归档格式会把整段粘贴包在 `user: ` 后面，所以判定前
 * 必须先剥这个前缀，否则 `^root@` 之类的规则一条都匹配不到（我第一版就踩了，
 * 只剥到 17/1182）。
 *
 * 只剥**开头连续**的日志行——中间的代码块是有信息的，不能删。
 */
function stripLeadingLogs(content) {
  const lines = content.split('\n')
  let i = 0
  const looksLikeLog = (raw) => {
    const t = raw.trim().replace(/^(user|assistant):\s*/, '')
    if (!t) return true
    if (/^(root@|\$|>|#\s|PS |C:\\)/.test(t)) return true
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) return true
    if (/^(docker|mysql|curl|grep|awk|sed|tail|cat|ls|cd|npm|pnpm|node)\b/.test(t)) return true
    if (/\b(docker (logs|ps|exec)|mysqladmin|journalctl)\b/.test(t)) return true
    // 几乎没有中文、且很长 → 大概率是日志/命令
    const cjk = (t.match(/[一-鿿]/g) ?? []).length
    if (t.length > 60 && cjk / t.length < 0.05) return true
    return false
  }
  while (i < lines.length && looksLikeLog(lines[i])) i++
  const stripped = lines.slice(i).join('\n').trim()
  return stripped.length >= 80 ? stripped : content // 剥太狠就回退
}

function chunksOf(content, size) {
  const out = []
  for (let i = 0; i < content.length && out.length < MAX_CHUNKS; i += size) {
    const c = content.slice(i, i + size).trim()
    if (c.length >= 20) out.push(c)
  }
  return out.length ? out : [content.slice(0, size)]
}

const CONFIGS = {
  head300: (c) => [c.slice(0, 300).trim()],
  head1000: (c) => [c.slice(0, 1000).trim()],
  'chunk-max': (c) => chunksOf(c, CHUNK),
  'chunk-max-delog': (c) => chunksOf(stripLeadingLogs(c), CHUNK),
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
// 生产前缀启发式：<200 字算 query，否则 passage
const prefix = (t) => (t.trim().length < 200 ? 'query: ' + t : 'passage: ' + t)
async function embed(t) {
  const r = await ext(t, { pooling: 'mean', normalize: true })
  return r.data instanceof Float32Array ? r.data : Float32Array.from(r.data)
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
function recall(ranked, golds, k) {
  let h = 0
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (golds.has(ranked[i])) h++
  return h / golds.size
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

const set = JSON.parse(fs.readFileSync(SET, 'utf8'))
// FTS 只算一次（与语料配置无关）
const ftsCache = set.queries.map((q) => ftsScored(q.query))
const qvecs = []
for (const q of set.queries) qvecs.push(await embed(prefix(q.query)))

console.log(`语料 ${docs.length} 条，查询 ${set.queries.length} 条，chunk=${CHUNK} 字，上限 ${MAX_CHUNKS} 块\n`)
const results = {}

for (const [name, fn] of Object.entries(CONFIGS)) {
  const t0 = Date.now()
  // 编码全部文档（每文档多向量）
  const docVecs = []
  let totalChunks = 0
  for (const d of docs) {
    const cs = fn(d.content)
    totalChunks += cs.length
    const vs = []
    for (const c of cs) vs.push(await embed(prefix(c)))
    docVecs.push({ id: d.id, vs })
  }
  const encMs = Date.now() - t0

  let vNdcg = 0, vMrr = 0, vRec = 0, vR1 = 0
  let cNdcg = 0, cMrr = 0, cRec = 0, cR1 = 0
  for (let qi = 0; qi < set.queries.length; qi++) {
    const q = set.queries[qi]
    const golds = new Set(q.golds ?? [q.gold])
    const qv = qvecs[qi]
    // max-pooling over chunks
    const scored = docVecs
      .map((d) => {
        let best = -1
        for (const v of d.vs) best = Math.max(best, cos(qv, v))
        return { id: d.id, s: best }
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, POOL)
    const vRanked = scored.map((x) => x.id)
    vNdcg += ndcg(vRanked, golds)
    vMrr += rr(vRanked, golds)
    vRec += recall(vRanked, golds, POOL)
    if (golds.has(vRanked[0])) vR1++

    const cRanked = convex(ftsCache[qi], scored, ALPHA)
    cNdcg += ndcg(cRanked, golds)
    cMrr += rr(cRanked, golds)
    cRec += recall(cRanked, golds, POOL)
    if (golds.has(cRanked[0])) cR1++
  }
  const n = set.queries.length
  results[name] = {
    chunks: totalChunks,
    encMs,
    vec: { ndcg: vNdcg / n, mrr: vMrr / n, rec: vRec / n, r1: vR1 },
    cvx: { ndcg: cNdcg / n, mrr: cMrr / n, rec: cRec / n, r1: cR1 },
  }
  console.log(
    `[${name}] 向量数 ${totalChunks}（${(totalChunks / docs.length).toFixed(1)}/文档） 编码 ${(encMs / 1000).toFixed(0)}s` +
      `  纯向量 nDCG=${(vNdcg / n).toFixed(3)}  凸组合 nDCG=${(cNdcg / n).toFixed(3)}`,
  )
}

const n = set.queries.length
console.log(`\n═══ 语料配置消融（n=${n}）═══`)
console.log('  配置'.padEnd(20) + '│ 纯向量                        │ 凸组合 α=0.6')
console.log('  '.padEnd(20) + '│ nDCG   MRR    R@1    Rec@30   │ nDCG   MRR    R@1    Rec@30')
for (const [k, r] of Object.entries(results)) {
  const v = r.vec, c = r.cvx
  console.log(
    `  ${k.padEnd(18)}│ ${v.ndcg.toFixed(3)}  ${v.mrr.toFixed(3)}  ${String(v.r1).padStart(2)}/${n}  ${v.rec.toFixed(3)}    │ ` +
      `${c.ndcg.toFixed(3)}  ${c.mrr.toFixed(3)}  ${String(c.r1).padStart(2)}/${n}  ${c.rec.toFixed(3)}`,
  )
}
console.log(`\n  参考：纯 FTS 基线 nDCG@10 = 0.696（见 palace-fusion-bench.mjs）`)
db.close()
