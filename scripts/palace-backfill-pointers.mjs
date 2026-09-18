/**
 * 回填工作记忆的原文指针（`[d:xxxx]`）—— 2026-09-18 一次性脚本。
 *
 * 背景：注入侧原先不带任何能回到原文的入口（`palace_drawer_id` 覆盖率 41% 且从没进过
 * 提示词）。改法是把指针在**写入时**钉进 content，但那只对新写入生效——历史记忆里
 * 已经有 96 条带 `palace_drawer_id` 的，指针得补上才和线上口径一致。
 *
 * 判定：
 * - 只处理**活跃**行（`is_archived=0 AND deleted_at IS NULL AND superseded_at IS NULL`）
 * - 只处理 `palace_drawer_id` 非空、且该 drawer 在宫殿里**真的存在**（`deleted_at IS NULL`）的
 * - 内容已带指针的跳过（幂等，可重复跑）
 * - 死链（drawer 不存在）**不动**：留着 `palace_drawer_id` 供排查，等下次本脚本或
 *   段归档路径自然刷新；给死链加指针就是给模型一个点开报错的入口
 *
 * 用法：node --experimental-strip-types scripts/palace-backfill-pointers.mjs [--dry-run]
 * 依赖：先 `pnpm dev:stop`（SQLite 单写者，应用在跑时改库有风险）
 */

import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DB = join(homedir(), '.lumii', 'data', 'agent-runtime.db')
const DRY = process.argv.includes('--dry-run')

/** 与 content-address.ts 的 POINTER_RE / withDrawerPointer 同口径 */
const POINTER_RE = /^\[d:[0-9a-f]{1,64}\]\s/

function bigramJoin(text) {
  if (!text) return ''
  const tokens = new Set()
  const lower = text.toLowerCase()
  const segs = lower.match(/[一-鿿]+|[a-z0-9]+/g) ?? []
  for (const seg of segs) {
    if (/[一-鿿]/.test(seg)) {
      if (seg.length === 1) tokens.add(seg)
      else for (let i = 0; i + 2 <= seg.length; i++) tokens.add(seg.slice(i, i + 2))
    } else tokens.add(seg)
  }
  return [...tokens].join(' ')
}

if (!existsSync(DB)) {
  console.error(`数据库不存在: ${DB}`)
  process.exit(1)
}

if (!DRY) {
  const backup = `${DB}.bak-pointers-${Date.now()}`
  copyFileSync(DB, backup)
  console.log(`已备份: ${backup}`)
}

const db = new DatabaseSync(DB)
const q = (sql, ...a) => db.prepare(sql).all(...a)

// 候选：活跃 + 有 drawer_id + 内容尚无指针
const rows = q(`
  SELECT id, rowid, content, tags, palace_drawer_id
    FROM agent_memories
   WHERE palace_drawer_id IS NOT NULL
     AND is_archived = 0 AND deleted_at IS NULL AND superseded_at IS NULL
     AND content NOT LIKE '[d:%'
`)

const liveIds = new Set(
  q(`SELECT drawer_id FROM palace_drawers WHERE deleted_at IS NULL`).map((r) => r.drawer_id),
)

const toFill = []
const dead = []
for (const r of rows) {
  if (liveIds.has(r.palace_drawer_id)) toFill.push(r)
  else dead.push(r)
}

console.log(`\n候选（有 id、无指针、活跃）: ${rows.length}`)
console.log(`  → 抽屉存在、可回填     : ${toFill.length}`)
console.log(`  → 死链（跳过，不动）   : ${dead.length}`)
for (const d of dead) {
  console.log(`      ${d.id.slice(0, 12)}… → ${d.palace_drawer_id} (agent=?)`)
}

if (DRY) {
  console.log('\n--dry-run：未写入。样例：')
  for (const r of toFill.slice(0, 3)) {
    console.log(`  ${r.id.slice(0, 12)}…`)
    console.log(`    旧: ${r.content.slice(0, 70)}`)
    console.log(`    新: [d:${r.palace_drawer_id}] ${r.content.slice(0, 70)}`)
  }
  db.close()
  process.exit(0)
}

const update = db.prepare('UPDATE agent_memories SET content = ? WHERE id = ?')
const delIdx = db.prepare('DELETE FROM agent_memories_fts WHERE rowid = ?')
const insIdx = db.prepare('INSERT INTO agent_memories_fts (rowid, content, tags) VALUES (?, ?, ?)')

let n = 0
db.exec('BEGIN')
try {
  for (const r of toFill) {
    const bare = r.content.replace(POINTER_RE, '')
    const next = `[d:${r.palace_drawer_id}] ${bare}`
    update.run(next, r.id)
    // FTS 同步：内容变了必须重建该行索引，否则新指针搜不到
    delIdx.run(r.rowid)
    insIdx.run(r.rowid, bigramJoin(next), bigramJoin(r.tags))
    n++
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('回填失败，已回滚:', err.message)
  db.close()
  process.exit(1)
}

console.log(`\n回填完成: ${n} 条`)

// 校验：回填后再查，确认没有重复指针、FTS 行数与主表一致
const dup = q(`SELECT COUNT(*) c FROM agent_memories WHERE content LIKE '[d:%[d:%'`)[0].c
const mainCount = q(`SELECT COUNT(*) c FROM agent_memories WHERE deleted_at IS NULL`)[0].c
const ftsCount = q(`SELECT COUNT(*) c FROM agent_memories_fts`)[0].c
console.log(`  重复指针行: ${dup}（应为 0）`)
console.log(`  主表 ${mainCount} / FTS ${ftsCount}（应相等）`)

const sample = q(
  `SELECT content FROM agent_memories WHERE content LIKE '[d:%' AND is_archived = 0 LIMIT 3`,
)
console.log('\n样例：')
for (const s of sample) console.log(`  ${s.content.slice(0, 90)}`)

db.close()
