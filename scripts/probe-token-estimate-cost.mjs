/**
 * 量化 `estimateTextTokenCount` 的开销 —— CLI 测试场景下冻结的直接嫌疑。
 *
 * 冻结现场（2026-09-20 15:10，三个 CLI 套件同时跑）抓到 6 次，栈完全一致：
 *   estimateTextTokenCount@index.js:36513   ← 占绝大多数样本
 *   estimateMessageBodyTokens@index.js:36527
 *   estimateTokenCount@index.js:36573
 * 心跳稳定停 2.0~2.04s，覆盖率 17~28%（JS 层，能看到函数名）。
 *
 * 实现是**逐字符 + 每字符一次带 u 标志的正则**：
 *   for (const ch of text) tokens += CJK_CHAR_RE.test(ch) ? 0.6 : 0.3
 *
 * 本脚本用**真实消息**（从 live DB 只读取样）对比三种实现：
 *   旧：逐字符 + 正则 test
 *   新：码点范围整数比较（语义等价）
 *   旁路：text.length × 0.6（上界参考，不采用）
 *
 *   node scripts/probe-token-estimate-cost.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'

// ── 旧实现（逐字面量照抄）────────────────────────────────────────────────
const CJK_CHAR_RE = /[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]/u

function oldEstimate(text) {
  if (!text) return 0
  let tokens = 0
  for (const ch of text) {
    tokens += CJK_CHAR_RE.test(ch) ? 0.6 : 0.3
  }
  return tokens
}

// ── 新实现：码点范围整数比较，语义等价 ──────────────────────────────────
function isCjkCodePoint(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x8c48 && cp <= 0xfaff) || // 原正则实际范围：起笔是「豈」U+8C48，非 U+F900
    (cp >= 0x3040 && cp <= 0x309f) || // 平假名
    (cp >= 0x30a0 && cp <= 0x30ff) || // 片假名
    (cp >= 0xac00 && cp <= 0xd7af) // 韩文
  )
}

function newEstimate(text) {
  if (!text) return 0
  let tokens = 0
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)
    if (cp > 0xffff) i++ // 跳过代理对的低位
    tokens += isCjkCodePoint(cp) ? 0.6 : 0.3
  }
  return tokens
}

// ── 语义等价性：在真实样本上逐条比对 ─────────────────────────────────────
const db = new DatabaseSync(path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db'), {
  readOnly: true,
})
const rows = db.prepare('SELECT content_json FROM messages ORDER BY length(content_json) DESC LIMIT 400').all()
const texts = rows.map((r) => r.content_json)
const totalChars = texts.reduce((a, t) => a + t.length, 0)

let mismatch = 0
let firstBad = null
for (const t of texts) {
  const a = oldEstimate(t)
  const b = newEstimate(t)
  if (a !== b) {
    mismatch++
    if (!firstBad) firstBad = { len: t.length, old: a, neu: b }
  }
}
console.log(`样本: ${texts.length} 条真实 content_json，共 ${(totalChars / 1048576).toFixed(1)}M 字符`)
console.log(`语义差异: ${mismatch} 条${firstBad ? `（首例 len=${firstBad.len} old=${firstBad.old} new=${firstBad.neu}）` : ' ✅ 完全一致'}`)

// ── 耗时对比 ──────────────────────────────────────────────────────────────
const ms = (a, b) => Number(b - a) / 1e6
function bench(fn, label, runs = 2) {
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint()
    for (const t of texts) fn(t)
    const t1 = process.hrtime.bigint()
    best = Math.min(best, ms(t0, t1))
  }
  console.log(`${label.padEnd(28)} ${best.toFixed(0).padStart(6)}ms`)
  return best
}

console.log()
const tOld = bench(oldEstimate, '旧：逐字符 + 正则 test')
const tNew = bench(newEstimate, '新：码点整数比较')
console.log(`\n加速比: ${(tOld / tNew).toFixed(1)}×`)

// ── 模拟"上下文累积"：反复估算同一批消息（CLI 测试里每回合都会做）──────
console.log('\n=== 模拟一个真实回合里的反复估算（20 次）===')
{
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 20; i++) for (const t of texts) oldEstimate(t)
  const t1 = process.hrtime.bigint()
  const t2 = process.hrtime.bigint()
  for (let i = 0; i < 20; i++) for (const t of texts) newEstimate(t)
  const t3 = process.hrtime.bigint()
  console.log(`旧: ${ms(t0, t1).toFixed(0)}ms   新: ${ms(t2, t3).toFixed(0)}ms`)
}
