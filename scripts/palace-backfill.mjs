/**
 * 记忆宫殿存量回填（P2-3 · 实施计划 T4）
 *
 * 把 `memory_segments` 里已总结的段原文补进自建宫殿（`palace_drawers`），并回填
 * `memory_segments.palace_drawer_id` 与 `agent_memories.palace_drawer_id`。
 *
 * 背景：宫殿原由 MemPalace（Python）承载，覆盖率实测 4/171 = 2.3%——存量段基本都没归档。
 * 换自建后端后，新段走正常链路，存量段靠本脚本补。
 *
 * 三处刻意的不做：
 * 1. **不写 `palace_drawers_fts`**：分词器在 TS 侧（`tokenizeBigram`），脚本里复制一份
 *    必然与线上漂移（漂移了就是「索引里的词和查询的词对不上，检索永远零命中」这种
 *    最难查的故障）。主表写完由应用启动时的健康检查自动重建索引（bridge.ts，与
 *    `agent_memories_fts` 的老库补齐同一条路径）。
 * 2. **不覆盖已存在的行**：`ON CONFLICT DO NOTHING`。重跑幂等，也不会把用户删掉的
 *    drawer 复活（墓碑优先，与云同步合并同一原则）。
 * 3. **不猜 wing**：用 runtime 的默认规则 `${agentId}:${userId}`（`segment-memory-pipeline`
 *    的 palaceWing 缺省值），与线上归档算出的 drawer_id 保持一致——不一致会让同一段
 *    在库里出现两个 id，`memory_segments.palace_drawer_id` 指哪个都说得通，反而更难查。
 *
 * 用法：
 *   node scripts/palace-backfill.mjs                    # dry-run：只报数，不写
 *   node scripts/palace-backfill.mjs --apply            # 执行
 *   node scripts/palace-backfill.mjs --min-chars 200    # 只回填更长的段
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DB_PATH =
  process.env.LUMII_DB_PATH ?? path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const minChars = argv.includes('--min-chars') ? Number(argv[argv.indexOf('--min-chars') + 1]) : 50

/** 与 packages/agent-runtime/src/memory/content-address.ts 的 deterministicDrawerId 同构 */
function deterministicDrawerId(wing, room, content) {
  return createHash('sha256')
    .update([wing, room, content].join('\0'), 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/**
 * 与 ConversationRepo.loadSegmentText 同构（含 2026-09-17 的助手正文修复）：
 * 助手消息落库是 `assistant_parts`，只认扁平 `text` 会把助手回复全漏掉。
 */
function extractMessageText(raw) {
  try {
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return ''
    if (Array.isArray(o.parts)) {
      return o.parts
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join('\n')
        .trim()
    }
    if (typeof o.text === 'string') return o.text.trim()
    return ''
  } catch {
    return ''
  }
}

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA busy_timeout=5000')

const segments = db
  .prepare(
    `SELECT id, conversation_id, agent_id, user_id, start_message_id, end_message_id,
            char_count, created_at, palace_drawer_id
       FROM memory_segments
      WHERE char_count >= ?
      ORDER BY created_at ASC`,
  )
  .all(Math.max(0, Number.isFinite(minChars) ? minChars : 50))

const boundStmt = db.prepare(
  'SELECT id, timestamp FROM messages WHERE id = ? AND conversation_id = ?',
)
const rowsStmt = db.prepare(
  `SELECT role, content_json, timestamp FROM messages
    WHERE conversation_id = ? AND role IN ('user', 'assistant') AND is_streaming = 0
      AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC`,
)
const existsStmt = db.prepare('SELECT drawer_id FROM palace_drawers WHERE drawer_id = ?')
const insertStmt = db.prepare(
  `INSERT INTO palace_drawers
     (drawer_id, agent_id, user_id, conversation_id, segment_id, wing, room,
      content, char_count, created_at, deleted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
   ON CONFLICT(drawer_id) DO NOTHING`,
)
const setSegStmt = db.prepare('UPDATE memory_segments SET palace_drawer_id = ? WHERE id = ?')
const setMemStmt = db.prepare(
  'UPDATE agent_memories SET palace_drawer_id = ? WHERE source_segment_id = ?',
)

/** 逐段算好将要做的事，先全量算完再决定写不写（dry-run 与 apply 走同一条计算路径） */
const planned = []
const skipped = { noStart: 0, emptyText: 0, alreadyArchived: 0 }

for (const seg of segments) {
  const start = boundStmt.get(seg.start_message_id, seg.conversation_id)
  if (!start) {
    skipped.noStart++
    continue
  }
  const end = boundStmt.get(seg.end_message_id ?? seg.start_message_id, seg.conversation_id)
  const [lo, hi] =
    start.timestamp <= (end?.timestamp ?? start.timestamp)
      ? [start.timestamp, end?.timestamp ?? start.timestamp]
      : [end?.timestamp ?? start.timestamp, start.timestamp]

  const lines = []
  for (const row of rowsStmt.all(seg.conversation_id, lo, hi)) {
    const text = extractMessageText(row.content_json)
    if (text) lines.push(`${row.role}: ${text}`)
  }
  const content = lines.join('\n')
  if (!content.trim()) {
    skipped.emptyText++
    continue
  }

  const wing = `${seg.agent_id}:${seg.user_id}`
  const room = String(seg.created_at).slice(0, 10)
  const drawerId = deterministicDrawerId(wing, room, content)
  planned.push({ seg, content, wing, room, drawerId })
}

const toInsert = []
let alreadyInPalace = 0
for (const p of planned) {
  if (existsStmt.get(p.drawerId)) {
    alreadyInPalace++
    if (!p.seg.palace_drawer_id) toInsert.push(p) // 行已在，只差回填 id
  } else {
    toInsert.push(p)
  }
}

const memCount = (segId) =>
  db.prepare('SELECT COUNT(*) AS c FROM agent_memories WHERE source_segment_id = ?').get(segId).c

console.log(`库: ${DB_PATH}`)
console.log(`模式: ${apply ? 'APPLY（会写库）' : 'DRY-RUN（只报数）'}   门槛: char_count >= ${minChars}`)
console.log('')
console.log(`候选段: ${segments.length}`)
console.log(`  跳过·起点消息不存在: ${skipped.noStart}`)
console.log(`  跳过·原文为空:       ${skipped.emptyText}`)
console.log(`可归档段: ${planned.length}   其中原文已在宫殿: ${alreadyInPalace}`)
console.log(`需要写入/回填: ${toInsert.length}`)
console.log(
  `  待写主表行: ${toInsert.filter((p) => !existsStmt.get(p.drawerId)).length}` +
    `   仅差回填 id: ${toInsert.filter((p) => existsStmt.get(p.drawerId)).length}`,
)
console.log('')
console.log('样例（前 3 条）:')
for (const p of planned.slice(0, 3)) {
  console.log(
    `  段 ${p.seg.id.slice(0, 8)}  wing=${p.wing}  room=${p.room}  ` +
      `drawer=${p.drawerId}  ${p.content.length} 字符  记忆 ${memCount(p.seg.id)} 条`,
  )
  console.log(`    正文开头: ${p.content.slice(0, 60).replace(/\s+/g, ' ')}`)
}

if (!apply) {
  console.log('')
  console.log('（dry-run 结束。加 --apply 才会写库；索引由应用下次启动自动重建）')
  db.close()
  process.exit(0)
}

// 写前留痕：把将被改动的 id 落盘，便于回退核对
const backupDir = path.join(path.dirname(DB_PATH), 'backups')
fs.mkdirSync(backupDir, { recursive: true })
const backupFile = path.join(
  backupDir,
  `palace-backfill-${new Date().toISOString().slice(0, 10)}-${Date.now()}.json`,
)
fs.writeFileSync(
  backupFile,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      dbPath: DB_PATH,
      entries: toInsert.map((p) => ({
        segmentId: p.seg.id,
        conversationId: p.seg.conversation_id,
        wing: p.wing,
        room: p.room,
        drawerId: p.drawerId,
        charCount: p.content.length,
        previousDrawerId: p.seg.palace_drawer_id ?? null,
        memoryIds: db
          .prepare('SELECT id FROM agent_memories WHERE source_segment_id = ?')
          .all(p.seg.id)
          .map((r) => r.id),
      })),
    },
    null,
    2,
  ),
  'utf8',
)

let inserted = 0
let idsWritten = 0
let memoryIdsWritten = 0
db.exec('BEGIN')
try {
  for (const p of toInsert) {
    if (!existsStmt.get(p.drawerId)) {
      insertStmt.run(
        p.drawerId,
        p.seg.agent_id,
        p.seg.user_id,
        p.seg.conversation_id,
        p.seg.id,
        p.wing,
        p.room,
        p.content,
        p.content.length,
        p.seg.created_at,
      )
      inserted++
    }
    if (!p.seg.palace_drawer_id) {
      setSegStmt.run(p.drawerId, p.seg.id)
      idsWritten++
    }
    memoryIdsWritten += setMemStmt.run(p.drawerId, p.seg.id).changes
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('写入失败，已回滚：', err)
  db.close()
  process.exit(1)
}

console.log('')
console.log(`已写入主表 ${inserted} 行；回填段 id ${idsWritten} 条、记忆 id ${memoryIdsWritten} 条`)
console.log(`改动清单已存: ${backupFile}`)

const coverage = db
  .prepare(
    `SELECT COUNT(*) AS total,
            SUM(palace_drawer_id IS NOT NULL) AS withId
       FROM memory_segments WHERE char_count >= ?`,
  )
  .get(Math.max(0, minChars))
const indexed = existsStmt ? db.prepare('SELECT COUNT(*) AS c FROM palace_drawers_fts').get().c : 0
console.log(
  `覆盖率: ${coverage.withId}/${coverage.total} = ${((100 * coverage.withId) / coverage.total).toFixed(1)}%` +
    `（宫殿表 ${db.prepare('SELECT COUNT(*) AS c FROM palace_drawers').get().c} 行，索引 ${indexed} 行）`,
)
console.log('索引将在应用下次启动时自动重建（palace_drawers_fts 与主表条数不一致会触发）。')

db.close()
