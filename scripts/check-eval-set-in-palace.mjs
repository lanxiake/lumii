#!/usr/bin/env node
/**
 * 把 T1 对照集（15 条）的 gold 逐条放进**宫殿语料**里查，看它们到底在不在。
 *
 * 起因：T1 跑分台 `semantic-eval.mjs` 查的是 `agent_memories`（工作记忆，285 条），
 * 而 T3 接的向量检索查的是 `palace_drawers`（宫殿原始会话，1058 条）。两套语料
 * 不只是规模不同——**颗粒度不同**：工作记忆是提炼过的结构化摘要，宫殿是逐轮的
 * user/assistant 原文。用前者的打分证明后者有效，是本仓「用 A 口径证明、用 B 口径
 * 上线」那类错误的翻版。
 *
 * 用法：node scripts/check-eval-set-in-palace.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'), {
  readOnly: true,
})
const set = JSON.parse(fs.readFileSync('docs/test/memory-eval/semantic-eval-set.json', 'utf8'))

const palace = db
  .prepare('SELECT drawer_id, wing, room, content FROM palace_drawers WHERE deleted_at IS NULL')
  .all()

console.log(`宫殿语料 ${palace.length} 条\n`)
console.log('id'.padEnd(22) + '类别'.padEnd(10) + '命中   最近出处(wing/room)')
for (const q of set.queries) {
  const hits = palace.filter((d) => q.expect.some((e) => d.content.includes(e)))
  const where = hits.length
    ? hits
        .slice(0, 2)
        .map((h) => `${h.wing.split(':')[0]}/${String(h.room).slice(0, 12)}`)
        .join(' ')
    : '—'
  console.log(
    q.id.padEnd(22) + q.category.padEnd(10) + String(hits.length).padEnd(6) + where,
  )
}

const inPalace = set.queries.filter((q) =>
  palace.some((d) => q.expect.some((e) => d.content.includes(e))),
).length
console.log(`\n15 条里有 gold 落在宫殿的：${inPalace} 条`)
db.close()
