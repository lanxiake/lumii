#!/usr/bin/env node
/**
 * F2 一键转交 端到端实测（临时脚本，验证后转正为套件用例）
 *
 * 阶段 A（后端链路）：主助手接开发请求 → propose_dev_handoff 提案 → CLI confirm →
 *   新建开发会话 + 任务消息 + 走 Agent 绑定（claude + 沙箱 workspace）执行 → 沙箱文件被修复
 * 阶段 B（UI 卡片）：发第二条 → 截图找「交给灵栖开发」按钮 → 真实点击 → 断言执行
 *
 * 前提：code-dev 的 Agent 绑定已配置（claude + E:/testsoft/Lumii-data/handoff-demo）
 */

import * as h from '../lib/cli-harness.mjs'

const PREFIX = '[f2-handoff]'
const PAGER = 'E:/testsoft/Lumii-data/handoff-demo/pager.js'
const TASK =
  'handoff-demo 这个项目里 pager.js 的分页算错了：11 条数据每页 5 条应该是 3 页，现在只算出 2 页。帮我修一下总页数计算，改完在项目里验证。'

function waitTurnDone(sk, text, timeoutMs) {
  const base = h.lastAssistant(sk, 60)
  const baseId = base?.id ?? null
  h.send(sk, text)
  const start = Date.now()
  let lastText = ''
  while (Date.now() - start < timeoutMs) {
    h.sleep(3000)
    const cur = h.lastAssistant(sk, 60)
    if (!cur || cur.id === baseId) continue
    const t = h.assistantText(cur) || ''
    const streaming = h.dbGet('SELECT is_streaming FROM messages WHERE id = ?', cur.id)?.is_streaming
    if (streaming === 0) {
      const cur2 = h.lastAssistant(sk, 60)
      if (cur2?.id === cur.id) return { text: h.assistantText(cur2) || t, elapsedMs: Date.now() - start }
    }
    lastText = t
  }
  return { text: lastText, elapsedMs: Date.now() - start, timedOut: true }
}

function findPropose(items) {
  for (const it of items) {
    const cj = h.parseContentJson(it)
    for (const p of cj?.parts ?? []) {
      if (p?.type === 'tool' && p?.name === 'propose_dev_handoff') return p
    }
  }
  return null
}

function handoffIdOf(part) {
  try {
    const txt = part?.result?.content?.[0]?.text
    if (typeof txt !== 'string') return null
    const j = JSON.parse(txt)
    return typeof j.handoffId === 'string' ? j.handoffId : null
  } catch {
    return null
  }
}

const pagerBefore = h.fileRead(PAGER)
console.log('沙箱 pager.js 现状（前 200 字）:', (pagerBefore || '(不可读)').slice(0, 200))

// ── 阶段 A：后端链路 ──────────────────────────────
console.log('\n=== 阶段 A：主助手提案 → CLI confirm → 开发会话直达 claude ===')
const sk = h.createSession('F2 转交实测', { prefix: PREFIX })
console.log('主助手会话:', sk)
const cursor = h.logCursor()

const t1 = waitTurnDone(sk, TASK, 300000)
console.log(`主助手回合 ${Math.round(t1.elapsedMs / 1000)}s；回复前 500 字：`)
console.log((t1.text || '').slice(0, 500))

const proposePart = findPropose(h.fetchMessages(sk, 60))
console.log('propose 工具调用:', proposePart ? '有' : '无')
if (proposePart) {
  console.log('  args:', JSON.stringify(proposePart.args).slice(0, 300))
  console.log('  status:', proposePart.status)
}
const handoffId = handoffIdOf(proposePart)
console.log('handoffId:', handoffId)

const listBefore = h.dbQuery(
  "SELECT c.id FROM conversations c JOIN conversation_participants p ON p.conversation_id=c.id WHERE p.participant_id='code-dev'",
).map((r) => r.id)

if (handoffId) {
  const r = h.okJson(
    h.ui(['command', 'handoff:confirm', '--data', JSON.stringify({ handoffId })]),
    'handoff:confirm',
  )
  console.log('confirm 返回:', JSON.stringify(r))

  if (r.ok && r.sessionKey) {
    // 新开发会话的启动证据
    h.sleep(4000)
    const items = h.fetchMessages(r.sessionKey, 20)
    console.log('开发会话消息数:', items.length, '（会话:', r.sessionKey, '标题:', r.title, '）')
    for (const it of items) console.log('  -', it.role, (h.messageText(it) || '').slice(0, 120))

    const lines = h.logSince(cursor, /handoff:confirm|ACP 路径|user:send/)
    console.log('=== 日志证据 ===')
    for (const l of lines.slice(-15)) console.log(String(l).slice(0, 300))

    if (!listBefore.includes(r.sessionKey)) console.log('（新会话已创建 ✔）')
  }
}

// ── 等待 claude 完成修复 ──────────────────────────
console.log('\n=== 等待开发任务完成（轮询 pager.js）===')
const fixed = h.pollUntil(
  () => {
    const now = h.fileRead(PAGER) || ''
    return /Math\.ceil/.test(now) ? now : null
  },
  240000,
  5000,
)
console.log(fixed ? '✅ pager.js 已修复（含 Math.ceil）' : '❌ 240s 内未观察到修复')
console.log('修复后 pager.js（前 400 字）:', (fixed || h.fileRead(PAGER) || '').slice(0, 400))
