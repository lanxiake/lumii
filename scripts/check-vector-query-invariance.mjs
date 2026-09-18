#!/usr/bin/env node
/**
 * 向量通道的「查询无关性」检验 —— 它对不同查询返回的是不是同一批？
 *
 * ## 为什么必须验这个
 *
 * RRF 挤占诊断（diag-rrf-displacement.mjs）显示：失败的 case 里 gold 都是
 * `fts=#1 + vec=缺席`，而挤上来的都是 `fts=#10~30 + vec=#1~2`。数学上是
 * `1/90+1/90 > 1/61`——**融合奖励「两边都还行」，惩罚「一边独占第一」**。
 *
 * 这套机制只有在**向量排名确实携带查询相关信息**时才成立。反过来，如果
 * 向量对任意查询都返回同一批"泛化对话文本"（余弦都在 0.85~0.90 挤成一团），
 * 那它贡献的不是信号而是**噪声**——融合会稳定地把这批噪声抬进前排。
 *
 * ## 判据
 *
 * 取 N 条互不相关的查询，各取向量 top-K，测两两 Jaccard。
 * - **低重叠**（< 0.2）→ 排名随查询变化，携带信息
 * - **高重叠**（> 0.5）→ 排名近乎与查询无关，是噪声源
 *
 * 用法：node scripts/check-vector-query-invariance.mjs [--k 10] [--n 10]
 */
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline, env } from '@xenova/transformers'

const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(k) ? Number(argv[argv.indexOf(k) + 1]) : d)
const K = arg('--k', 10)
const N = arg('--n', 10)

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

// 互不相关的查询：主题、领域都不同
const QUERIES = [
  '数据库连接被拉黑的解锁命令',
  '往返机票比价哪个方案划算',
  '平准书那一课的讲义内容',
  'docker 日志里反复出现的报错误',
  'TOCC 数据同步排查结论',
  '二十四史对当前规划有什么参考价值',
  '绘本插图能不能用代码生成',
  '堡垒机的地址和账号是什么',
  '大语言模型的温度参数怎么调',
  '年终奖的个税怎么算',
].slice(0, N)

const tops = []
for (const q of QUERIES) {
  const r = await ext(prodPrefix(q), { pooling: 'mean', normalize: true })
  const qv = r.data instanceof Float32Array ? r.data : Float32Array.from(r.data)
  const ranked = vecs
    .map((x) => ({ id: x.id, s: cos(qv, x.v) }))
    .sort((a, b) => b.s - a.s)
  tops.push({ q, ids: ranked.slice(0, K).map((x) => x.id), top1: ranked[0].id, top1s: ranked[0].s, top10s: ranked[K - 1].s })
}

console.log(`=== 各查询的向量 top-${K} 第一名 ===`)
for (const t of tops) {
  console.log(`  [${t.top1s.toFixed(3)}~${t.top10s.toFixed(3)}] ${t.q.slice(0, 22).padEnd(24)} → ${t.top1.slice(0, 8)} "${(byId.get(t.top1) ?? '').slice(0, 46).replace(/\n/g, ' ')}"`)
}

// 两两 Jaccard
let sum = 0
let pairs = 0
let maxJ = 0
for (let i = 0; i < tops.length; i++) {
  for (let j = i + 1; j < tops.length; j++) {
    const a = new Set(tops[i].ids)
    const b = new Set(tops[j].ids)
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    const jac = inter / (a.size + b.size - inter)
    sum += jac
    pairs++
    if (jac > maxJ) maxJ = jac
  }
}
console.log(`\n两两 Jaccard 平均 = ${(sum / pairs).toFixed(3)}  最大 = ${maxJ.toFixed(3)}  （${pairs} 对）`)

// 全部查询的 top-K 并集有多大？并集小 = 反复返回同一批
const union = new Set(tops.flatMap((t) => t.ids))
console.log(`top-${K} 并集大小 = ${union.size} / 最多可能 ${tops.length * K}`)
console.log(`  → ${union.size < tops.length * K * 0.5 ? '**并集偏小，排名高度重叠**' : '并集正常，排名随查询变化'}`)

// 得分区间：挤成一团说明余弦没有区分度
const allScores = tops.map((t) => t.top1s)
console.log(`\ntop-1 余弦：min=${Math.min(...allScores).toFixed(3)} max=${Math.max(...allScores).toFixed(3)}`)
db.close()
