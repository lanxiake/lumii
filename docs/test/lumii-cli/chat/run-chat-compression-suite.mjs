#!/usr/bin/env node
/**
 * 聊天上下文压缩套件（L3 真实聊天模拟）— CHAT-CMP-01..06
 *
 * 验证：手动压缩基本流、压缩后仍记得早期事实、usage 字段、压缩后可用性、
 * 原文保留（可追溯）、压缩中止不破坏会话。
 *
 * 用例文档：docs/test/lumii-cli/chat/chat-test-cases.md
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 * 用法：node docs/test/lumii-cli/chat/run-chat-compression-suite.mjs
 *
 * 环境变量：CHAT_ONLY、CHAT_SKIP_LLM=1、CHAT_TURN_TIMEOUT_MS
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from '../lib/cli-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TURN_TIMEOUT = Number(process.env.CHAT_TURN_TIMEOUT_MS) || 180000
const ONLY = process.env.CHAT_ONLY || ''
const SKIP_LLM = process.env.CHAT_SKIP_LLM === '1'
const NO_RESTORE = process.env.CHAT_NO_RESTORE === '1'
const UM_PATH = path.join(h.DATA_DIR, 'user-memory.md')
/** user-memory.md 测试前快照（用于清理提取产物时区分「新增节」） */
const UM_SNAPSHOT = h.fileRead(UM_PATH)

const ev = h.createEvidence(__dirname, 'chat-compression-suite', '聊天上下文压缩套件')
const fails = { count: 0 }
const selected = (id) => !ONLY || id.startsWith(ONLY)

/** 造 n 轮对话的最小成本方式：短指令 + 短回复 */
function seedTurns(sk, turns) {
  for (let i = 0; i < turns; i++) {
    h.sendAndWait(sk, `第 ${i + 1} 条测试消息，请只回复：收到${i + 1}`, { timeoutMs: TURN_TIMEOUT })
  }
}

function main() {
  console.log('聊天上下文压缩套件（真实客户端 + 真实 LLM）\n')

  const pf = h.preflight()
  if (!pf.ok) {
    console.error('❌ 预检失败：')
    for (const p of pf.problems) console.error(`  - ${p}`)
    process.exit(3)
  }
  ev.record('PREFLIGHT', 'INFO', '预检通过')

  // ── CMP-01 手动压缩基本流（含 CMP-03 usage / CMP-05 原文保留的采样点） ──
  let cmp01Session = null
  if (selected('CHAT-CMP-01')) {
    h.runCase(ev, 'CHAT-CMP-01', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const sk = h.createSession('cmp01 手动压缩')
      cmp01Session = sk
      seedTurns(sk, 2)

      const usageBefore = h.contextUsage(sk)
      const usageKeys = Object.keys(usageBefore).join(',')
      const dbBefore = h.dbCount('messages', 'conversation_id = ?', [sk])

      const res = h.compactContext(sk, 2)

      const dbAfter = h.dbCount('messages', 'conversation_id = ?', [sk])
      if (dbAfter < dbBefore) {
        throw new Error(`压缩删除了原始消息（DB ${dbBefore} → ${dbAfter}），违反可追溯设计`)
      }
      const items = h.fetchMessages(sk, 40)
      const summaryLike = items.filter((i) => {
        const t = h.messageText(i)
        return /摘要|summary|压缩/.test(t) || i.role === 'summary' || i.isSummary === true
      })
      return `compact 成功；返回字段 [${Object.keys(res).join(',')}]；消息 ${items.length} 条（含疑似摘要 ${summaryLike.length} 条）；DB ${dbBefore}→${dbAfter} 保留；usage 字段 [${usageKeys}]`
    }, fails)
  }

  if (selected('CHAT-CMP-02')) {
    h.runCase(ev, 'CHAT-CMP-02', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const sk = h.createSession('cmp02 压缩后回忆')
      h.sendAndWait(sk, '请记住：我的幸运数字是 47。只回复"好"', { timeoutMs: TURN_TIMEOUT })
      seedTurns(sk, 2)
      h.compactContext(sk, 1)
      const r = h.sendAndWait(sk, '我的幸运数字是多少？', { timeoutMs: TURN_TIMEOUT })
      if (r.text.includes('47')) return `压缩后仍记得 47：「${r.text.slice(0, 40)}…」`
      const r2 = h.sendAndWait(sk, '再想想，我在对话开头告诉过你一个幸运数字。', { timeoutMs: TURN_TIMEOUT })
      if (r2.text.includes('47')) return '重试后回忆命中 47（soft, retried）'
      throw new Error(`压缩后丢失早期事实（soft）：「${r2.text.slice(0, 80)}」`)
    }, fails)
  }

  if (selected('CHAT-CMP-03')) {
    h.runCase(ev, 'CHAT-CMP-03', () => {
      const sk = cmp01Session ?? h.createSession('cmp03 usage')
      const u = h.contextUsage(sk)
      const used = u.usedTokens ?? u.used ?? u.tokens
      const window = u.contextWindow ?? u.window ?? u.maxTokens
      if (typeof used !== 'number') throw new Error(`usage 缺少 usedTokens 类字段: ${JSON.stringify(u).slice(0, 150)}`)
      if (typeof window !== 'number') throw new Error(`usage 缺少 contextWindow 类字段: ${JSON.stringify(u).slice(0, 150)}`)
      if (used <= 0) throw new Error(`usedTokens 异常: ${used}`)
      return `usedTokens=${used} contextWindow=${window}（字段: ${Object.keys(u).join(',')}）`
    }, fails)
  }

  let cmp04Session = null
  if (selected('CHAT-CMP-04')) {
    h.runCase(ev, 'CHAT-CMP-04', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const sk = h.createSession('cmp04 压缩后可用')
      cmp04Session = sk
      seedTurns(sk, 2)
      h.compactContext(sk, 2)
      const r = h.sendAndWait(sk, '请只回复两个字：继续', { timeoutMs: TURN_TIMEOUT })
      if (!r.text) throw new Error('压缩后会话不可用（无回复）')
      const dbCnt = h.dbCount('messages', 'conversation_id = ?', [sk])
      if (dbCnt < 3) throw new Error(`压缩后消息未继续落库: ${dbCnt}`)
      return `压缩后新回合正常（${(r.elapsedMs / 1000).toFixed(1)}s），DB 累计 ${dbCnt} 条`
    }, fails)
  }

  if (selected('CHAT-CMP-05')) {
    h.runCase(ev, 'CHAT-CMP-05', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const sk = h.createSession('cmp05 原文保留')
      h.sendAndWait(sk, '第 1 条：请只回复"甲"', { timeoutMs: TURN_TIMEOUT })
      h.sendAndWait(sk, '第 2 条：请只回复"乙"', { timeoutMs: TURN_TIMEOUT })
      const before = h.dbCount('messages', 'conversation_id = ?', [sk])
      h.compactContext(sk, 1)
      const after = h.dbCount('messages', 'conversation_id = ?', [sk])
      if (after < before) {
        throw new Error(`压缩后原文丢失: DB ${before} → ${after}`)
      }
      const roles = h.dbQuery('SELECT DISTINCT role FROM messages WHERE conversation_id = ?', sk)
      return `原文保留：DB ${before} → ${after}（roles: ${roles.map((r) => r.role).join(',')}）`
    }, fails)
  }

  if (selected('CHAT-CMP-06')) {
    h.runCase(ev, 'CHAT-CMP-06', () => {
      const sk = cmp04Session ?? h.createSession('cmp06 中止')
      const ab = h.ui(['context', 'abort', '--session', sk])
      const responded = ab.code === 0 || ab.json?.ok === false || ab.json?.error
      if (!responded) throw new Error(`context abort 无明确响应: code=${ab.code} out=${ab.out.slice(0, 120)}`)
      const items = h.fetchMessages(sk, 10)
      if (!Array.isArray(items)) throw new Error('中止后会话消息不可读')
      return `abort 明确响应（code=${ab.code}，${ab.json?.ok === false ? '拒绝语义' : '接受'}）；会话仍可读（${items.length} 条）`
    }, fails)
  }

  // 清理：CMP-02 的「幸运数字 47」可能经真实记忆提取链路写入全局记忆（链路证据），
  // 结束时应移除（仅删探针内容；测试期间新增的节整节移除；CHAT_NO_RESTORE=1 跳过）
  if (!NO_RESTORE) {
    const r = h.stripLinesFromFile(UM_PATH, (l) => l.includes('幸运数字') && l.includes('47'), {
      knownSections: h.sectionTitles(UM_SNAPSHOT),
    })
    if (r.changed) {
      ev.record('CLEANUP', 'INFO', `已从 user-memory.md 移除测试产物（幸运数字 47，${r.removed} 行）`)
    }
  }

  const summary = ev.writeReport({
    meta: { '回合超时': `${TURN_TIMEOUT}ms`, '用例过滤': ONLY || '（全部）' },
    extraSections: `
## 覆盖范围

- 手动 compact（CMP-01）、压缩后回忆（CMP-02）、usage 字段（CMP-03）、压缩后可用（CMP-04）、原文保留（CMP-05）、中止（CMP-06）
- 对应用例文档：chat-test-cases.md §三
- 说明：自动压缩触发需接近上下文窗口极限（成本高），由人工观察与 autonomous 套件覆盖（见用例文档「已知限制」）
`,
  })
  process.exit(summary.failed > 0 ? 1 : 0)
}

try {
  main()
} catch (err) {
  console.error(`\n套件异常中断: ${err.message}`)
  process.exit(1)
}
