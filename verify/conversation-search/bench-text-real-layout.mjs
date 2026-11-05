/**
 * 真实布局下的对照：给 messages 加 text 列之后，扫 text 到底快多少。
 *
 * 前一版 bench-text-column.mjs 用的临时表**只有 text**，而真实表的行里还躺着
 * content_json（单行可达 1MB，走溢出页）。行首与 text 仍在同一页，所以「只扫 text」
 * 能跳过的是 content_json 的**溢出页**——这部分是不是主要成本，必须按真实布局量。
 *
 * 用法：node verify/conversation-search/bench-text-real-layout.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const srcPath = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const tmp = path.join(os.tmpdir(), 'lumii-text-real.db')
fs.rmSync(tmp, { force: true })

function visibleText(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return ''
  }
  if (!parsed || typeof parsed !== 'object') return ''
  if (parsed.type === 'text') return String(parsed.text ?? '').trim()
  if (parsed.type === 'assistant_parts') {
    return (parsed.parts ?? [])
      .filter((p) => p && p.type === 'text')
      .map((p) => String(p.text ?? '').trim())
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

const src = new DatabaseSync(srcPath, { readOnly: true })
const dst = new DatabaseSync(tmp)
// 与真实表同列（含 content_json），只是去掉外键
dst.exec(`CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  agent_id TEXT,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  text TEXT,
  timestamp TEXT NOT NULL,
  is_streaming INTEGER NOT NULL DEFAULT 0
)`)

const rows = src.prepare('SELECT id, conversation_id, agent_id, role, content_json, timestamp FROM messages').all()
let t = Date.now()
dst.exec('BEGIN')
const ins = dst.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
for (const r of rows) {
  ins.run(r.id, r.conversation_id, r.agent_id, r.role, r.content_json, null, r.timestamp)
}
dst.exec('COMMIT')
console.log(`导入 ${rows.length} 行（真实布局）：${Date.now() - t}ms`)

t = Date.now()
dst.exec('BEGIN')
const upd = dst.prepare('UPDATE messages SET text = ? WHERE id = ?')
for (const r of rows) upd.run(visibleText(r.content_json).replace(/\s+/g, ' ').trim(), r.id)
dst.exec('COMMIT')
console.log(`回填 text：${Date.now() - t}ms`)

// VACUUM 后再量：真实库也做过整理，页面布局接近
dst.exec('PRAGMA wal_checkpoint(TRUNCATE)')
console.log(`临时库体积：${(fs.statSync(tmp).size / 1024 / 1024).toFixed(0)}MB`)

const byText = dst.prepare(
  `SELECT id FROM messages WHERE text LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT 60`,
)
const byJson = dst.prepare(
  `SELECT id FROM messages WHERE content_json LIKE ? ESCAPE '\\' ORDER BY timestamp DESC LIMIT 60`,
)
// 回填期的兜底写法：新行有 text，老行是 NULL，两路都要覆盖
const byEither = dst.prepare(
  `SELECT id FROM messages
    WHERE text LIKE ? ESCAPE '\\'
       OR (text IS NULL AND content_json LIKE ? ESCAPE '\\')
    ORDER BY timestamp DESC LIMIT 60`,
)

function bench(label, fn, n = 7) {
  const times = []
  let hits = 0
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint()
    hits = fn().length
    times.push(Number(process.hrtime.bigint() - s) / 1e6)
  }
  times.sort((a, b) => a - b)
  console.log(
    label.padEnd(26),
    `med ${times[Math.floor(n / 2)].toFixed(1)}ms`.padEnd(14),
    `(命中 ${hits})`,
  )
}

for (const kw of ['微信', 'B站', '精灵图', 'xzqw', '一']) {
  const p = `%${kw}%`
  console.log(`\n关键词「${kw}」`)
  bench('  扫 content_json（旧）', () => byJson.all(p))
  bench('  扫 text（新）', () => byText.all(p))
  bench('  text + NULL 兜底', () => byEither.all(p, p))
}

dst.close()
src.close()
fs.rmSync(tmp, { force: true })
