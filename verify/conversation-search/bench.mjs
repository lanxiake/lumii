/**
 * 会话正文搜索的性能基线（2026-11-05 用户报「输入关键字很卡」）。
 *
 * 只读跑在真实库上，量三件事：
 *   1. 会话级查询（conversation:search）与逐条查询（conversation:search-hits）
 *      各自的耗时——两者是**并行发的**，卡顿看的是它们的主进程阻塞时间；
 *   2. LIKE 扫描与「取 60 行完整 content_json」各占多少（后者是纯浪费：只要片段）；
 *   3. 中文两字查询与零命中查询的差异。
 *
 * 用法：node verify/screen-record/../../verify/conversation-search/bench.mjs
 * 注意：只读打开真实库，不写。
 */
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'

const dbPath = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const db = new DatabaseSync(dbPath, { readOnly: true })

function bench(label, fn, n = 7) {
  const times = []
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint()
    fn()
    times.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  times.sort((a, b) => a - b)
  console.log(
    label.padEnd(42),
    `min ${times[0].toFixed(1)}ms  med ${times[Math.floor(n / 2)].toFixed(1)}ms  max ${times[n - 1].toFixed(1)}ms`,
  )
}

const total = db.prepare('SELECT COUNT(*) c, SUM(LENGTH(content_json)) b FROM messages').get()
console.log(`库：${dbPath}`)
console.log(`messages ${total.c} 行 / ${(Number(total.b) / 1e6).toFixed(1)}M 字符\n`)

// 只取 id：纯扫描成本
const idsOnly = db.prepare(
  `SELECT id FROM messages WHERE content_json LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT 60`,
)
// 取完整正文：扫描 + 把 160M 里的命中行整个搬进 JS
const withContent = db.prepare(
  `SELECT id, conversation_id, role, timestamp, content_json
     FROM messages WHERE content_json LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT 60`,
)

for (const kw of ['微信', 'B站', '精灵图', 'xzqw', '一']) {
  const pattern = `%${kw}%`
  const hits = idsOnly.all(pattern).length
  console.log(`关键词「${kw}」（前 60 条里 ${hits} 行）`)
  bench('  只取 id（扫描成本）', () => idsOnly.all(pattern))
  bench('  取完整 content_json', () => withContent.all(pattern))
}

console.log('\n参照：一次全表 COUNT')
bench('  COUNT(*) ', () => db.prepare('SELECT COUNT(*) FROM messages').get())
