/**
 * 助手消息存量回填（每轮归档的历史缺口）
 *
 * 背景：`onConversationEnd` 这条路径本该把**每轮助手回复**归档进宫殿
 * （`wing='conversations'`、`room=会话 id`），但 2026-09-18 实测：
 * 932 条助手消息里只有 29 条按内容寻址能对上——历史缺口 835 条 / 63.4 万字符。
 *
 * 为什么不用旧宫殿的搬家脚本：那是 234 条**只存在于 Python 库**的内容；本脚本补的是
 * 另一批——agent-runtime.db 里**有消息、但没被归档**的内容。两者来源不同、坐标也不同
 * （旧宫殿搬家保留了 Python 侧的坐标变形，本脚本用线上每轮归档的原样坐标）。
 *
 * 四条刻意的不做（与 palace-backfill.mjs 同一套纪律）：
 * 1. **不写 FTS 索引**：分词器在 TS 侧（`tokenizeBigram`），脚本里复制一份必然漂移。
 *    交给应用启动时的健康检查重建。
 * 2. **不覆盖已存在的行**：`ON CONFLICT(drawer_id) DO NOTHING`。重跑幂等，也不复活墓碑。
 * 3. **不猜作用域**：agentId 按 `palace-backend.ts` 的 `resolveConversationAgentId` 同一条
 *    规则解析（participants 实例 id → 定义 id 映射 → messages.agent_id → assistant）。
 *    user_id 恒为 `local-user`（conversations 表全部会话都是它）。
 * 4. **不改消息本身**：只往宫殿写，不动 messages / memory_segments 任何一行。
 *
 * 与线上去重：用与 `deterministicDrawerId(wing, room, content)` **逐字一致**的算法算 id，
 * 内容相同的消息天然命中已有行（2026-09-18 核对：29 条命中里 0 条内容不一致）。
 *
 * 用法：
 *   node scripts/palace-backfill-messages.mjs                  # dry-run：只报数，不写
 *   node scripts/palace-backfill-messages.mjs --apply          # 执行
 *   node scripts/palace-backfill-messages.mjs --min-chars 100  # 只回填更长的内容
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
 * 从一条助手消息里取**用户可见正文**。
 *
 * 口径必须与线上**逐字一致**——`drawer_id` 是内容寻址，差一个字符就会算出不同的 id，
 * 同一轮内容在库里出现两行（检索时双份、读回时看起来像重复聊过）。
 * 线上口径见 `bridge-agent-instance-events.ts` 的 `assistantTextFromParts`：
 *
 *     parts.filter(type==='text').map(p => p.text).join('')   // 不 trim、不用分隔符
 *
 * 三处刻意与"看起来更整洁"的写法不同：
 * - **`join('')` 而非 `join('\n')`**：线上就是直接拼接，中间的空行属于正文（模型用空行分段）。
 *   2026-09-18 实测：改成 join('\n') 会让 60 条样本里 32 条算出不同的 id。
 * - **不 trim 单条 part**：仅对拼接结果 `trim()`（与 `assistantTextFromParts(...).trim()` 对齐，
 *   调用处 877 行判的就是 `.trim()` 后的非空）。
 * - **剔除 `NO_REPLY` 哨兵 part**：线上 `partsForPersist` 会把它摘掉再去归档
 *   （`bridge-agent-instance-events.ts:794`），哨兵是模型的"这轮不需要回话"协议，
 *   不是用户看到的话。存量落库时没有这个剔除，所以照抄 parts 会把它当正文归档。
 *
 * 另外剥 thinking：更早期的消息把模型独白写在 text part 里（形如 `独白…</think>\n\n正文`），
 * 现行持久化已把 thinking 拆成独立 part（`parseThinkTagsFromRaw`），但存量没这个拆分。
 * 不剥就会把「模型的内心话」当正文归档。实测 932 条里 10 条带该标记（2026-08-25 → 09-14）。
 */
function extractVisibleText(raw) {
  try {
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return ''
    const source = Array.isArray(o.parts)
      ? o.parts
          .filter(
            (p) =>
              p &&
              p.type === 'text' &&
              typeof p.text === 'string' &&
              !isNoReplySentinel(p.text),
          )
          .map((p) => p.text)
          .join('')
      : typeof o.text === 'string'
        ? o.text
        : ''
    return stripThinking(source).trim()
  } catch {
    return ''
  }
}

/** 与 `bridge-agent-instance-events.ts:57` 的 isNoReplySentinel 同构 */
function isNoReplySentinel(text) {
  return typeof text === 'string' && text.trim().toUpperCase() === 'NO_REPLY'
}

function stripThinking(raw) {
  // 成对标签先整体去掉
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  // 剩下的孤立 </think>：它之前是独白，取之后的部分
  const closeIdx = s.lastIndexOf('</think>')
  if (closeIdx >= 0) s = s.slice(closeIdx + '</think>'.length)
  return s.replace(/^\n+/, '')
}

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA busy_timeout=5000')

const WING = 'conversations'

/**
 * 会话归属（与 palace-backend.ts 的 resolveConversationAgentId 同一条规则）：
 * participants 存实例 id（main/default），宫殿用定义 id（assistant）——必须先映射。
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

const existsStmt = db.prepare('SELECT drawer_id, content FROM palace_drawers WHERE drawer_id = ?')
const messages = db
  .prepare(
    `SELECT id, conversation_id, content_json, timestamp FROM messages
      WHERE role = 'assistant' AND is_streaming = 0
      ORDER BY timestamp ASC`,
  )
  .all()

const stats = { empty: 0, belowMin: 0, already: 0, mismatch: 0 }
const planned = []
for (const m of messages) {
  const content = extractVisibleText(m.content_json)
  if (!content) {
    stats.empty++
    continue
  }
  if (content.length < Math.max(0, Number.isFinite(minChars) ? minChars : 50)) {
    stats.belowMin++
    continue
  }
  const drawerId = deterministicDrawerId(WING, m.conversation_id, content)
  const row = existsStmt.get(drawerId)
  if (row) {
    stats.already++
    // 同 id 但内容不同 = 寻址或取文口径漂移了，必须报出来（会让回填写出重复语义的行）
    if (row.content !== content) stats.mismatch++
    continue
  }
  planned.push({
    drawerId,
    conversationId: m.conversation_id,
    content,
    createdAt: m.timestamp,
    messageId: m.id,
  })
}

console.log(`库: ${DB_PATH}`)
console.log(`模式: ${apply ? 'APPLY（会写库）' : 'DRY-RUN（只报数）'}   门槛: ${minChars} 字符`)
console.log('')
console.log(`助手消息（is_streaming=0）: ${messages.length}`)
console.log(`  跳过·无文本（纯工具轮）: ${stats.empty}`)
console.log(`  跳过·低于门槛: ${stats.belowMin}`)
console.log(`  已在宫殿（同内容寻址 id）: ${stats.already}`)
if (stats.mismatch > 0) {
  console.log(`  ⚠ 其中 ${stats.mismatch} 条同 id 但内容不一致 —— 取文口径漂移，先查清再写`)
}
console.log(`待回填: ${planned.length}   字符合计: ${planned.reduce((s, p) => s + p.content.length, 0)}`)
console.log('')
console.log('样例（前 3 条）:')
for (const p of planned.slice(0, 3)) {
  console.log(
    `  room=${p.conversationId.slice(0, 36)}  drawer=${p.drawerId}  ${p.content.length} 字符  ${p.createdAt.slice(0, 19)}`,
  )
  console.log(`    正文开头: ${p.content.slice(0, 60).replace(/\s+/g, ' ')}`)
}

if (!apply) {
  console.log('')
  console.log('（dry-run 结束。加 --apply 才会写库；索引由应用下次启动自动重建）')
  db.close()
  process.exit(0)
}

// 写前留痕
const backupDir = path.join(path.dirname(DB_PATH), 'backups')
fs.mkdirSync(backupDir, { recursive: true })
const backupFile = path.join(
  backupDir,
  `palace-backfill-messages-${new Date().toISOString().slice(0, 10)}-${Date.now()}.json`,
)
fs.writeFileSync(
  backupFile,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      dbPath: DB_PATH,
      entries: planned.map((p) => ({
        drawerId: p.drawerId,
        messageId: p.messageId,
        conversationId: p.conversationId,
        charCount: p.content.length,
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
    const agentId = resolveAgentId(p.conversationId)
    const res = insertStmt.run(
      p.drawerId,
      agentId,
      p.conversationId,
      WING,
      p.conversationId,
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
  process.exit(1)
}

console.log('')
console.log(`已写入 ${inserted} 行；改动清单已存: ${backupFile}`)
const total = db
  .prepare("SELECT COUNT(*) AS c FROM palace_drawers WHERE deleted_at IS NULL")
  .get().c
console.log(`宫殿现有活跃行: ${total}（索引将在应用下次启动时自动重建）`)

db.close()
