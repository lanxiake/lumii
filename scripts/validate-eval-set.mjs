#!/usr/bin/env node
/**
 * 评测集健康检查 —— 在跑任何算法之前先证明评测集本身没病
 *
 * 检查 v6 犯过的每一种错（见 docs/test/memory-eval/2026-09-19-...md §1）：
 *
 * | 检查项 | v6 的表现 | 合格线 |
 * |---|---|---|
 * | gold 是否存在且未删 | — | 100% |
 * | query 是否原样出现在 gold 里（判据泄漏） | 5/31 | **0%** |
 * | gold 之外是否有文档也含 query 原句（旧判据的病根） | 14/31 多命中 | 不适用（本集判据落 id） |
 * | query 与 gold 的 bigram 重叠（抄写程度） | 8 条 =1.0 | 应显著低于 1 |
 * | 时间泄漏（gold 晚于提问） | 8/31 | 0（本集无时间维度） |
 * | 回忆型占比 | 19% | 应 ≈100% |
 *
 * 用法：node scripts/validate-eval-set.mjs [--set <path>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const SET = argv.includes('--set')
  ? argv[argv.indexOf('--set') + 1]
  : 'docs/test/memory-eval/palace-eval-set-v7-seed.json'

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
const docs = db.prepare('SELECT drawer_id id, content, char_count n FROM palace_drawers WHERE deleted_at IS NULL').all()
const byId = new Map(docs.map((d) => [d.id, d]))

const set = JSON.parse(fs.readFileSync(SET, 'utf8'))
const qs = set.queries
console.log(`评测集 ${SET}\n条数 ${qs.length}，语料 ${docs.length} 条\n`)

let missingGold = 0, leak = 0, multiGold = 0
const overlaps = []
const problems = []

for (const q of qs) {
  const golds = q.golds ?? [q.gold]
  for (const g of golds) {
    if (!byId.has(g)) {
      missingGold++
      problems.push(`${q.id}: gold ${g} 不存在或已删`)
    }
  }
  // 判据泄漏：query 原样出现在任一 gold 里
  const leaked = golds.some((g) => byId.get(g)?.content.includes(q.query))
  if (leaked) {
    leak++
    problems.push(`${q.id}: **判据泄漏** query 原样出现在 gold 中`)
  }
  // 抄写程度：query 与 gold 的 bigram 覆盖率
  const qt = tok(q.query)
  let best = 0
  for (const g of golds) {
    const dt = tok(byId.get(g)?.content ?? '')
    let inter = 0
    for (const t of qt) if (dt.has(t)) inter++
    best = Math.max(best, qt.size ? inter / qt.size : 0)
  }
  overlaps.push({ id: q.id, ov: best, intent: q.intent })
  if (golds.length > 1) multiGold++
}

const avg = overlaps.reduce((a, o) => a + o.ov, 0) / overlaps.length
const sorted = [...overlaps].sort((a, b) => b.ov - a.ov)

console.log('═══ 健康检查 ═══')
console.log(`  gold 缺失/已删        : ${missingGold}  ${missingGold === 0 ? '✅' : '❌'}`)
console.log(`  判据泄漏（query 在 gold 原文里）: ${leak}/${qs.length}  ${leak === 0 ? '✅' : '❌'}`)
console.log(`  多 gold 样本          : ${multiGold}`)
console.log(`  query↔gold bigram 重叠: 均值 ${avg.toFixed(3)}  最大 ${sorted[0].ov.toFixed(3)}  最小 ${sorted[sorted.length - 1].ov.toFixed(3)}`)
console.log(`    （v6 有 8 条 =1.000，即完全抄写；本集应显著更低）`)

const byIntent = {}
for (const o of overlaps) (byIntent[o.intent ?? '?'] ??= []).push(o.ov)
console.log('\n  按 intent 分层的重叠（验证分层标注是否自洽）：')
for (const [k, v] of Object.entries(byIntent)) {
  const m = v.reduce((a, b) => a + b, 0) / v.length
  console.log(`    ${k.padEnd(11)} n=${String(v.length).padStart(2)}  平均重叠 ${m.toFixed(3)}`)
}

console.log('\n  重叠最高的 5 条（重叠高 = 偏向字面命中，不代表错，但不该全是这种）：')
for (const o of sorted.slice(0, 5)) {
  const q = qs.find((x) => x.id === o.id)
  console.log(`    ${o.ov.toFixed(3)} [${o.intent}] ${q.query.slice(0, 40)}`)
}

if (problems.length) {
  console.log('\n❌ 发现问题：')
  for (const p of problems) console.log('  ' + p)
  process.exitCode = 1
} else {
  console.log('\n✅ 无致命问题（gold 齐全、零判据泄漏）')
}
db.close()
