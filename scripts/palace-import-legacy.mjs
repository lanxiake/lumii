/**
 * 旧宫殿（MemPalace Python sqlite）存量导入（差异 #19 的收尾）
 *
 * 背景：P2-3 把宫殿换成本地 SQLite 时漏切了第四个写入点——index.ts 的
 * `onConversationEnd`（每轮助手回复直写 Python）。修复后新数据不再分裂，但**旧的
 * 234 条文档仍留在 `~/.lumii/memory/palace/sqlite_exact.sqlite3` 里**，而检索只读
 * 自建表 `palace_drawers`，那批内容永远搜不到。本脚本把它们搬过来。
 *
 * 四条刻意的不做：
 * 1. **不写 FTS 索引**：分词器在 TS 侧（`tokenizeBigram`），脚本里复制一份必然漂移。
 *    主表写完由应用启动时的健康检查自动重建（bridge.ts，与 `palace-backfill.mjs` 同路径）。
 * 2. **不覆盖已存在的行**：`ON CONFLICT(drawer_id) DO NOTHING`。重跑幂等；也不会把
 *    用户删掉的 drawer 复活（墓碑优先，与云存储合并同一原则）。
 * 3. **不逐条搬**：旧宫殿给超长内容切过 chunk（`chunk_index` / `parent_drawer_id`），
 *    按父 id 拼回一条再入库。逐条搬会把一条回复拆成互不相干的几行，检索时半句话命中、
 *    读回时只剩半截。
 * 4. **不猜归属**：agent_id 由 room 反查会话后、取该会话最后一条带 agent_id 的消息；
 *    查不到就记 `assistant`（主 Agent 是绝大多数）。user_id 恒为 `local-user`
 *    （conversations 表里全部 334 个会话都是这个值）。
 *
 * 用法：
 *   node scripts/palace-import-legacy.mjs                    # dry-run：只报数，不写
 *   node scripts/palace-import-legacy.mjs --apply            # 执行
 *   node scripts/palace-import-legacy.mjs --min-chars 100    # 只导入更长的内容
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DB_PATH =
  process.env.LUMII_DB_PATH ?? path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const LEGACY_PATH =
  process.env.LUMII_LEGACY_PALACE ?? path.join(os.homedir(), '.lumii', 'memory', 'palace', 'sqlite_exact.sqlite3')

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

if (!fs.existsSync(LEGACY_PATH)) {
  console.error(`旧宫殿不存在，无需导入: ${LEGACY_PATH}`)
  process.exit(0)
}

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA busy_timeout=5000')
const legacy = new DatabaseSync(LEGACY_PATH, { readOnly: true })

// ── 1. 读旧宫殿，按父 id 拼回 chunk ────────────────────────────────────────
const raw = legacy.prepare('SELECT id, document, metadata_json, created_at FROM documents').all()
const groups = new Map()
let badMeta = 0
for (const d of raw) {
  let m = null
  try {
    m = JSON.parse(d.metadata_json)
  } catch {
    badMeta++
    continue
  }
  if (!m || typeof m !== 'object') {
    badMeta++
    continue
  }
  const room = typeof m.room === 'string' ? m.room : ''
  if (!room) {
    badMeta++
    continue
  }
  // 父 id：旧宫殿给 chunks>1 的内容统一写了 parent_drawer_id；单 chunk 没有，用自身 id
  const parent = typeof m.parent_drawer_id === 'string' && m.parent_drawer_id ? m.parent_drawer_id : d.id
  const key = `${m.wing ?? 'conversations'}\0${room}\0${parent}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push({ chunk: Number(m.chunk_index ?? 0), text: String(d.document ?? ''), createdAt: d.created_at })
}

const records = []
const dropped = { empty: 0, belowMin: 0 }
const gapWarnings = []
for (const [key, parts] of groups) {
  const [wing, room] = key.split('\0')
  parts.sort((a, b) => a.chunk - b.chunk)
  const content = parts.map((p) => p.text).join('').trim()
  if (!content) {
    dropped.empty++
    continue
  }
  if (content.length < Math.max(0, Number.isFinite(minChars) ? minChars : 50)) {
    dropped.belowMin++
    continue
  }
  // 缺块检测：旧宫殿给超长内容切块，若只导出了部分块，拼出来就是**静默的半句话**——
  // 检索时半句命中、读回时半截，比没有更难查。宁可报出来让人决定要不要导。
  const idx = parts.map((p) => Number.isFinite(p.chunk) ? p.chunk : 0)
  if (idx.length > 1 && (Math.min(...idx) !== 0 || Math.max(...idx) !== idx.length - 1)) {
    gapWarnings.push({ room, have: idx.length, max: Math.max(...idx) })
  }
  // 归档时间取该组最早的一条：它是这段内容第一次被写进宫殿的时刻
  const createdAt = parts.map((p) => p.createdAt).filter(Boolean).sort()[0] ?? new Date().toISOString()
  records.push({ wing, room, content, createdAt, chunks: parts.length })
}

// ── 2. room → conversationId ─────────────────────────────────────────────
// 旧宫殿把会话 id 里的 : . @ 换成了 _（Python 侧文件名安全化）。导入时**反查回原样 id**，
// 并用原样 id 作为 `room`——坐标必须与线上新写入一致，否则同一句话会出现两个 drawer_id。
//
// 2026-09-18 踩到的坑：第一版保留变形 room（想"忠实旧坐标"），结果与消息回填
// （`palace-backfill-messages.mjs`，用原样 conversation_id）撞车——86 组同内容双行，
// 检索时每句命中两次。**保留旧坐标看似忠实，实际是让同一内容有两种身份**；旧库即将整体
// 废弃（一个版本周期后删 MemPalace），没有理由为它保持坐标。
//
// `conversation_id` 列本身不参与检索过滤（过滤走 `memory_segments` 的 drawer_id 白名单），
// 用途是溯源与运维排查。
const convRows = db.prepare('SELECT id FROM conversations').all()
const convSet = new Set(convRows.map((r) => r.id))
const normMap = new Map()
for (const r of convRows) normMap.set(r.id.replace(/[:.@]/g, '_'), r.id)

const resolveConvId = (room) => {
  if (convSet.has(room)) return room
  if (normMap.has(room)) return normMap.get(room)
  return null
}

/**
 * 会话归属的 Agent（与 palace-backend.ts 的 resolveConversationAgentId 同一条规则）。
 *
 * participants 存的是**实例 id**（main/default），而宫殿与工作记忆用**定义 id**
 * （assistant/code-dev）。照抄会把主会话全写成 'main' → memory_search 按定义 id 过滤时
 * 一条都搜不到。所以先做实例→定义映射，再退到 messages.agent_id，最后兜底 assistant。
 */
const INSTANCE_TO_DEFINITION = { main: 'assistant', default: 'assistant' }

const participantStmt = db.prepare(
  `SELECT participant_id FROM conversation_participants
    WHERE conversation_id = ? AND participant_type = 'agent' LIMIT 1`,
)
const msgAgentStmt = db.prepare(
  `SELECT agent_id FROM messages
    WHERE conversation_id = ? AND agent_id IS NOT NULL
    ORDER BY timestamp DESC LIMIT 1`,
)

const resolveAgentId = (conversationId) => {
  const p = participantStmt.get(conversationId)?.participant_id
  if (p) return INSTANCE_TO_DEFINITION[p] ?? p
  const m = msgAgentStmt.get(conversationId)?.agent_id
  if (m) return INSTANCE_TO_DEFINITION[m] ?? m
  return 'assistant'
}

const existsStmt = db.prepare('SELECT drawer_id FROM palace_drawers WHERE drawer_id = ?')

// ── 3. 算好每条要做的事（dry-run 与 apply 走同一条计算路径）──────────────
const planned = []
const stats = { noConv: 0, already: 0 }
for (const r of records) {
  const conversationId = resolveConvId(r.room)
  const agentId = conversationId ? resolveAgentId(conversationId) : 'assistant'
  if (!conversationId) stats.noConv++
  // room 必须用**原样** id（不是旧库的变形值）——坐标决定 drawer_id，与线上新写入
  // 逐字一致才能保证同一内容只有一种身份。旧库变形值只用于反查 conversationId。
  const room = conversationId ?? r.room
  const drawerId = deterministicDrawerId(r.wing, room, r.content)
  if (existsStmt.get(drawerId)) {
    stats.already++
    continue
  }
  planned.push({ ...r, room, conversationId, agentId, drawerId })
}

console.log(`自建库: ${DB_PATH}`)
console.log(`旧宫殿: ${LEGACY_PATH}`)
console.log(`模式: ${apply ? 'APPLY（会写库）' : 'DRY-RUN（只报数）'}   门槛: ${minChars} 字符`)
console.log('')
console.log(`旧宫殿文档: ${raw.length} 条 → 拼回 ${groups.size} 组（元数据无法解析 ${badMeta} 条）`)
// 三类分开报：门槛丢弃与「已存在」是不同的事，混在一起会让「待写入」看起来像全量
console.log(`  跳过·低于门槛（拼接后整组 < ${minChars}）: ${dropped.belowMin}`)
console.log(`  跳过·拼接后为空: ${dropped.empty}`)
console.log(`  可导入组: ${records.length}`)
console.log(`    已在自建宫殿（同 id）: ${stats.already}`)
console.log(`    会话已不存在（仅留 room 作溯源）: ${stats.noConv}`)
console.log(`待写入: ${planned.length}`)
if (gapWarnings.length > 0) {
  console.log('')
  console.log(`⚠ 缺块警告 ${gapWarnings.length} 组（chunk_index 不连续，拼接结果是半句话）：`)
  for (const g of gapWarnings.slice(0, 10)) {
    console.log(`   room=${g.room.slice(0, 40)} 有 ${g.have} 块、最大 index ${g.max}`)
  }
  console.log('   这批内容源头上就不完整，导入后也无法读全；先用 --min-chars 排掉或人工确认。')
}
console.log('')
console.log('样例（前 3 条）:')
for (const p of planned.slice(0, 3)) {
  console.log(
    `  wing=${p.wing}  room=${p.room.slice(0, 36)}  drawer=${p.drawerId}  ` +
      `${p.content.length} 字符（${p.chunks} chunk）  agent=${p.agentId}`,
  )
  console.log(`    正文开头: ${p.content.slice(0, 60).replace(/\s+/g, ' ')}`)
}

if (!apply) {
  console.log('')
  console.log('（dry-run 结束。加 --apply 才会写库；索引由应用下次启动自动重建）')
  db.close()
  legacy.close()
  process.exit(0)
}

// 写前留痕
const backupDir = path.join(path.dirname(DB_PATH), 'backups')
fs.mkdirSync(backupDir, { recursive: true })
const backupFile = path.join(
  backupDir,
  `palace-import-legacy-${new Date().toISOString().slice(0, 10)}-${Date.now()}.json`,
)
fs.writeFileSync(
  backupFile,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      dbPath: DB_PATH,
      legacyPath: LEGACY_PATH,
      entries: planned.map((p) => ({
        drawerId: p.drawerId,
        wing: p.wing,
        room: p.room,
        conversationId: p.conversationId,
        agentId: p.agentId,
        charCount: p.content.length,
        chunks: p.chunks,
      })),
    },
    null,
    2,
  ),
  'utf8',
)

const insertStmt = db.prepare(
  `INSERT INTO palace_drawers
     (drawer_id, agent_id, user_id, conversation_id, segment_id, wing, room,
      content, char_count, created_at, deleted_at)
   VALUES (?, ?, 'local-user', ?, NULL, ?, ?, ?, ?, ?, NULL)
   ON CONFLICT(drawer_id) DO NOTHING`,
)

let inserted = 0
db.exec('BEGIN')
try {
  for (const p of planned) {
    const res = insertStmt.run(
      p.drawerId,
      p.agentId,
      p.conversationId,
      p.wing,
      p.room,
      p.content,
      p.content.length,
      p.createdAt,
    )
    inserted += res.changes
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('写入失败，已回滚：', err)
  db.close()
  legacy.close()
  process.exit(1)
}

console.log('')
console.log(`已写入 ${inserted} 行；改动清单已存: ${backupFile}`)
const total = db.prepare('SELECT COUNT(*) AS c FROM palace_drawers WHERE deleted_at IS NULL').get().c
console.log(`宫殿现有活跃行: ${total}（索引将在应用下次启动时自动重建）`)

db.close()
legacy.close()
