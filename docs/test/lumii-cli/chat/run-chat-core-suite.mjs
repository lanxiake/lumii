#!/usr/bin/env node
/**
 * 聊天核心套件（L3 真实聊天模拟）— CHAT-CORE-01..08
 *
 * 用例文档：docs/test/lumii-cli/chat/chat-test-cases.md
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 * 用法：node docs/test/lumii-cli/chat/run-chat-core-suite.mjs
 *
 * 环境变量：CHAT_ONLY（ID 前缀过滤）、CHAT_SKIP_LLM=1（跳过 LLM 用例）、
 *          CHAT_TURN_TIMEOUT_MS（单回合超时，默认 180000）
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

const ev = h.createEvidence(__dirname, 'chat-core-suite', '聊天核心套件')
const fails = { count: 0 }
const selected = (id) => !ONLY || id.startsWith(ONLY)
/** user-memory.md 测试前快照（用于清理提取产物时区分「新增节」） */
const UM_SNAPSHOT = h.fileRead(UM_PATH)

function main() {
  console.log('聊天核心套件（真实客户端 + 真实 LLM）\n')

  const pf = h.preflight()
  if (!pf.ok) {
    console.error('❌ 预检失败：')
    for (const p of pf.problems) console.error(`  - ${p}`)
    process.exit(3)
  }
  for (const w of pf.warnings) console.warn(`⚠️  ${w}`)
  ev.record('PREFLIGHT', 'INFO', '预检通过')

  if (selected('CHAT-CORE-01')) {
    h.runCase(ev, 'CHAT-CORE-01', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const sk = h.createSession('core01 发送持久化')
      const r = h.sendAndWait(sk, '请只回复两个字：收到', { timeoutMs: TURN_TIMEOUT })
      const items = h.fetchMessages(sk, 10)
      const roles = items.map((i) => i.role).filter((r) => r)
      const hasUser = roles.includes('user')
      const hasAssistant = roles.includes('assistant')
      if (!hasUser || !hasAssistant) throw new Error(`消息角色缺失: ${roles.join(',')}`)
      if (!r.text) throw new Error('assistant 回复为空')
      const dbCnt = h.dbCount('messages', 'conversation_id = ?', [sk])
      if (dbCnt < 2) throw new Error(`DB messages 计数异常: ${dbCnt}`)
      return `回合 ${(r.elapsedMs / 1000).toFixed(1)}s，消息 ${items.length} 条，DB ${dbCnt} 条，回复「${r.text.slice(0, 20)}…」`
    }, fails)
  }

  if (selected('CHAT-CORE-02')) {
    h.runCase(ev, 'CHAT-CORE-02', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const sk = h.createSession('core02 多轮上下文')
      h.sendAndWait(sk, '请记住：我的幸运数字是 47。只回复"好的"', { timeoutMs: TURN_TIMEOUT })
      h.sendAndWait(sk, '今天天气不错。只回复"嗯"', { timeoutMs: TURN_TIMEOUT })
      const r3 = h.sendAndWait(sk, '我的幸运数字是多少？', { timeoutMs: TURN_TIMEOUT })
      if (r3.text.includes('47')) return `第 3 轮回复包含 47：「${r3.text.slice(0, 40)}…」`
      const r4 = h.sendAndWait(sk, '再想想，我之前明确告诉过你我的幸运数字，是多少？', { timeoutMs: TURN_TIMEOUT })
      if (r4.text.includes('47')) return `重试后回复包含 47（soft, retried）`
      throw new Error(`多轮上下文丢失：第 3/4 轮均未提及 47（soft）。3轮:「${r3.text.slice(0, 60)}」4轮:「${r4.text.slice(0, 60)}」`)
    }, fails)
  }

  if (selected('CHAT-CORE-03')) {
    h.runCase(ev, 'CHAT-CORE-03', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const sk = h.createSession('core03 编辑消息')
      h.sendAndWait(sk, '原始消息：香蕉', { timeoutMs: TURN_TIMEOUT })
      const u = h.lastUser(sk, 10)
      if (!u) throw new Error('未找到 user 消息')
      h.editMessage(sk, u.id, '编辑后消息：苹果')
      const edited = h.pollUntil(() => {
        const items = h.fetchMessages(sk, 10)
        const msg = items.find((i) => i.id === u.id)
        return msg && h.messageText(msg).includes('苹果')
      }, 15000, 1500)
      if (!edited) throw new Error('编辑未落库：消息内容未变为「苹果」')
      return `消息 ${u.id.slice(0, 8)} 编辑落库成功`
    }, fails)
  }

  if (selected('CHAT-CORE-04')) {
    h.runCase(ev, 'CHAT-CORE-04', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const sk = h.createSession('core04 编辑重发')
      h.sendAndWait(sk, '你好', { timeoutMs: TURN_TIMEOUT })
      const u = h.lastUser(sk, 10)
      if (!u) throw new Error('未找到 user 消息')
      const baseAssistant = h.lastAssistant(sk, 10)
      const baseId = baseAssistant?.id ?? null
      h.resendMessage(sk, u.id, '你好，请只回复两个字：世界')
      const newReply = h.pollUntil(() => {
        const cur = h.lastAssistant(sk, 10)
        return cur && cur.id !== baseId && h.assistantText(cur) ? cur : null
      }, TURN_TIMEOUT, 2500)
      if (!newReply) throw new Error('重发后未产生新回复')
      return `重发触发新回复：「${h.assistantText(newReply).slice(0, 30)}…」`
    }, fails)
  }

  if (selected('CHAT-CORE-05')) {
    h.runCase(ev, 'CHAT-CORE-05', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const sk = h.createSession('core05 中止回复')
      // 短生成请求：abort 是尽力而为语义，不假设生成立即停止（见用例文档说明）
      h.send(sk, '请写一段关于海洋的短文，大约 300 字')
      h.sleep(2500)
      const ab = h.abortSend(sk)
      if (ab.code !== 0 || ab.json?.ok === false) {
        throw new Error(`abort 未被接受: code=${ab.code} ${JSON.stringify(ab.json).slice(0, 120)}`)
      }
      // 等会话安静（abort 后生成可能继续完成并排队后续消息）：连续 3 次轮询无变化
      let lastSig = null
      let stable = 0
      h.pollUntil(() => {
        const items = h.fetchMessages(sk, 10)
        const lastMsg = items[items.length - 1]
        const sig = `${items.length}|${h.messageText(lastMsg ?? {}).length}`
        if (sig === lastSig) stable++
        else {
          stable = 0
          lastSig = sig
        }
        return stable >= 2
      }, 120000, 5000)
      // abort 后会话应保持可用：新消息能获得回复（排队语义：窗口放宽到 240s）
      const r = h.sendAndWait(sk, '只回复两个字：继续', { timeoutMs: 240000 })
      if (!r.text) throw new Error('中止后会话不可用（后续回合无回复）')
      return `abort 接受且会话可用，后续回复「${r.text.slice(0, 20)}…」（中止为尽力而为语义，前序生成可能完成）`
    }, fails)
  }

  if (selected('CHAT-CORE-06')) {
    h.runCase(ev, 'CHAT-CORE-06', () => {
      if (SKIP_LLM) throw new Error('SKIP: CHAT_SKIP_LLM=1')
      const a = h.createSession('core06-A')
      const b = h.createSession('core06-B')
      h.sendAndWait(a, '菠萝是黄色的。只回复"好"', { timeoutMs: TURN_TIMEOUT })
      h.sendAndWait(b, '哈密瓜是绿色的。只回复"好"', { timeoutMs: TURN_TIMEOUT })
      const aText = h.fetchMessages(a, 20).map((i) => h.messageText(i)).join('\n')
      const bText = h.fetchMessages(b, 20).map((i) => h.messageText(i)).join('\n')
      if (aText.includes('哈密瓜')) throw new Error('会话 A 串入了会话 B 的内容（哈密瓜）')
      if (bText.includes('菠萝')) throw new Error('会话 B 串入了会话 A 的内容（菠萝）')
      return '双会话消息完全隔离'
    }, fails)
  }

  if (selected('CHAT-CORE-07')) {
    h.runCase(ev, 'CHAT-CORE-07', () => {
      const sk = h.createSession('core07 参数错误')
      const before = h.fetchMessages(sk, 10).length
      const r1 = h.ui(['send'])
      const r2 = h.ui(['send', '--session', sk])
      const after = h.fetchMessages(sk, 10).length
      if (r1.code === 0) throw new Error('send 缺 --session 未报错')
      if (r2.code === 0) throw new Error('send 缺文本未报错')
      if (after !== before) throw new Error(`参数错误产生了副作用（消息 ${before} → ${after}）`)
      return `两个错误场景均正确拒绝（退出码 ${r1.code}/${r2.code}），无副作用`
    }, fails)
  }

  if (selected('CHAT-CORE-08')) {
    h.runCase(ev, 'CHAT-CORE-08', () => {
      const sk = h.createSession('core08 会话列表')
      const r = h.okJson(h.ui(['conversation', 'list']), 'conversation list')
      const convs = Array.isArray(r.conversations) ? r.conversations : Array.isArray(r) ? r : []
      const found = convs.some((c) => (c.sessionKey ?? c.id) === sk || (c.title || '').includes('core08'))
      if (!found) throw new Error(`会话列表未包含探针会话（返回 ${convs.length} 个）`)
      return `会话列表包含探针标题（共 ${convs.length} 个会话）`
    }, fails)
  }

  // 清理：CORE-02 的「幸运数字 47」可能经真实记忆提取链路写入全局记忆（链路正确工作的证据），
  // 但它是测试产物，结束时应移除（仅删探针行，不整文件恢复；CHAT_NO_RESTORE=1 跳过）
  if (!NO_RESTORE) {
    const r = h.stripLinesFromFile(
      UM_PATH,
      (l) => l.includes('幸运数字') && l.includes('47'),
      { knownSections: h.sectionTitles(UM_SNAPSHOT) },
    )
    if (r.changed) {
      ev.record('CLEANUP', 'INFO', `已从 user-memory.md 移除测试产物（幸运数字 47，${r.removed} 行）`)
    }
  } else {
    ev.record('CLEANUP', 'INFO', 'CHAT_NO_RESTORE=1，保留测试产物供人工检查')
  }

  const summary = ev.writeReport({
    meta: { '回合超时': `${TURN_TIMEOUT}ms`, '用例过滤': ONLY || '（全部）' },
    extraSections: `
## 覆盖范围

- 发送→回复→持久化、多轮上下文、编辑、重发、中止、双会话隔离、参数错误、会话列表
- 对应用例文档：chat-test-cases.md §一
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
