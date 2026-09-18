#!/usr/bin/env node
/**
 * 生产口径 A/B：`searchDrawers`（纯 FTS） vs `searchDrawersHybrid`（FTS + 向量 RRF）
 *
 * ## 为什么不复用 palace-semantic-eval.mjs
 *
 * 那个脚本是**理想口径**：bigram 排名直接在全部 1079 条上算，没有候选池截断、
 * 没有最小命中过滤。而生产两条路径都过 `SEARCH_CANDIDATE_POOL = 30` +
 * `requiredTokenHits(≥2)`——**被池子截掉的 gold，向量是唯一能救它的通道**。
 * 用理想口径量出的差距会**低估**向量的价值，因为理想 FTS 已经能看见池外的 gold。
 *
 * ## 两侧口径的来源（不靠复刻，逐条对齐源码）
 *
 * - FTS：`PalaceRepo.ftsRankedRows`（palace-repo.ts:535）——`tokenizeBigram` OR 匹配、
 *   `bm25()` 排序、LIMIT 30、`countTokenHits >= requiredTokenHits`
 * - 向量：`PalaceVectorIndex.searchSimilar`（palace-vector.ts:130）——余弦、LIMIT 30
 * - 融合：`reciprocalRankFusion`（wiki-vector.ts）、k=60
 * - 语料：`buildPalaceVectorCorpus` = `content.slice(0,300).trim()`
 * - 前缀：生产 `embed()` 的长度启发式（wiki-transformers-embedder.ts:172）
 *
 * 分词逻辑从 `segmentation.ts` **内联复制**（值一致，避免依赖 ts 源码的运行时导入）；
 * 每次改动 palace-repo 的检索口径都要回来核这里。
 *
 * ## 判据
 *
 * 对每条 query 找 gold（`expect` 字面量子串），记它在两条路径里的**最终返回排名**
 * （前 `--k` 条，默认 10 = 生产 limit）。R@1 / R@5 / R@10 三档都要看：
 * 融合的价值常体现在「挤进前排」而不只是「进没进」。
 *
 * 用法：node scripts/palace-prod-ab.mjs [--k 10] [--set <path>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'

// ── 生产常量（逐条对齐 palace-repo.ts / wiki-vector.ts）──
const SEARCH_CANDIDATE_POOL = 30
const RRF_K = 60
const MIN_QUERY_TOKEN_HITS = 2

const argv = process.argv.slice(2)
const TOP_K = argv.includes('--k') ? Number(argv[argv.indexOf('--k') + 1]) : 10
const SET = argv.includes('--set')
  ? argv[argv.indexOf('--set') + 1]
  : // v6 是当前主集：查询取自真实用户提问、gold 为同会话前序归档，**非循环**
    // （v1 集只有 8 条且措辞由人编写，一条翻转 = ±12.5pp，看不出趋势）
    'docs/test/memory-eval/palace-eval-set-v6.json'

// ── 分词：内联复制自 packages/agent-runtime/src/memory/segmentation.ts ──
const CJK_RE = /[㐀-䶿一-鿿]/
const TOKEN_SEG_RE = /[㐀-䶿一-鿿]+|[a-z0-9]+/g
function tokenizeBigram(text) {
  const tokens = new Set()
  if (!text) return tokens
  const matches = text.toLowerCase().match(TOKEN_SEG_RE)
  if (!matches) return tokens
  for (const seg of matches) {
    if (CJK_RE.test(seg[0])) {
      if (seg.length === 1) tokens.add(seg)
      else for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2))
    } else tokens.add(seg)
  }
  return tokens
}
const requiredTokenHits = (n) => (n >= MIN_QUERY_TOKEN_HITS ? MIN_QUERY_TOKEN_HITS : 1)
function countTokenHits(tokens, ftsText) {
  let hits = 0
  for (const t of tokens) if (ftsText.includes(t)) hits++
  return hits
}

function reciprocalRankFusion(lists, k = RRF_K) {
  const scores = new Map()
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)))
  }
  return scores
}

/** 生产前缀启发式：逐字对齐 wiki-transformers-embedder.ts:172 */
const prodPrefix = (text) => (text.trim().length < 200 ? 'query: ' + text : 'passage: ' + text)

// ── 库 ──
const DB = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const db = new DatabaseSync(DB)
const docs = db
  .prepare('SELECT drawer_id AS id, content FROM palace_drawers WHERE deleted_at IS NULL')
  .all()
const byId = new Map(docs.map((d) => [d.id, d.content]))
// FTS 索引文本（生产里是 palace_drawers_fts.content，bigramJoin 过的）；这里直接用原文
// 做 includes 判定——对 `countTokenHits` 的语义等价（它也是子串判定）。
const ftsText = new Map(docs.map((d) => [d.id, d.content]))
console.log(`宫殿语料 ${docs.length} 条`)

/**
 * FTS 排名：**与生产 `ftsRankedRows` 同口径**——FTS5 OR 匹配、bm25 排序、
 * 先取候选池再做最小命中过滤。返回的是**过滤后的排名序列**。
 *
 * 注意：候选池截断发生在**过滤之前**（SQL 里 LIMIT 30），所以池里可能只有
 * 个位数条能过阈值——这正是「池外的 gold 除非向量捞回来，否则永远上不来」的机制。
 */
function ftsRanked(query) {
  const tokens = [...tokenizeBigram(query)]
  if (tokens.length === 0) return []
  const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
  const need = requiredTokenHits(tokens.length)
  let rows
  try {
    rows = db
      .prepare(
        `SELECT d.drawer_id AS id, bm25(palace_drawers_fts) AS rank,
                palace_drawers_fts.content AS fts_content
           FROM palace_drawers_fts
           JOIN palace_drawers d ON d.rowid = palace_drawers_fts.rowid
          WHERE palace_drawers_fts MATCH ? AND d.deleted_at IS NULL
          ORDER BY bm25(palace_drawers_fts)
          LIMIT ?`,
      )
      .all(match, SEARCH_CANDIDATE_POOL)
  } catch (err) {
    console.warn('FTS 查询失败：', err.message)
    return []
  }
  return rows.filter((r) => countTokenHits(tokens, r.fts_content) >= need).map((r) => r.id)
}

// ── 向量：从库里读**已落库**的向量，不重算 ──
// 重算会引入「脚本的 embed 与生产的 embed 是否一致」这个额外变量。库里 1059 条
// 是应用自己写进去的，用它才是在测**生产实际索引**。
const embRows = db
  .prepare(
    `SELECT e.drawer_id AS id, e.embedding AS emb, e.dims AS dims
       FROM palace_drawer_embeddings e
       JOIN palace_drawers d ON d.drawer_id = e.drawer_id
      WHERE d.deleted_at IS NULL`,
  )
  .all()
console.log(`已落库向量 ${embRows.length} 条（缺失 ${docs.length - embRows.length} 条）`)

const vecs = embRows.map((r) => {
  const buf = r.emb
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
  return { id: r.id, v: f32 }
})
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
const t0 = Date.now()
const ext = await pipeline('feature-extraction', 'multilingual-e5-small', {
  quantized: true,
  local_files_only: true,
})
console.log(`模型加载 ${Date.now() - t0}ms`)

async function embedOne(text) {
  const r = await ext(text, { pooling: 'mean', normalize: true })
  const data = r.data instanceof Float32Array ? r.data : Float32Array.from(r.data)
  return data
}

/** 向量排名：与 `searchSimilar` 同口径（余弦降序、LIMIT 30） */
async function vectorRanked(query) {
  if (vecs.length === 0) return []
  const q = await embedOne(prodPrefix(query))
  return vecs
    .map((x) => ({ id: x.id, s: cos(q, x.v) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, SEARCH_CANDIDATE_POOL)
    .map((x) => x.id)
}

// ── 跑分 ──
const set = JSON.parse(fs.readFileSync(SET, 'utf8'))
const modes = ['fts', 'rrf']
const stats = { fts: {}, rrf: {} }
const rowsForPrint = []
// v6 集没有 category 字段（分类维度换成了 ctxOverlap 分层）；缺省归到「全部」，
// 否则逐条打印会出现 `[undefined]`，汇总表还会按 undefined 分组。
const catOf = (q) => q.category ?? (q.ctxOverlap == null ? '全部' : `重叠${q.ctxOverlap < 0.2 ? '低' : q.ctxOverlap < 0.6 ? '中' : '高'}`)

for (const q of set.queries) {
  const isGold = (id) => {
    const c = byId.get(id)
    return c ? q.expect.some((e) => c.includes(e)) : false
  }
  const f = ftsRanked(q.query)
  const v = await vectorRanked(q.query)
  // RRF：两侧排名进入融合；向量命中的抽屉即使不在 FTS 里也要补回来
  // （生产 missing 分支，palace-repo.ts:497）
  const rrfMap = reciprocalRankFusion([f, v])
  const all = new Set([...f, ...v])
  const r = [...rrfMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter((id) => all.has(id))

  const ranked = { fts: f, rrf: r, vec: v }
  const pos = {}
  const foundIn = { fts: isGold && f.some(isGold), rrf: r.some(isGold) }
  for (const m of ['fts', 'vec', 'rrf']) {
    const idx = ranked[m].findIndex(isGold)
    const inPool = idx >= 0
    const inTopK = inPool && idx < TOP_K
    pos[m] = inPool ? `#${idx + 1}${idx < TOP_K ? '' : '(出池)'}` : 'MISS'
    if (m === 'fts' || m === 'rrf') {
      const s = (stats[m][catOf(q)] ??= { n: 0, r1: 0, r5: 0, r10: 0 })
      s.n++
      if (inTopK) {
        if (idx < 1) s.r1++
        if (idx < 5) s.r5++
        if (idx < 10) s.r10++
      }
    }
  }
  // 融合是否新增了 FTS 候选池外的 gold（机制层面最有说服力的那条）
  const goldInVectorOnly = v.some(isGold) && !f.some(isGold)
  rowsForPrint.push({ q, pos, foundIn, goldInVectorOnly, ftsLen: f.length, vecLen: v.length })
}

console.log('\n逐条（gold 在生产返回序列里的位置）:')
for (const { q, pos, foundIn, ftsLen, vecLen } of rowsForPrint) {
  const vecOnly = !foundIn.fts && foundIn.rrf
  console.log(
    `  ${q.id.padEnd(20)} [${catOf(q)}] ` +
      `fts=${pos.fts.padEnd(9)} vec=${pos.vec.padEnd(9)} rrf=${pos.rrf.padEnd(9)}` +
      ` 池: fts过阈${ftsLen}/vec${vecLen}` +
      (vecOnly ? '  ← **向量单独救回**' : ''),
  )
}

console.log(`\n═══ 生产口径 A/B（R@${TOP_K}）═══`)
const cats = [...new Set(set.queries.map(catOf))]
const pad = (s, n) => String(s).padEnd(n)
console.log(pad('类别', 14) + pad('fts(现状)', 14) + 'rrf(开向量)')
for (const c of cats) {
  const s = stats['fts'][c]
  const t = stats['rrf'][c]
  console.log(pad(c, 14) + pad(s ? `${s.r1}/${s.n}` : '-', 14) + (t ? `${t.r1}/${t.n}` : '-'))
}
const sum = (m, key) =>
  Object.values(stats[m]).reduce((a, s) => a + s[key], 0)
const total = set.queries.length
console.log('')
for (const key of ['r1', 'r5', 'r10']) {
  console.log(
    pad(`R@${key.slice(1)}`, 14) + pad(`${sum('fts', key)}/${total}`, 14) + `${sum('rrf', key)}/${total}`,
  )
}
const vecOnly = rowsForPrint.filter((r) => !r.foundIn.fts && r.foundIn.rrf).length
console.log(
  `\n向量单独救回（FTS 候选池外/MISS，融合后进结果）: ${vecOnly}/${total} 条` +
    (vecOnly > 0
      ? ` → ${rowsForPrint.filter((r) => !r.foundIn.fts && r.foundIn.rrf).map((r) => r.q.id).join(', ')}`
      : ''),
)
db.close()
