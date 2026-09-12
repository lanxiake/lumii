/**
 * cli-harness — chat 套件共享库（L3 真实聊天模拟）
 *
 * 规范：docs/test/lumii-cli/CLI-TEST-SPEC.md
 * 用途：通过 lumii-ui CLI 驱动真实运行的 Lumii 客户端（真实会话 + 真实 LLM），
 *       提供会话驱动、回合等待、DB 只读查询、日志游标、证据与报告等公共能力。
 *
 * 边界：仅供 docs/test/lumii-cli/chat/* 使用；历史脚本按需逐步迁移，禁止复制本库 helper。
 */

import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根（lib/ 上溯四层：lib → lumii-cli → test → docs → repo） */
export const ROOT = path.resolve(__dirname, '../../../..')
export const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')

/**
 * 应用实时日志：~/.lumii/logs/app/mtbot-<date>.log（按天文件，取修改时间最新的一个）。
 * 注意：仓库根的 .lumii-dev.log 可能是历史遗留文件、内容停滞，不可用于断言（2026-09-12 实测确认）。
 */
function findAppLog() {
  const dir = path.join(os.homedir(), '.lumii', 'logs', 'app')
  try {
    let best = null
    for (const f of fs.readdirSync(dir)) {
      if (!/^mtbot-.*\.log$/.test(f)) continue
      const full = path.join(dir, f)
      const m = fs.statSync(full).mtimeMs
      if (!best || m > best.m) best = { full, m }
    }
    return best?.full ?? null
  } catch {
    return null
  }
}
export const DEV_LOG = process.env.LUMII_DEV_LOG || findAppLog()

function resolveDataRoot() {
  const env = process.env.LUMII_CLIENT_DATA_DIR?.trim()
  if (env) return path.resolve(env.startsWith('~') ? env.replace(/^~/, os.homedir()) : env)
  return path.join(os.homedir(), '.lumii')
}

export const DATA_ROOT = resolveDataRoot()
export const DATA_DIR = path.join(DATA_ROOT, 'data')
export const DB_PATH = path.join(DATA_DIR, 'agent-runtime.db')

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// ────────────────────────────────────────────────
// 基础：CLI 调用与断言
// ────────────────────────────────────────────────

/**
 * 调用 lumii-ui；rate_limited 自动退避重试。
 * @returns {{code:number, json:any|null, out:string, stderr:string}}
 */
export function ui(args, { retries = 6, timeoutMs } = {}) {
  let last = { code: 1, json: null, out: '', stderr: '' }
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 40 * 1024 * 1024,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    })
    const out = r.stdout || ''
    const stderr = r.stderr || ''
    let json = null
    const trimmed = out.trim()
    if (trimmed) {
      try {
        json = JSON.parse(trimmed)
      } catch {
        /* 非 JSON 输出保留在 out */
      }
    }
    last = { code: r.status ?? 1, json, out, stderr }
    if (json?.error !== 'rate_limited' && !/rate_limited/.test(out)) return last
    sleep(Math.min(20000, 5000 * (i + 1)))
  }
  return last
}

/** 三重校验：退出码 0 + 有 JSON + 控制口未拒绝（ok === false） */
export function okJson(r, label) {
  assert(r.code === 0, `${label} 退出码 ${r.code}: ${(r.out + r.stderr).slice(0, 300)}`)
  assert(r.json, `${label} 未返回 JSON: ${(r.out + r.stderr).slice(0, 300)}`)
  assert(r.json.ok !== false, `${label} 控制口拒绝: ${JSON.stringify(r.json).slice(0, 300)}`)
  return r.json
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** 轮询直到 predicate 为真或超时；返回最终判定值 */
export function pollUntil(predicate, timeoutMs, intervalMs = 2500) {
  const start = Date.now()
  let v = predicate()
  while (!v && Date.now() - start < timeoutMs) {
    sleep(intervalMs)
    v = predicate()
  }
  return v
}

// ────────────────────────────────────────────────
// 会话与回合
// ────────────────────────────────────────────────

/** 创建探针会话；标题带 [chat-suite] 前缀 */
export function createSession(title, { prefix = '[chat-suite]' } = {}) {
  const c = okJson(ui(['conversation', 'create', '--title', `${prefix} ${title}`]), 'conversation create')
  const sk = c.sessionKey ?? c.id
  assert(sk, `conversation create 未返回 sessionKey: ${JSON.stringify(c).slice(0, 200)}`)
  return sk
}

/** 发送消息；返回 runId */
export function send(sk, text) {
  const r = okJson(ui(['send', '--session', sk, '--text', text]), 'send')
  assert(r.runId, `send 未返回 runId: ${JSON.stringify(r).slice(0, 200)}`)
  return r.runId
}

/** 读取会话消息 items（{id, role, content, contentJson, toolCalls[], ...}） */
export function fetchMessages(sk, limit = 30) {
  const r = okJson(ui(['context', 'messages', '--session', sk, '--limit', String(limit)]), 'context messages')
  return Array.isArray(r.items) ? r.items : []
}

/** 解析 contentJson（CLI 返回为 JSON 字符串；assistant 含 parts[]，user 为 {type:'text',text}） */
export function parseContentJson(item) {
  let cj = item?.contentJson
  if (typeof cj === 'string') {
    try {
      cj = JSON.parse(cj)
    } catch {
      return null
    }
  }
  return cj && typeof cj === 'object' ? cj : null
}

/** 提取 assistant 消息正文（优先 contentJson.parts 的 text part，回退 content） */
export function assistantText(item) {
  const cj = parseContentJson(item)
  const parts = cj?.parts
  if (Array.isArray(parts)) {
    const text = parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim()
    if (text) return text
    const anyText = parts
      .filter((p) => p && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim()
    if (anyText) return anyText
  }
  if (cj?.type === 'text' && typeof cj.text === 'string') return cj.text
  if (Array.isArray(item?.content)) {
    return item.content
      .filter((p) => p?.type === 'text')
      .map((p) => p.text ?? '')
      .join('')
      .trim()
  }
  return typeof item?.content === 'string' ? item.content : ''
}

/** 通用消息文本提取（user/assistant 均适用） */
export function messageText(item) {
  return assistantText(item)
}

/** 会话内最新一条 assistant 消息（无则 null） */
export function lastAssistant(sk, limit = 30) {
  const items = fetchMessages(sk, limit)
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.role === 'assistant') return items[i]
  }
  return null
}

/** 会话最新一条 user 消息（send edit/resend 需要 messageId） */
export function lastUser(sk, limit = 30) {
  const items = fetchMessages(sk, limit)
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.role === 'user') return items[i]
  }
  return null
}

/**
 * 发送并等待回合完成。
 * 判定：出现新的 assistant 消息（id 不同于基线）且内容在两次轮询间稳定。
 * @returns {{assistant:object, text:string, elapsedMs:number}}
 */
export function sendAndWait(sk, text, { timeoutMs = 180000, pollMs = 2500, limit = 30 } = {}) {
  const base = lastAssistant(sk, limit)
  const baseId = base?.id ?? null
  const start = Date.now()
  send(sk, text)

  let prevText = null
  let stableHits = 0
  while (Date.now() - start < timeoutMs) {
    sleep(pollMs)
    const cur = lastAssistant(sk, limit)
    if (cur && cur.id !== baseId) {
      const t = assistantText(cur)
      if (t && t === prevText) {
        stableHits++
        if (stableHits >= 2) return { assistant: cur, text: t, elapsedMs: Date.now() - start }
      } else {
        stableHits = 0
        prevText = t
      }
    }
  }
  throw new Error(`回合等待超时（${timeoutMs}ms）：会话 ${sk} 未等到新的 assistant 消息`)
}

export function editMessage(sk, messageId, newText) {
  return okJson(ui(['send', 'edit', '--session', sk, '--message', messageId, '--text', newText]), 'send edit')
}

export function resendMessage(sk, messageId, newText) {
  return okJson(ui(['send', 'resend', '--session', sk, '--message', messageId, '--text', newText]), 'send resend')
}

export function abortSend(sk) {
  return ui(['send', 'abort', '--session', sk])
}

export function compactContext(sk, keep) {
  const args = ['context', 'compact', '--session', sk]
  if (keep !== undefined) args.push('--keep', String(keep))
  return okJson(ui(args, { timeoutMs: 180000 }), 'context compact')
}

export function contextUsage(sk) {
  return okJson(ui(['context', 'usage', '--session', sk]), 'context usage')
}

// ────────────────────────────────────────────────
// 数据库（默认只读）
// ────────────────────────────────────────────────

function openDb(readOnly = true) {
  return new DatabaseSync(DB_PATH, { readOnly })
}

/** SELECT 查询；返回行数组 */
export function dbQuery(sql, ...params) {
  const db = openDb(true)
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

/** SELECT 单行 */
export function dbGet(sql, ...params) {
  const db = openDb(true)
  try {
    return db.prepare(sql).get(...params)
  } finally {
    db.close()
  }
}

/** 计数快捷方式 */
export function dbCount(table, where = '1=1', params = []) {
  return dbGet(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`, ...params)?.c ?? 0
}

// ────────────────────────────────────────────────
// 文件与日志
// ────────────────────────────────────────────────

export function fileRead(p) {
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

export function fileExists(p) {
  return fs.existsSync(p)
}

export function fileMtime(p) {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 按行过滤文本文件的探针内容（测试产物清理）。
 *
 * 策略（保守 + 彻底）：
 * - 提供 knownSections（测试前快照中已有的 `## ` 标题集合）时：测试期间**新增**的、且含匹配行的节整节移除
 *   （提取链路写入的条目可能是多行 `- 规则/原因/应用` 结构，仅删匹配行会残留同条目其余行）
 * - 其余情况只删匹配行；因此变空的节整节移除
 * - 只按上述规则重写，不整文件恢复——避免覆盖应用/用户期间的新写入
 * @returns {{changed:boolean, removed:number}}
 */
export function stripLinesFromFile(filePath, predicate, { knownSections } = {}) {
  const content = fileRead(filePath)
  if (content === null) return { changed: false, removed: 0 }
  const lines = content.split(/\r?\n/)

  // 按 `## ` 分节
  const sections = []
  let cur = { title: null, body: [] }
  for (const line of lines) {
    const m = /^##[ \t]+(.+)$/.exec(line)
    if (m) {
      sections.push(cur)
      cur = { title: m[1].trim(), body: [] }
    } else {
      cur.body.push(line)
    }
  }
  sections.push(cur)

  const known = knownSections ? new Set(knownSections) : null
  let removed = 0
  const rebuilt = []
  for (const s of sections) {
    const hits = s.body.filter((l) => predicate(l))
    const isNewSection = s.title !== null && known !== null && !known.has(s.title)
    let body
    if (hits.length > 0 && isNewSection) {
      body = [] // 测试期间新增的节整节移除
    } else {
      body = s.body.filter((l) => !predicate(l))
    }
    removed += s.body.length - body.length
    if (!body.some((l) => l.trim() !== '')) continue // 空节（含原本就空的）丢弃
    const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    rebuilt.push(s.title === null ? text : `## ${s.title}\n\n${text}`)
  }

  if (removed === 0) return { changed: false, removed: 0 }
  const out = rebuilt.join('\n\n').trim() + '\n'
  fs.writeFileSync(filePath, out, 'utf-8')
  return { changed: true, removed }
}

/** 提取 markdown 中 `## ` 标题集合（用于 stripLinesFromFile 的 knownSections） */
export function sectionTitles(content) {
  if (!content) return []
  return content
    .split(/\r?\n/)
    .map((l) => /^##[ \t]+(.+)$/.exec(l)?.[1]?.trim())
    .filter(Boolean)
}

/** 日志游标：记录文件路径与当前行数（配合 logSince 用） */
export function logCursor() {
  if (!DEV_LOG || !fs.existsSync(DEV_LOG)) return null
  const content = fs.readFileSync(DEV_LOG, 'utf-8')
  return { path: DEV_LOG, lines: content.split(/\r?\n/).length }
}

/** 返回 cursor 之后匹配 regex 的行（cursor 为 null 时返回 []；跨天/文件缺失时回退到当前日志全量） */
export function logSince(cursor, regex) {
  if (!cursor) return []
  let content = fileRead(cursor.path)
  if (content === null) content = fileRead(DEV_LOG)
  if (content === null) return []
  const lines = content.split(/\r?\n/)
  return lines.slice(Math.min(cursor.lines, lines.length)).filter((l) => regex.test(l))
}

/** 日志通道是否可用（日志文件缺失时注入类断言降级为 SKIP） */
export function logChannelAvailable() {
  return Boolean(DEV_LOG) && fs.existsSync(DEV_LOG)
}

// ────────────────────────────────────────────────
// 证据与报告
// ────────────────────────────────────────────────

/**
 * 创建证据记录器：启动时 truncate 旧文件，逐条追加 JSONL。
 * @param {string} suiteDir 套件所在目录（产物写入此处）
 * @param {string} suiteName 套件名（如 chat-core-suite）
 * @param {string} label 显示名（如「聊天核心套件」）
 */
export function createEvidence(suiteDir, suiteName, label) {
  const evidencePath = path.join(suiteDir, `${suiteName}-evidence.jsonl`)
  const reportPath = path.join(suiteDir, `${suiteName}-report.md`)
  if (fs.existsSync(evidencePath)) fs.unlinkSync(evidencePath)

  const results = []
  const startedAt = new Date().toISOString()

  function record(id, status, note, extra = {}) {
    const row = { ts: new Date().toISOString(), id, status, note, ...extra }
    results.push(row)
    fs.appendFileSync(evidencePath, JSON.stringify(row) + '\n', 'utf8')
    const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : status === 'SKIP' ? '⏭️' : 'ℹ️'
    console.log(`${icon} [${id}] ${status} — ${note}`)
    return row
  }

  function writeReport({ extraSections = '', meta = {} } = {}) {
    const finishedAt = new Date().toISOString()
    const cases = results.filter((r) => !['INFO'].includes(r.status))
    const passed = cases.filter((r) => r.status === 'PASS').length
    const failed = cases.filter((r) => r.status === 'FAIL').length
    const skipped = cases.filter((r) => r.status === 'SKIP').length
    const total = cases.length
    const rate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0'

    const metaLines = Object.entries(meta)
      .map(([k, v]) => `- **${k}**: ${v}`)
      .join('\n')

    const report = `# ${label} 测试报告

- **生成时间**: ${finishedAt}（开始 ${startedAt}）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: ${DB_PATH}
${metaLines}

## 概要

| 指标 | 值 |
|---|---|
| 总数 | ${total} |
| 通过 | ${passed} |
| 失败 | ${failed} |
| 跳过 | ${skipped} |
| 通过率 | ${rate}% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
${cases.map((r) => `| ${r.id} | ${r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭️'} | ${(r.note || '').replace(/\|/g, '\\|')} | ${r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '-'} |`).join('\n')}

## 失败与跳过明细

${
  cases.filter((r) => r.status === 'FAIL' || r.status === 'SKIP').length === 0
    ? '无。'
    : cases
        .filter((r) => r.status === 'FAIL' || r.status === 'SKIP')
        .map((r) => `- **${r.id}** ${r.status}: ${r.note}${r.stack ? `\n  \`\`\`\n  ${String(r.stack).slice(0, 500)}\n  \`\`\`` : ''}`)
        .join('\n')
}
${extraSections}

## 证据

逐条原始证据见 [${suiteName}-evidence.jsonl](./${suiteName}-evidence.jsonl)。
`
    fs.writeFileSync(reportPath, report, 'utf8')
    console.log(`\n📄 报告: ${reportPath}`)
    console.log(`📋 证据: ${evidencePath}`)
    console.log(`\n通过 ${passed}/${total}（${rate}%），失败 ${failed}，跳过 ${skipped}`)
    return { passed, failed, skipped, total }
  }

  return { record, writeReport, results, evidencePath, reportPath }
}

/**
 * 运行单个用例：捕获异常记 FAIL，控制 3 连 FAIL 终止。
 * @returns {boolean} 是否继续后续用例
 */
export function runCase(ev, id, fn, { fails } = {}) {
  const start = Date.now()
  try {
    const note = fn()
    if (fails) fails.count = 0
    ev.record(id, 'PASS', note ?? 'ok', { durationMs: Date.now() - start })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('SKIP:')) {
      if (fails) fails.count = 0
      ev.record(id, 'SKIP', msg.slice(5).trim(), { durationMs: Date.now() - start })
      return true
    }
    ev.record(id, 'FAIL', msg, {
      durationMs: Date.now() - start,
      stack: err instanceof Error ? err.stack : undefined,
    })
    if (fails) {
      fails.count++
      if (fails.count >= 3) {
        console.error('⛔ 连续 3 个用例失败，提前终止套件（请检查环境）')
        return false
      }
    }
  }
  return true
}

// ────────────────────────────────────────────────
// 预检
// ────────────────────────────────────────────────

/**
 * 预检：控制口可达 + CLI 可用 + 日志通道 + 关键工具。
 * @returns {{ok:boolean, problems:string[], warnings:string[]}}
 */
export function preflight() {
  const problems = []
  const warnings = []

  if (!fs.existsSync(LUMII_UI)) problems.push(`CLI 不存在: ${LUMII_UI}`)
  if (!fs.existsSync(DB_PATH)) warnings.push(`数据库不存在: ${DB_PATH}`)

  const ping = ui(['help'])
  if (ping.code === 3 || /app_not_running|connection_failed/.test(ping.out)) {
    problems.push('Lumii 应用未运行或控制口不可达（请先 pnpm dev / 启动应用）')
  }

  if (!logChannelAvailable()) {
    warnings.push(`日志通道不可用（${DEV_LOG} 不存在，套餐/打包版）：注入类断言将降级为 SKIP`)
  }

  return { ok: problems.length === 0, problems, warnings }
}
