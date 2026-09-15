/**
 * 清理 planner 待办写入「幽灵命名空间」的历史记忆行（一次性维护脚本）。
 *
 * 背景（2026-09-15 体检）：
 *   planner-landing 旧实现用裸 SQL 把自主调度待办写进 agent_memories，写死 user_id='local'——
 *   与记忆系统实际读取的 'local-user' 不一致，既不会被注入也不会被检索，16 天积压 378 行。
 *   修复后（轮换 + 正确作用域 + planner-todo 标签）新数据不再产生；本脚本清理历史残留。
 *
 * 用法：
 *   node scripts/cleanup-planner-todo-memories.mjs            # dry-run：只列出将删除的行
 *   node scripts/cleanup-planner-todo-memories.mjs --apply    # 备份后删除（主表 + FTS 索引）
 *
 * 安全：删除前把命中行导出到 <db目录>/backups/planner-todos-local-<日期>.json，可据此回滚。
 * 注意：应用运行期间旧进程仍会按 10 分钟 tick 继续写入该命名空间，建议重启应用后再执行一次。
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const APPLY = process.argv.includes('--apply')
const DB_PATH =
  process.env.LUMII_DB_PATH ?? path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')

if (!fs.existsSync(DB_PATH)) {
  console.error(`✗ 数据库不存在: ${DB_PATH}`)
  process.exit(1)
}

const db = new DatabaseSync(DB_PATH, { timeout: 5000 })
const rows = db
  .prepare(
    `SELECT rowid, id, agent_id, user_id, category, content, importance, tags, created_at
     FROM agent_memories WHERE user_id = 'local'`,
  )
  .all()

console.log(`数据库: ${DB_PATH}`)
console.log(`命中 user_id='local' 的历史行: ${rows.length}`)
if (rows.length === 0) {
  console.log('无需清理。')
  process.exit(0)
}

const byAgent = {}
for (const r of rows) byAgent[r.agent_id] = (byAgent[r.agent_id] ?? 0) + 1
const dates = rows.map((r) => r.created_at).sort()
console.log('  按 agent:', byAgent)
console.log(`  时间范围: ${dates[0]} ~ ${dates[dates.length - 1]}`)
console.log('  样例:')
for (const r of rows.slice(0, 5)) console.log(`    - ${String(r.content).slice(0, 48)}`)

if (!APPLY) {
  console.log('\n（dry-run，未删除。加 --apply 执行删除）')
  process.exit(0)
}

const backupDir = path.join(path.dirname(DB_PATH), 'backups')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().slice(0, 10)
const backup = path.join(backupDir, `planner-todos-local-${stamp}.json`)
fs.writeFileSync(backup, JSON.stringify(rows, null, 1), 'utf8')
console.log(`\n已备份到: ${backup}`)

db.exec('BEGIN')
try {
  const delFts = db.prepare('DELETE FROM agent_memories_fts WHERE rowid = ?')
  const delMem = db.prepare('DELETE FROM agent_memories WHERE rowid = ?')
  for (const r of rows) {
    delFts.run(r.rowid)
    delMem.run(r.rowid)
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  throw err
}

const left = db.prepare("SELECT COUNT(*) n FROM agent_memories WHERE user_id = 'local'").get().n
const memCount = db.prepare('SELECT COUNT(*) n FROM agent_memories').get().n
const ftsCount = db.prepare('SELECT COUNT(*) n FROM agent_memories_fts').get().n
console.log(`清理完成：剩余 ${left} 行`)
console.log(
  `索引一致性：agent_memories ${memCount} vs FTS ${ftsCount} ${memCount === ftsCount ? '✓' : '✗ 不一致，请在应用内触发索引重建'}`,
)
