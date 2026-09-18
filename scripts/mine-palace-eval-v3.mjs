#!/usr/bin/env node
/**
 * 宫殿对照集 v3 —— **回忆式查询**（挑样偏差最小）
 *
 * ## 为什么这条路最可信
 *
 * v1/v2 都要我「挑一条 gold 再编一个查询」，挑样偏差无法排除。
 * v3 换一个取法：找**用户真实发过的回忆式提问**——
 *
 *   「我之前跟你聊过的那个 TOCC 数据同步问题，结论是什么来着」
 *   「之前我们聊过往返机票比价的事，还记得当时是怎么定的方案吗？」
 *
 * 它的 gold 是**客观的**：用户追问的那件事，就在宫殿里那次对话的归档中。
 * 不用我判断"哪条相关"——**问题本身指名了它在问哪段过去**。
 *
 * 这也正是记忆检索的主场景：用户在后续会话里用不同措辞回忆以前的事，
 * 措辞与原始记录必然错配（用户不会背原话）。
 *
 * 用法：node scripts/mine-palace-eval-v3.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'), {
  readOnly: true,
})

const RECALL = /之前|上次|上回|刚才|还记得|聊过|说过|结论是什么|是什么来着|回顾一下/

const SQL = `SELECT conversation_id, content_json, timestamp
               FROM messages
              WHERE role = 'user'
                AND conversation_id NOT LIKE 'probe-%'
                AND conversation_id NOT LIKE 'cron:%'
                AND conversation_id NOT LIKE 'evolution:%'
              ORDER BY timestamp DESC
              LIMIT 4000`

const rows = db.prepare(SQL).all()

const found = []
for (const r of rows) {
  let o
  try {
    o = JSON.parse(r.content_json)
  } catch {
    continue
  }
  const text = (typeof o.text === 'string' ? o.text : '').trim()
  if (!text || !RECALL.test(text)) continue
  if (text.length > 120) continue
  found.push({ text, conv: r.conversation_id, at: r.timestamp })
}

console.log(`回忆式用户提问 ${found.length} 条：\n`)
for (const f of found) {
  console.log(`  ${String(f.at).slice(0, 16)}  ${f.text.replace(/\n/g, ' ')}`)
}

fs.writeFileSync(
  'docs/test/memory-eval/palace-recall-queries.json',
  JSON.stringify({ minedAt: new Date().toISOString(), queries: found }, null, 2),
  'utf8',
)
console.log(`\n→ docs/test/memory-eval/palace-recall-queries.json`)
db.close()
