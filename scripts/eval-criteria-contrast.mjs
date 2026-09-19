#!/usr/bin/env node
/**
 * 判据对照 —— 证明 v6 评测集的跑分测的不是检索
 *
 * ## 缺陷
 *
 * v6 每条样本的 `expect` **就是 query 本身**（31/31 相同），而跑分脚本判定
 * "命中"用的是 `全库任一抽屉.content.includes(expect)`，不是"命中标注的 gold"。
 * 于是撞上任何一条含该句子的抽屉就算满分。
 *
 * ## 本脚本做的事
 *
 * 同一套 FTS、同一批查询，只把判据换成 `id === q.gold`，对比两个 R@1。
 * 实测 **19/31 vs 3/31**，且逐条可见判据在反向打分（子串=#1 而真 gold=MISS）。
 *
 * ## 坑（我自己踩过，留给下一个人）
 *
 * SQL 写 `LIMIT 30` 字面量却 `.all(m, 30)` 传两个参数 → SQLite 抛
 * "column index out of range"，被 `catch { return [] }` 吞掉 → 全部 MISS，
 * 看起来像"评测集彻底坏了"。必须用 `LIMIT ?` 绑定。
 *
 * 用法：node scripts/eval-criteria-contrast.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'))
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
function fts(q) {
  const ts = [...tok(q)]
  if (!ts.length) return []
  const m = ts.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
  const need = ts.length >= 2 ? 2 : 1
  let rows
  try {
    rows = db
      .prepare(
        `SELECT d.drawer_id id, palace_drawers_fts.content fc FROM palace_drawers_fts
         JOIN palace_drawers d ON d.rowid=palace_drawers_fts.rowid
         WHERE palace_drawers_fts MATCH ? AND d.deleted_at IS NULL
         ORDER BY bm25(palace_drawers_fts) LIMIT ?`,
      )
      .all(m, 30)
  } catch {
    return []
  }
  return rows
    .filter((r) => {
      let h = 0
      for (const t of ts) if (r.fc.includes(t)) h++
      return h >= need
    })
    .map((r) => r.id)
}

const j = JSON.parse(fs.readFileSync('docs/test/memory-eval/palace-eval-set-v6.json', 'utf8'))
const docs = db.prepare('SELECT drawer_id id,content FROM palace_drawers WHERE deleted_at IS NULL').all()
const byId = new Map(docs.map((d) => [d.id, d.content]))

let subR1 = 0, subR10 = 0, idR1 = 0, idR10 = 0, idMiss = 0
const rows = []
for (const q of j.queries) {
  const f = fts(q.query)
  const si = f.findIndex((id) => {
    const c = byId.get(id)
    return c && q.expect.some((e) => c.includes(e))
  })
  const ii = f.findIndex((id) => id === q.gold)
  if (si === 0) subR1++
  if (si >= 0 && si < 10) subR10++
  if (ii === 0) idR1++
  if (ii >= 0 && ii < 10) idR10++
  if (ii < 0) idMiss++
  rows.push({ id: q.id, sub: si < 0 ? 'MISS' : '#' + (si + 1), gold: ii < 0 ? 'MISS' : '#' + (ii + 1) })
}
const n = j.queries.length
console.log(`判据=子串(报告用的):     R@1=${subR1}/${n}  R@10=${subR10}/${n}`)
console.log(`判据=标注gold的drawer_id: R@1=${idR1}/${n}  R@10=${idR10}/${n}  完全漏=${idMiss}`)
console.log('\n逐条（子串命中 vs 真gold命中）：')
for (const r of rows) console.log(`  ${r.id.padEnd(22)} 子串=${r.sub.padEnd(6)} 真gold=${r.gold}`)
db.close()
