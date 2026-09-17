/**
 * 效用代理抽样核查（P1-5 · 评审 §4.3）
 *
 * 背景：`utility_count` 由 `computeContribution()` 用「回复文本与记忆正文的 bigram 重叠」
 * 近似判定，是个**代理**而非真值——模型转述记忆时未必复用原词。
 * 所以 P0-4 只让它入库、**不进打分**；要进打分必须先抽样核对代理与事实的一致性。
 *
 * 本脚本把最近 N 条反馈连同记忆正文与当时回复打出来，供人工判定
 * 「contribution_score 说的对不对」。判定结论写回 eval 记录，再决定是否接线。
 *
 * 门槛（实施计划 P1-5）：抽 50 条，命中率 ≥70% 才把 scoreMemory 的
 * useCountBonus 输入切到 utility_count；否则保持只记录。
 *
 * 用法：
 *   node scripts/memory-feedback-sample.mjs            # 默认抽最近 50 条
 *   node scripts/memory-feedback-sample.mjs --n 20
 *   node scripts/memory-feedback-sample.mjs --json
 */

import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'

const DB_PATH =
  process.env.LUMII_DB_PATH ?? path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')

const argv = process.argv.slice(2)
const n = argv.includes('--n') ? Number(argv[argv.indexOf('--n') + 1]) : 50
const jsonOnly = argv.includes('--json')

const THRESHOLD = 50
const PASS_RATE = 0.7

const db = new DatabaseSync(DB_PATH, { readOnly: true })

const rows = db
  .prepare(
    `SELECT f.id, f.memory_id, f.session_id, f.query_length, f.was_used_in_response,
            f.contribution_score, f.features, f.created_at, m.content
       FROM memory_usage_feedback f
       LEFT JOIN agent_memories m ON m.id = f.memory_id
      ORDER BY f.id DESC
      LIMIT ?`,
  )
  .all(Math.max(1, Math.min(Number.isFinite(n) ? n : 50, 500)))

/**
 * 取该反馈时刻之后的**第一条助手回复**——判定「这条记忆有没有被用上」必须看到它，
 * 否则只能看代理自己给的分数，等于自己证明自己。
 * `session_id` 是会话 id（V48 起由 MemoryIntegration 传 conversationId；早于该修复的行
 * 存的是实例 id，join 不到，会显示"（找不到回复）"）。
 */
const findReply = (sessionId, afterIso) => {
  try {
    const r = db
      .prepare(
        `SELECT content_json FROM messages
          WHERE conversation_id = ? AND role = 'assistant' AND timestamp >= ?
          ORDER BY timestamp ASC LIMIT 1`,
      )
      .get(sessionId, afterIso)
    if (!r) return null
    const cj = JSON.parse(r.content_json)
    const parts = cj.parts ?? (cj.content ? [{ type: 'text', text: cj.text ?? '' }] : [])
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('')
      .trim()
    return text || null
  } catch {
    return null
  }
}

const total = db.prepare('SELECT COUNT(*) AS c FROM memory_usage_feedback').get().c
const withUtility = db
  .prepare('SELECT COUNT(*) AS c FROM agent_memories WHERE utility_count > 0')
  .get().c

if (jsonOnly) {
  console.log(JSON.stringify({ total, withUtility, sampled: rows.length, rows }, null, 2))
  db.close()
  process.exit(0)
}

console.log(`反馈总行数: ${total}   其中被判「用上了」并抬高 utility_count 的记忆: ${withUtility}`)
console.log(`本次抽样: ${rows.length} 条\n`)

console.log('判定方法：读下面每条的「记忆正文」与「回复」，人工回答——')
console.log('  这条记忆真的被回复用上了吗？与 contribution_score 的判定一致吗？\n')

for (const r of rows) {
  const f = JSON.parse(r.features)
  const reply = findReply(r.session_id, r.created_at)
  console.log(`── #${r.id} ${r.created_at.slice(0, 19)} score=${r.contribution_score} used=${r.was_used_in_response}`)
  console.log(`   记忆: ${(r.content ?? '(记忆已删除)').slice(0, 90)}`)
  console.log(`   回复: ${reply ? reply.replace(/\s+/g, ' ').slice(0, 140) : '（找不到回复——该行早于 session_id 修复，或会话已删）'}`)
  console.log(
    `   特征: overlap=${f.semanticSimilarity?.toFixed(3)} kw=${f.keywordMatch} age=${f.memoryAge?.toFixed(1)}d exposure=${f.accessCount} len=${f.memoryLength}`,
  )
  console.log('')
}

console.log('─'.repeat(60))
if (total < THRESHOLD) {
  console.log(`✗ 样本不足：${total} < ${THRESHOLD}。`)
  console.log('  决策：维持「只记录不进打分」（实施计划约束 #6）。等反馈积累后再跑本脚本。')
} else {
  console.log(`样本 ${total} ≥ ${THRESHOLD}，可判定。`)
  console.log(`  把上面的逐条判定记下来：命中率 ≥ ${PASS_RATE * 100}% → 接线；否则保持只记录。`)
}

db.close()
