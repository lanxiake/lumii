#!/usr/bin/env node
/**
 * 池化候选导出 —— 供人工补判，修掉「未判即假阴性」偏差
 *
 * ## 为什么必须做
 *
 * v7 种子集每条查询只标了 1~2 个 gold（我读抽屉时最明显的那条），但实测发现
 * 同主题抽屉大量重复：讲 `file_edit oldString 失败` 的有 8 条、讲 `exit 3` 的
 * 7 条、讲 `flush-hosts` 的 57 条。**只标 1 个 gold 会把"找到了另一条同样正确
 * 的抽屉"误判为失败**，系统性低估所有方案。
 *
 * BEIR 的 Touché 子集重判后模型排序全变（Thakur et al., SIGIR 2024），
 * 说明这不是小偏差。
 *
 * ## 做法（多系统池化，对齐 T2Ranking / DuReader-retrieval）
 *
 * 取多个检索方案各自 top-K 的**并集**作为待判池 —— 不是单系统 top-K，
 * 否则池子本身带方案偏见。本脚本用四路：
 *
 * - FTS（bm25）
 * - 纯向量（余弦）
 * - 凸组合 α=0.6
 * - RRF k=60
 *
 * 输出每条候选的 `head`（前 260 字）供判断，**不自动判**——关键词匹配已证明
 * 不可靠（`落盘` 命中 142 条，显然不都相关）。判断必须人来。
 *
 * 用法：
 *   node scripts/pool-candidates-for-judging.mjs --k 10 --out docs/test/memory-eval/v7-pool.json
 * 然后人工编辑产出文件，把确认相关的 id 填进 `verdict`，再用
 * `merge-judgments.mjs` 合并回评测集。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const SET = arg('--set', 'docs/test/memory-eval/palace-eval-set-v7-seed.json')
const K = Number(arg('--k', 10))
const OUT = arg('--out', 'docs/test/memory-eval/v7-pool.json')
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
function rrf(lists, k) {
  const m = new Map()
  for (const l of lists) l.forEach((x, i) => m.set(x.id, (m.get(x.id) ?? 0) + 1 / (k + i + 1)))
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

const set = JSON.parse(fs.readFileSync(SET, 'utf8'))
const out = []
for (const q of set.queries) {
  const known = new Set(q.golds ?? [q.gold])
  const f = ftsScored(q.query)
  const qv = await embed(prefix(q.query))
  const v = vecs
    .map((x) => ({ id: x.id, s: cos(qv, x.v) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, POOL)

  // 四路 top-K 并集
  const pooled = new Set([
    ...f.slice(0, K).map((x) => x.id),
    ...v.slice(0, K).map((x) => x.id),
    ...convex(f, v, ALPHA).slice(0, K),
    ...rrf([f, v], 60).slice(0, K),
  ])
  const candidates = [...pooled]
    .filter((id) => !known.has(id)) // 已标的不用再判
    .map((id) => ({ id, head: (byId.get(id) ?? '').slice(0, 260).replace(/\s+/g, ' ') }))

  out.push({
    id: q.id,
    query: q.query,
    intent: q.intent,
    knownGolds: [...known],
    poolSize: pooled.size,
    toJudge: candidates,
    verdict: [], // ← 人工填：确认相关的 id
  })
  process.stderr.write('.')
}
process.stderr.write('\n')

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      _comment:
        '池化待判池。四路（fts/vec/convex/rrf）各 top-' + K + ' 的并集，去掉已标 gold。' +
        '人工把确认相关的 id 填进每条的 verdict 数组，然后跑 merge-judgments.mjs 合并。' +
        '不要用关键词自动判——已验证不可靠。',
      generatedAt: '2026-09-19',
      k: K,
      queries: out,
    },
    null,
    1,
  ),
  'utf8',
)
const totalToJudge = out.reduce((a, o) => a + o.toJudge.length, 0)
console.log(`→ ${OUT}`)
console.log(`  ${out.length} 条查询，待判候选共 ${totalToJudge} 条（平均 ${(totalToJudge / out.length).toFixed(1)}/查询）`)
db.close()
