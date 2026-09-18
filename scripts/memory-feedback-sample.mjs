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
 * **抽样池必须排除自动化流量**（`--exclude-probes`，判定时默认开）：
 * 2026-09-18 实测反馈表 1068 行里 **426 行（40%）来自 `probe-*` 探针会话**——
 * 那是三固定问题、三固定目标的重复压测。判定「代理准不准」用的是**代理与真实
 * 使用的一致性**，把压测流量混进来测的是我自己造的分布；更糟的是探针的回复
 * 本就围绕目标记忆展开，overlap 天然虚高，会把命中率整体抬上去。
 *
 * 用法：
 *   node scripts/memory-feedback-sample.mjs            # 默认抽最近 50 条（含全部流量）
 *   node scripts/memory-feedback-sample.mjs --n 20
 *   node scripts/memory-feedback-sample.mjs --exclude-probes   # 判定 P1-5 时用这个
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
const excludeProbes = argv.includes('--exclude-probes')

const THRESHOLD = 50
const PASS_RATE = 0.7

/** 探针会话的 session_id 前缀（`scripts/probe-pointer-usage.mjs` 造的那些） */
const PROBE_PREFIX = 'probe' + '-'

const db = new DatabaseSync(DB_PATH, { readOnly: true })

/**
 * 抽样池只取**能复核的行**：`session_id` 必须能在 `messages` 里 join 回会话
 * （V48 之前存的是实例 id，join 不回来，判定时"没有回复可看"= 判不了）。
 * 能复核的行占比本身也是个信号：它低说明 `session_id` 口径还没铺开。
 */
const poolWhere = [
  "EXISTS (SELECT 1 FROM messages msg WHERE msg.conversation_id = f.session_id)",
  ...(excludeProbes ? [`f.session_id NOT LIKE '${PROBE_PREFIX}%'`] : []),
].join(' AND ')

const poolTotal = db
  .prepare(`SELECT COUNT(*) AS c FROM memory_usage_feedback f WHERE ${poolWhere}`)
  .get().c

/**
 * **随机**抽，不是取最近 N 条。
 *
 * 第一版是 `ORDER BY f.id DESC LIMIT n`，实测抽出来的是**最近 48 分钟**的 50 行、
 * 14 个会话（还含 2 个 cron 会话）——那样量的是"最后一小时的代理表现"，
 * 不能代表整个池，且同一会话的连续轮次高度相关、有效样本量远小于 50。
 * 用 `ORDER BY RANDOM()` 在**全池**上抽，配合下面的会话去重。
 */
const rawSample = db
  .prepare(
    `SELECT f.id, f.memory_id, f.session_id, f.query_length, f.was_used_in_response,
            f.contribution_score, f.features, f.created_at, m.content
       FROM memory_usage_feedback f
       LEFT JOIN agent_memories m ON m.id = f.memory_id
      WHERE ${poolWhere}
      ORDER BY RANDOM()
      LIMIT ?`,
  )
  .all(Math.max(1, Math.min(Number.isFinite(n) ? n : 50, 500)) * 3)

// 同一会话最多取 3 条：同一轮的注入反馈彼此高度相关，全取一个会话等于只测了一个场景
const SAME_SESSION_CAP = 3
const perSession = new Map()
const rows = []
for (const r of rawSample) {
  const c = perSession.get(r.session_id) ?? 0
  if (c >= SAME_SESSION_CAP) continue
  perSession.set(r.session_id, c + 1)
  rows.push(r)
  if (rows.length >= Math.max(1, Number.isFinite(n) ? n : 50)) break
}

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
// 门槛按**抽样池**算（上面那个），不是按全表：排除探针后会掉下来，
// 拿含探针的总数去判「样本够了」等于用压测流量给自己凑数。
const withUtility = db
  .prepare('SELECT COUNT(*) AS c FROM agent_memories WHERE utility_count > 0')
  .get().c

if (jsonOnly) {
  console.log(JSON.stringify({ total, withUtility, sampled: rows.length, rows }, null, 2))
  db.close()
  process.exit(0)
}

console.log(
  `反馈总行数: ${total}${excludeProbes ? `（本池 ${poolTotal}，已排除 probe-* 探针流量 ${total - poolTotal} 行）` : ''}` +
    `   其中被判「用上了」并抬高 utility_count 的记忆: ${withUtility}`,
)
console.log(`本次抽样: ${rows.length} 条${excludeProbes ? '（已排除探针）' : ''}\n`)

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
if (poolTotal < THRESHOLD) {
  console.log(`✗ 样本不足：${poolTotal} < ${THRESHOLD}。`)
  console.log('  决策：维持「只记录不进打分」（实施计划约束 #6）。等反馈积累后再跑本脚本。')
} else {
  console.log(`样本 ${poolTotal} ≥ ${THRESHOLD}，可判定。`)
  console.log(`  把上面的逐条判定记下来：命中率 ≥ ${PASS_RATE * 100}% → 接线；否则保持只记录。`)
  if (!excludeProbes) {
    console.log(
      `  ⚠️ 本次**未排除探针流量**。判定 P1-5 请加 --exclude-probes：` +
        `探针是三固定问题的重复压测，且回复本就围绕目标记忆展开，会把命中率抬高。`,
    )
  }
}

db.close()
