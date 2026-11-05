/**
 * FTS5 trigram 能不能救「输入即卡」：在临时库上量建索引的开销与查询成本。
 *
 * 这是**候选方案的实测**，不是已采用的设计：只往 %TEMP% 写一个临时库，绝不碰真库。
 *
 * 用法：node verify/conversation-search/bench-trigram.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const srcPath = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const tmp = path.join(os.tmpdir(), 'lumii-trigram-bench.db')
fs.rmSync(tmp, { force: true })

const src = new DatabaseSync(srcPath, { readOnly: true })
const dst = new DatabaseSync(tmp)
dst.exec('CREATE TABLE m(id TEXT PRIMARY KEY, content_json TEXT)')

const rows = src.prepare('SELECT id, content_json FROM messages').all()
let t = Date.now()
dst.exec('BEGIN')
const ins = dst.prepare('INSERT INTO m(id, content_json) VALUES (?, ?)')
for (const r of rows) ins.run(r.id, r.content_json)
dst.exec('COMMIT')
console.log(`导入 ${rows.length} 行：${Date.now() - t}ms`)

t = Date.now()
dst.exec(
  "CREATE VIRTUAL TABLE ft USING fts5(content_json, content='m', content_rowid='rowid', tokenize='trigram')",
)
// 外部内容表建完是空的，必须显式 rebuild 才会去读 m
dst.exec("INSERT INTO ft(ft) VALUES('rebuild')")
const buildMs = Date.now() - t
console.log(`建 trigram 外部内容索引（含 rebuild）：${buildMs}ms`)

const dbSize = fs.statSync(tmp).size
console.log(`临时库体积：${(dbSize / 1024 / 1024).toFixed(0)}MB（原库消息体 160M 字符）`)

const q = dst.prepare(`SELECT rowid FROM ft WHERE ft MATCH ? LIMIT 60`)
for (const kw of ['微信', 'B站', '精灵图', 'xzqw', '一']) {
  const n = 7
  const times = []
  let hits = 0
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint()
    hits = q.all(`"${kw}"`).length
    times.push(Number(process.hrtime.bigint() - s) / 1e6)
  }
  times.sort((a, b) => a - b)
  console.log(
    `「${kw}」`.padEnd(8),
    `med ${times[Math.floor(n / 2)].toFixed(1)}ms`,
    `(前 60 条命中 ${hits} 行)`,
  )
}

// 单字查询：trigram 要求 ≥3 字符，两字靠 phrase 查询也不行 —— 量一下到底报什么
try {
  console.log('单字「微」：', dst.prepare(`SELECT rowid FROM ft WHERE ft MATCH ? LIMIT 1`).all('"微"').length, '行')
} catch (e) {
  console.log('单字「微」查询失败：', e.message)
}

dst.close()
src.close()
fs.rmSync(tmp, { force: true })
