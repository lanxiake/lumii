#!/usr/bin/env node
/**
 * 向量开关上线核查（只读）
 *
 * 回答三个问题：
 * 1. 库里到底有没有向量、补到哪了（palace_drawer_embeddings vs 活跃抽屉）
 * 2. 应用日志里向量装配成功没有（嵌入器加载 / 补齐进度 / 补齐完成）
 * 3. 生产检索返回的 mode 是不是 hybrid（回落 fts 说明向量没接上）
 *
 * 用法：node scripts/check-palace-vector.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DB = join(homedir(), '.lumii', 'data', 'agent-runtime.db')
const LOG_DIR = join(homedir(), '.lumii', 'logs', 'app')

/**
 * **不要用 `readOnly: true` 打开**：本库是 WAL 模式，只读打开无法创建/使用 `-shm`
 * 文件，实测会报 `disk I/O error`——而那个错误会被应用侧记成「node:sqlite 失败，
 * 回退 better-sqlite3」，看起来像是应用自己的毛病，实际是**本脚本与活着的应用抢库**。
 * 普通读写模式打开并只执行 SELECT 即可。
 */
function open() {
  return new DatabaseSync(DB)
}

console.log('═══ 1. 向量表 ═══')
{
  const db = open()
  try {
    const emb = db.prepare('SELECT COUNT(*) c FROM palace_drawer_embeddings').get()?.c ?? 0
    const models = db
      .prepare('SELECT model_id, dims, COUNT(*) c FROM palace_drawer_embeddings GROUP BY model_id, dims')
      .all()
    const active = db
      .prepare('SELECT COUNT(*) c FROM palace_drawers WHERE deleted_at IS NULL')
      .all()
    const tomb = db.prepare('SELECT COUNT(*) c FROM palace_drawers WHERE deleted_at IS NOT NULL').get()?.c ?? 0
    console.log(`  向量 ${emb} 条 / 活跃抽屉 ${active[0]?.c} 条 / 墓碑 ${tomb} 条`)
    for (const m of models) console.log(`    ${m.model_id} dims=${m.dims} → ${m.c} 条`)
    // 续跑判据
    const pending = db
      .prepare(
        `SELECT COUNT(*) c FROM palace_drawers d
     LEFT JOIN palace_drawer_embeddings e ON e.drawer_id = d.drawer_id
          WHERE d.deleted_at IS NULL AND e.drawer_id IS NULL`,
      )
      .get()?.c ?? 0
    console.log(`  待补（未索引的活跃抽屉）= ${pending}`)
  } finally {
    db.close()
  }
}

console.log('\n═══ 2. 应用日志（向量相关行）═══')
{
  if (!existsSync(LOG_DIR)) {
    console.log(`  日志目录不存在：${LOG_DIR}`)
  } else {
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, m: statSync(join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    const latest = files[0]
    if (!latest) console.log('  没有 .log 文件')
    else {
      console.log(`  最新日志：${latest.f}`)
      const txt = readFileSync(join(LOG_DIR, latest.f), 'utf8')
      const lines = txt.split(/\r?\n/).filter((l) => /palace-vector|嵌入器|补齐/.test(l))
      if (lines.length === 0) console.log('  （没有任何向量相关日志 → 开关没生效或没重启）')
      for (const l of lines.slice(-25)) console.log('   ' + l.trim().slice(0, 200))
    }
  }
}
