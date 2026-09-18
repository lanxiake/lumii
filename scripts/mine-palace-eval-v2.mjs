#!/usr/bin/env node
/**
 * 宫殿对照集候选挖掘 v2（只读）
 *
 * ## v1 为什么作废
 *
 * v1 从关键词联想造候选，跑出来 8 条里只有 1 条真正有对照价值。跑分结果显示四类毛病：
 * 1. `p05` 查询「接收服务要不要重启一下」与库内「我这边需要重启服务吗」**几乎逐字重合**——
 *    测不出语义检索的价值（测的是字面匹配）。
 * 2. `p10` 的 gold 是「检查过了：今天手上没有新的真实任务样本——只有…（ODS 同步卡点、sjzh 归档那些）」
 *    ——一条**旁注**，主题不是 ODS。「检索到它」没有意义。
 * 3. `p03`：库里是 `docker logs ... | grep -E warn|error` 的原始粘贴，用户问「服务器日志里反复报错的那批内容」
 *    ——bigram 与向量**都进不了前 5**（#19/#23），说明这不是措辞错配，是**内容本身没有可检索的语义**。
 * 4. `p01` 的 gold 在全文第 377 字，而向量语料只取前 300 字——**向量索引里根本没有 gold 的字**，
 *    它却排到 #60，典型的"被截断的残文造成噪声"。
 *
 * ## v2 的取法：从**用户的真实问法**出发
 *
 * 不再猜，直接翻 `messages` 表里用户真实发过的话，挑出「主题明确、措辞口语」的那批，
 * 再去宫殿里找它们对应的归档。这样造出来的对照**天然就是真实分布**。
 *
 * 用法：node scripts/mine-palace-eval-v2.mjs [--limit 40]
 */
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const limit = process.argv.includes('--limit')
  ? Number(process.argv[process.argv.indexOf('--limit') + 1])
  : 40

const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'), {
  readOnly: true,
})

// 用户真实发过的、主题明确的问题（排除探针、定时、系统消息）
const rows = db
  .prepare(
    `SELECT role, content_json, conversation_id, timestamp
       FROM messages
      WHERE role = 'user'
        AND conversation_id NOT LIKE 'probe-%'
        AND conversation_id NOT LIKE 'cron:%'
        AND conversation_id NOT LIKE 'evolution:%'
      ORDER BY timestamp DESC
      LIMIT 4000`,
  )
  .all()

const out = []
for (const r of rows) {
  let o
  try {
    o = JSON.parse(r.content_json)
  } catch {
    continue
  }
  // 两种落库形状都见过：`{type:'text',text}`（主聊天路径）与 `{parts:[{type:'text'}]}`
  const text = (
    typeof o.text === 'string'
      ? o.text
      : (Array.isArray(o.parts) ? o.parts : [])
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('')
  ).trim()
  if (!text) continue
  // 只要**有主题**的：10~60 字、含中文、不是纯命令/粘贴
  if (text.length < 10 || text.length > 60) continue
  if (!/[一-鿿]/.test(text)) continue
  if (/^root@|^\$ |^docker |^SELECT|^https?:/.test(text)) continue
  if (/^(继续|好的|可以|嗯|行)$/.test(text)) continue
  out.push({ text, conv: r.conversation_id, at: r.timestamp })
  if (out.length >= limit) break
}

console.log(`用户真实消息（10~60 字、有主题）${out.length} 条：\n`)
for (const o of out) {
  console.log(`  ${String(o.at).slice(0, 10)}  ${o.text.replace(/\n/g, ' ')}`)
}

const fs = await import('node:fs')
fs.writeFileSync(
  'docs/test/memory-eval/palace-user-questions.json',
  JSON.stringify({ minedAt: new Date().toISOString(), questions: out }, null, 2),
  'utf8',
)
console.log(`\n→ docs/test/memory-eval/palace-user-questions.json`)
db.close()
