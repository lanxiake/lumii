/**
 * 会话列表预览查询的**扩展性**验证。
 *
 * 动机：09-20 把窗口函数换成相关子查询后，只在**当前规模**（686 会话 / 2530 消息 /
 * 39MB）上验证过 144ms。但相关子查询是 **O(会话数)** —— 会话涨上去还成立吗？
 * 这是那次修复没有回答的问题，本脚本补上。
 *
 * 另测两件事：
 *   ① 占位符上限（`conversation_id IN (?,?,...)`）——当前 686 个，能撑到多少？
 *   ② 新旧两种写法在各规模下的耗时曲线
 *
 * 在 C:/tmp 下的临时库上跑，不碰用户数据。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const DB_PATH = 'C:/tmp/probe-scale-synthetic.db'
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try { fs.unlinkSync(f) } catch {}
}

const db = new DatabaseSync(DB_PATH)
db.exec(`
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    is_proactive INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    is_streaming INTEGER NOT NULL DEFAULT 0,
    compacted_at TEXT
  );
  CREATE INDEX idx_messages_conversation_ts ON messages (conversation_id, timestamp ASC);
`)

const ms = (a, b) => Number(b - a) / 1e6
const f = (n) => n.toFixed(1)

/** 造一条与真实体量相当的 content_json（约 15KB，真实库均值 39MB/2530 ≈ 15.4KB） */
function bigContent(i) {
  return JSON.stringify({
    type: 'assistant_parts',
    parts: [
      { type: 'text', text: `消息 ${i} ` + '内容占位。'.repeat(1200) },
      { type: 'tool', name: 'file_read', result: 'x'.repeat(2000) },
    ],
  })
}

const MSGS_PER_CONV = 4 // 真实库 2530/686 ≈ 3.7

function seed(convCount) {
  db.exec('DELETE FROM messages')
  const ins = db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
     VALUES (?, ?, ?, ?, ?, 0)`,
  )
  db.exec('BEGIN')
  for (let c = 0; c < convCount; c++) {
    const cid = `conv-${c}`
    for (let m = 0; m < MSGS_PER_CONV; m++) {
      ins.run(
        `${cid}-${m}`,
        cid,
        m % 2 === 0 ? 'user' : 'assistant',
        bigContent(c * MSGS_PER_CONV + m),
        new Date(Date.UTC(2026, 5, 30, 10, 0, m)).toISOString(),
      )
    }
  }
  db.exec('COMMIT')
}

const SQL_NEW = (ph) => `
  SELECT m.conversation_id, m.role, m.content_json, m.timestamp
  FROM messages m
  WHERE m.is_streaming = 0 AND m.conversation_id IN (${ph})
    AND m.id IN (
      SELECT m2.id FROM messages m2
      WHERE m2.conversation_id = m.conversation_id AND m2.is_streaming = 0
      ORDER BY m2.timestamp DESC LIMIT ?
    )
  ORDER BY m.conversation_id, m.timestamp ASC`

const SQL_OLD = (ph) => `
  WITH ranked AS (
    SELECT conversation_id, role, content_json, timestamp,
           ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY timestamp DESC) AS rn
    FROM messages WHERE conversation_id IN (${ph}) AND is_streaming = 0
  )
  SELECT conversation_id, role, content_json, timestamp FROM ranked
  WHERE rn <= ? ORDER BY conversation_id, timestamp ASC`

console.log('规模        行数     载荷     新写法(相关子查询)   旧写法(窗口函数)')
console.log('─'.repeat(76))

for (const convCount of [100, 686, 1500, 3000]) {
  seed(convCount)
  const ids = Array.from({ length: convCount }, (_, i) => `conv-${i}`)
  const ph = ids.map(() => '?').join(',')

  let rows = 0
  let bytes = 0
  for (let i = 0; i < 2; i++) {
    const r = db.prepare(SQL_NEW(ph)).all(...ids, 20)
    if (i === 0) {
      rows = r.length
      bytes = r.reduce((a, x) => a + x.content_json.length, 0)
    }
  }

  const timeIt = (sql, runs) => {
    let best = Infinity
    for (let i = 0; i < runs; i++) {
      const t0 = process.hrtime.bigint()
      db.prepare(sql).all(...ids, 20)
      const t1 = process.hrtime.bigint()
      best = Math.min(best, ms(t0, t1))
    }
    return best
  }

  const tNew = timeIt(SQL_NEW(ph), 3)
  // 旧写法在大规模上很慢，只跑 1 次
  const tOld = timeIt(SQL_OLD(ph), convCount > 1500 ? 1 : 2)

  console.log(
    `${String(convCount).padStart(5)} 会话  ${String(rows).padStart(6)}  ${(bytes / 1048576).toFixed(0).padStart(4)}MB  ` +
      `${f(tNew).padStart(10)}ms ${(tOld / tNew).toFixed(1).padStart(8)}×  ${f(tOld).padStart(10)}ms`,
  )
}

// ── 占位符上限 ────────────────────────────────────────────────────────────
console.log('\n=== 占位符上限（conversation_id IN (?,?,...)）===')
const version = db.prepare('SELECT sqlite_version() v').get().v
console.log('SQLite 版本:', version)
for (const n of [1000, 5000, 20000, 40000, 100000]) {
  const ids = Array.from({ length: n }, (_, i) => `conv-${i}`)
  const ph = ids.map(() => '?').join(',')
  try {
    db.prepare(`SELECT 1 FROM messages WHERE conversation_id IN (${ph}) LIMIT 1`).all(...ids)
    console.log(`  ${String(n).padStart(6)} 个占位符: 通过`)
  } catch (e) {
    console.log(`  ${String(n).padStart(6)} 个占位符: 失败 —— ${e.message}`)
    break
  }
}

db.close()
for (const f2 of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try { fs.unlinkSync(f2) } catch {}
}
