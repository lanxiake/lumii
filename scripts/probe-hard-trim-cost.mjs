/**
 * 量化 `iterativeDropUntilUnder` 的**调用次数与总耗时** —— 反思压缩方案是否合理。
 *
 * 背景：2026-09-20 的主线程冻结根因是 token 估算。我先优化了单次估算的实现
 * （逐字符正则 → 码点比较，5.6×），但读 `strategies/hard-trim.ts` 时发现
 * **真正的规模问题在调用次数**：
 *
 *   iterativeDropUntilUnder 里有三个循环，都把 `estimateTokenCount(m)` 写在
 *   **循环条件**里（每次删一条消息就重算整个列表）：
 *     - `for (i < 48 && estimateTokenCount(m) > max)`   最多 48 次
 *     - `for (i < 16 && ...)` 体内再算一次              最多 32 次
 *     - `for (i < 8  && ...)`                           最多  8 次
 *   外加 `dropOldestRoundsUntilUnder` 的 while：每个轮次算一次。
 *
 *   最坏约 **90~100 次全量估算**，而每次是 O(全部消息字符数)。
 *
 * 本脚本用**真实会话的消息**复现这个控制流，计数并计时。
 * 单次估算用当前（已优化）的实现 —— 所以测出来的是**优化之后**的代价。
 *
 *   node scripts/probe-hard-trim-cost.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'

// ── 当前实现（与 token-estimate.ts 一致）────────────────────────────────
const isCjk = (cp) =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x8c48 && cp <= 0xfaff) ||
  (cp >= 0x3040 && cp <= 0x309f) ||
  (cp >= 0x30a0 && cp <= 0x30ff) ||
  (cp >= 0xac00 && cp <= 0xd7af)

function estimateTextTokenCount(text) {
  if (!text) return 0
  let tokens = 0
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    if (cp > 0xffff) i += 1
    tokens += isCjk(cp) ? 0.6 : 0.3
  }
  return tokens
}

/** 与 estimateMessageBodyTokens 等价（简化为字符串 content / parts） */
function messageTokens(msg) {
  let c
  try {
    c = JSON.parse(msg.content_json)
  } catch {
    return 0
  }
  if (!c || typeof c !== 'object') return 0
  let t = 0
  if (Array.isArray(c.parts)) {
    for (const p of c.parts) {
      if (p?.type === 'text' && typeof p.text === 'string') t += estimateTextTokenCount(p.text)
      else if (p?.type === 'thinking' && typeof p.thinking === 'string') t += estimateTextTokenCount(p.thinking)
      else t += estimateTextTokenCount(JSON.stringify(p ?? ''))
    }
    return t
  }
  if (typeof c.text === 'string') return estimateTextTokenCount(c.text)
  if (typeof c.content === 'string') return estimateTextTokenCount(c.content)
  return estimateTextTokenCount(JSON.stringify(c))
}

// ── 计数包装 ─────────────────────────────────────────────────────────────
let calls = 0
function estimateTokenCount(msgs) {
  calls++
  let total = 0
  for (const m of msgs) total += messageTokens(m)
  return Math.ceil(total)
}

// ── 复现 iterativeDropUntilUnder 的控制流（去掉 strip/truncate 等与计数无关的步骤）──
function iterativeDropUntilUnder(messages, maxEstimatedTokens) {
  let m = messages
  if (estimateTokenCount(m) > maxEstimatedTokens) m = m // microcompact 不改数量
  if (estimateTokenCount(m) > maxEstimatedTokens) m = m // truncateHeavy 同上
  if (estimateTokenCount(m) > maxEstimatedTokens) m = dropOldestRounds(m, maxEstimatedTokens)

  for (let i = 0; i < 48 && m.length > 1 && estimateTokenCount(m) > maxEstimatedTokens; i++) {
    m = m.slice(1)
  }
  for (let i = 0; i < 16 && m.length > 1 && estimateTokenCount(m) > maxEstimatedTokens; i++) {
    if (estimateTokenCount(m) <= maxEstimatedTokens) break
  }
  for (let i = 0; i < 8 && m.length > 1 && estimateTokenCount(m) > maxEstimatedTokens; i++) {
    m = m.slice(1)
  }
  return m
}

function dropOldestRounds(messages, max) {
  if (messages.length <= 1 || estimateTokenCount(messages) <= max) return messages
  let groups = chunkByRound(messages)
  while (groups.length > 1) {
    const candidate = groups.slice(1)
    const flat = candidate.flat()
    if (estimateTokenCount(flat) <= max) {
      groups = candidate
      break
    }
    groups = candidate
  }
  return groups.flat()
}

/** 简化：每 4 条算一轮（真实实现按 api round 分组） */
function chunkByRound(messages) {
  const out = []
  for (let i = 0; i < messages.length; i += 4) out.push(messages.slice(i, i + 4))
  return out
}

// ── 取真实会话 ───────────────────────────────────────────────────────────
const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'), {
  readOnly: true,
})
const conv = db
  .prepare(
    `SELECT conversation_id, count(*) n, sum(length(content_json)) bytes
     FROM messages GROUP BY conversation_id ORDER BY bytes DESC LIMIT 1`,
  )
  .get()
const msgs = db
  .prepare('SELECT role, content_json FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC')
  .all(conv.conversation_id)

console.log(`最大会话: ${conv.conversation_id}`)
console.log(`  消息 ${msgs.length} 条，content_json 合计 ${(conv.bytes / 1048576).toFixed(1)}MB\n`)

const total = (() => {
  calls = 0
  return estimateTokenCount(msgs)
})()
console.log(`该会话估算 token: ${total}`)
console.log(`单次估算耗时: 见下\n`)

// ── 模拟压缩：预算设为当前的一半，强制走满循环 ───────────────────────────
const budget = Math.floor(total * 0.3)
console.log(`压缩预算设为总额的 30%（${budget}）→ 会走满三个循环\n`)

calls = 0
const t0 = process.hrtime.bigint()
const result = iterativeDropUntilUnder(msgs, budget)
const t1 = process.hrtime.bigint()

console.log('=== 结果 ===')
console.log(`  estimateTokenCount 被调用 **${calls}** 次`)
console.log(`  总耗时 **${(Number(t1 - t0) / 1e6).toFixed(0)}ms**`)
console.log(`  压缩后消息数 ${result.length}（原 ${msgs.length}）`)
console.log()
console.log(`  平均每次估算 ${(Number(t1 - t0) / 1e6 / calls).toFixed(1)}ms`)
console.log()
console.log('=== 判读 ===')
console.log('若调用次数在 90 上下、总耗时达秒级，则：**真正的优化点是把它变成一次算完**，')
console.log('而不是继续压榨单次估算的实现（那部分已优化 5.6×，但被调用近百次抵消掉了）。')
