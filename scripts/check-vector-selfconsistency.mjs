#!/usr/bin/env node
/**
 * 向量索引自洽性检查 —— 用 gold 自己的开头当查询，它能不能排回自己？
 *
 * ## 为什么要做这个检查
 *
 * 2026-09-18 的 v6 对照测出现**反常结果**：开启向量后 R@1 从 19/31 掉到 7/31。
 * 一种解释是"融合确实会打乱 FTS 的前排"，但如果向量通道**根本没在工作**
 * （比如索引与查询不同源、模型不对、前缀口径错），表现是一样的。
 *
 * 这个脚本把两种解释分开：查询直接取 gold 的**向量语料本身**
 * （`content.slice(0,300)`，即库里那条向量编码的原文）。它排回自己的名次
 * 是这条通道的**自洽性下界**——若连这个都 MISS 或排到几十名，问题在索引/口径，
 * 不在融合。
 *
 * 与生产同口径：语料 `content.slice(0,300).trim()`、前缀走
 * `wiki-transformers-embedder.ts` 的长度启发式、余弦、LIMIT 30。
 *
 * 用法：node scripts/check-vector-selfconsistency.mjs [--sample 60]
 */
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'

const argv = process.argv.slice(2)
const SAMPLE = argv.includes('--sample') ? Number(argv[argv.indexOf('--sample') + 1]) : 60

const prodPrefix = (text) => (text.trim().length < 200 ? 'query: ' + text : 'passage: ' + text)
const cos = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

const DB = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const db = new DatabaseSync(DB)

const vecs = db
  .prepare(
    `SELECT e.drawer_id AS id, e.embedding AS emb, e.model_id AS mid, e.dims AS dims
       FROM palace_drawer_embeddings e
       JOIN palace_drawers d ON d.drawer_id = e.drawer_id
      WHERE d.deleted_at IS NULL`,
  )
  .all()
  .map((r) => ({
    id: r.id,
    mid: r.mid,
    dims: r.dims,
    v: new Float32Array(r.emb.buffer, r.emb.byteOffset, r.emb.length / 4),
  }))
const byId = new Map(
  db.prepare('SELECT drawer_id, content FROM palace_drawers WHERE deleted_at IS NULL').all().map((r) => [r.drawer_id, r.content]),
)
console.log(`向量 ${vecs.length} 条 / 活跃抽屉 ${byId.size} 条`)
const models = [...new Set(vecs.map((v) => `${v.mid}(${v.dims})`))]
console.log(`模型: ${models.join(', ')}`)

const CACHE = path.join(os.homedir(), '.lumii', 'models', 'wiki-embeddings', 'Xenova')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE
env.allowRemoteModels = false
const ext = await pipeline('feature-extraction', 'multilingual-e5-small', {
  quantized: true,
  local_files_only: true,
})

// 取样本：优先长文（长文的向量语料只有开头，是更严格的考验）
const pool = [...byId.entries()].filter(([, c]) => c.trim().length > 0)
pool.sort((a, b) => b[1].length - a[1].length)
const sample = pool.slice(0, SAMPLE)

let selfRank = []
let prefixUsed = { query: 0, passage: 0 }
for (const [id, content] of sample) {
  // **查询 = gold 自己的向量语料**（库里那条向量的原文）
  const corpus = content.slice(0, 300).trim()
  if (!corpus) continue
  const prefixed = prodPrefix(corpus)
  if (prefixed.startsWith('query:')) prefixUsed.query++
  else prefixUsed.passage++

  const r = await ext(prefixed, { pooling: 'mean', normalize: true })
  const qv = r.data instanceof Float32Array ? r.data : Float32Array.from(r.data)
  const ranked = vecs.map((x) => ({ id: x.id, s: cos(qv, x.v) })).sort((a, b) => b.s - a.s)
  const pos = ranked.findIndex((x) => x.id === id)
  selfRank.push({ id, pos: pos < 0 ? Infinity : pos + 1, top1: ranked[0].id, top1IsSelf: ranked[0].id === id })
}

const hit = (k) => selfRank.filter((r) => r.pos <= k).length
const miss = selfRank.filter((r) => r.pos === Infinity).length
console.log(`\n样本 ${selfRank.length} 条（前缀：passage ${prefixUsed.passage} / query ${prefixUsed.query}）`)
console.log(`  自命中 R@1 : ${hit(1)}/${selfRank.length}  (${((hit(1) / selfRank.length) * 100).toFixed(0)}%)`)
console.log(`  自命中 R@5 : ${hit(5)}/${selfRank.length}`)
console.log(`  自命中 R@30: ${hit(30)}/${selfRank.length}`)
console.log(`  完全未命中 : ${miss}/${selfRank.length}`)

// 分布：<300 字的抽屉（内容短）与 ≥300 字的分开看——短的那批整条都在语料里，
// 长的只有前 300 字。若两者差距大，说明"开头截断"是主因。
const shortIds = new Set([...byId.entries()].filter(([, c]) => c.length < 300).map(([id]) => id))
for (const label of ['<300字', '>=300字']) {
  const sub = selfRank.filter((r) => (label === '<300字' ? shortIds.has(r.id) : !shortIds.has(r.id)))
  if (!sub.length) continue
  console.log(
    `  ${label.padEnd(9)} n=${String(sub.length).padEnd(4)} R@1=${sub.filter((r) => r.pos <= 1).length} R@5=${sub.filter((r) => r.pos <= 5).length} 未命中=${sub.filter((r) => r.pos === Infinity).length}`,
  )
}

const worst = [...selfRank].filter((r) => r.pos > 5).sort((a, b) => (b.pos === Infinity ? 1e9 : b.pos) - (a.pos === Infinity ? 1e9 : a.pos)).slice(0, 5)
if (worst.length) {
  console.log('\n排得最差的几条（看看是不是长文/低信息开头）：')
  for (const w of worst) {
    const c = byId.get(w.id) ?? ''
    console.log(`  ${w.id.slice(0, 8)} 排名=${w.pos === Infinity ? 'MISS' : '#' + w.pos} 全长=${c.length} 开头="${c.slice(0, 46).replace(/\n/g, ' ')}"`)
  }
}
db.close()
