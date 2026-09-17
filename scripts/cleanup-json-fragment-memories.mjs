/**
 * 清理历史遗留的「JSON 残片」记忆行（一次性维护脚本，2026-09-17）。
 *
 * 背景（评审 `docs/design/记忆系统/2026-09-17-记忆系统评审.md` §2.4.3）：
 * `RULE_PATTERNS[0]`（「记住：…」）用 `.{2,200}` 贪婪捕获，把用户消息里粘贴的
 * JSON 模板尾部一并吞入，产出「半句话 + 悬空 "}]」这类残片，且 importance 全为 0.95。
 * 实测库中 5+ 条。源头已在 2026-09-17 修好（句读边界截断 + `validateCandidates` 写入门），
 * 本脚本清理**存量**——它们仍会以 0.95 的高分参与注入。
 *
 * 用法：
 *   node scripts/cleanup-json-fragment-memories.mjs            # dry-run：只列出将删除的行
 *   node scripts/cleanup-json-fragment-memories.mjs --apply    # 备份后删除（主表 + FTS 索引）
 *
 * 安全：删除前把命中行导出到 <db目录>/backups/json-fragment-memories-<日期>.json，可据此回滚。
 * 判据与运行时写入门 `packages/agent-runtime/src/memory/memory-extractor.ts`
 * 的 `JSON_FRAGMENT_PATTERNS` 完全一致——两处若不一致，以本文件为准并同步修改那边。
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const APPLY = process.argv.includes('--apply')
const DB_PATH =
  process.env.LUMII_DB_PATH ?? path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')

/**
 * 与 memory-extractor.ts 的 `isJsonFragment` 完全一致。用真实数据校准过两轮：
 * 以 `"}` / `"}]`（JSON 对象闭合）结尾**且**双引号计数为奇数——判别核心是"引号未闭合"，
 * 那才是被截断的字符串；引号成对说明 JSON 完整，那是内容不是残片。
 * 另加粘贴 JSON 键值特征（`"key": "`）。
 */
const OBJECT_TAIL_RE = /["'`]\s*\}\s*\]?\s*$/
const JSON_KEY_RE = /["'`]\s*:\s*["'`[{]/

function isJsonFragment(content) {
  if (JSON_KEY_RE.test(content)) return true
  const unbalanced = ((content.match(/"/g) ?? []).length % 2) === 1
  return OBJECT_TAIL_RE.test(content) && unbalanced
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`✗ 数据库不存在: ${DB_PATH}`)
  process.exit(1)
}

const db = new DatabaseSync(DB_PATH, { timeout: 5000 })
const rows = db
  .prepare(
    `SELECT rowid, id, agent_id, user_id, category, importance, use_count, created_at, content
     FROM agent_memories ORDER BY created_at ASC`,
  )
  .all()

const hits = rows.filter((r) => isJsonFragment(r.content))

console.log(`数据库: ${DB_PATH}`)
console.log(`总行数: ${rows.length}`)
console.log(`命中 JSON 残片: ${hits.length}`)
for (const h of hits) {
  console.log(`  [${h.category} imp=${h.importance} used=${h.use_count}] ${JSON.stringify(h.content.slice(0, 100))}`)
}

if (hits.length === 0) {
  console.log('✓ 无残留，无需清理')
  db.close()
  process.exit(0)
}

if (!APPLY) {
  console.log('\n(dry-run) 加 --apply 执行删除；删除前会自动备份')
  db.close()
  process.exit(0)
}

// —— 备份 ——
const backupDir = path.join(path.dirname(DB_PATH), 'backups')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().slice(0, 10)
const backupPath = path.join(backupDir, `json-fragment-memories-${stamp}.json`)
fs.writeFileSync(backupPath, JSON.stringify(hits, null, 2), 'utf-8')
console.log(`\n已备份 ${hits.length} 行 → ${backupPath}`)

// —— 删除（主表 + FTS 索引）——
const delMain = db.prepare('DELETE FROM agent_memories WHERE id = ?')
const delFts = db.prepare('DELETE FROM agent_memories_fts WHERE rowid = ?')
db.exec('BEGIN IMMEDIATE TRANSACTION')
try {
  for (const h of hits) {
    delFts.run(h.rowid)
    delMain.run(h.id)
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('✗ 删除失败，已回滚:', err)
  db.close()
  process.exit(1)
}

const after = db.prepare('SELECT COUNT(*) AS c FROM agent_memories').get().c
console.log(`✓ 已删除 ${hits.length} 行；主表剩余 ${after} 行`)
console.log('  校验：node scripts/cleanup-json-fragment-memories.mjs（应显示 0 命中）')
db.close()
