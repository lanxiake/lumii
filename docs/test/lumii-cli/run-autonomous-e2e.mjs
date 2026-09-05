#!/usr/bin/env node
/**
 * 自主进化真实对话 E2E 测试
 *
 * 与 run-autonomous-cli-suite.mjs 的区别：那份是「播种 + 回读」，
 * 只验证 CLI→Repo→SQLite 的读写链路；本脚本驱动**真实用户对话**，
 * 验证引擎接线（回合结束 → 满意度评分 → 能力追踪 → Prompt 进化反馈 → 反思），
 * 即运行时真正触发的那条链路。
 *
 * 用法: node docs/test/lumii-cli/run-autonomous-e2e.mjs
 * 前置: pnpm dev 已启动（~/.lumii/runtime/app-ui.json 可读），且 chat 模型已配置。
 *
 * 环境变量:
 * - E2E_TIMEOUT_MS  回合等待上限（默认 120000）
 * - E2E_SKIP_REFLECT=1  跳过反思（避免真实 LLM 调用）
 */

import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const DB_PATH = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')

const TURN_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 120000
const SKIP_REFLECT = process.env.E2E_SKIP_REFLECT === '1'

const results = []

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 调用 lumii-ui；返回 { code, json } */
function ui(args, { retries = 6 } = {}) {
  let last = { code: 1, json: null, out: '' }
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    })
    const out = (r.stdout || '') + (r.stderr || '')
    let json = null
    const trimmed = (r.stdout || '').trim()
    if (trimmed) {
      try {
        json = JSON.parse(trimmed)
      } catch {
        /* 非 JSON 保留在 out */
      }
    }
    last = { code: r.status ?? 1, json, out }
    if (json?.error !== 'rate_limited' && !/rate_limited/.test(out)) return last
    sleep(Math.min(20000, 5000 * (i + 1)))
  }
  return last
}

function withDb(fn) {
  const db = new DatabaseSync(DB_PATH)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function record(id, status, note) {
  results.push({ id, status, note })
  const icon = status === 'PASS' ? 'PASS' : 'FAIL'
  console.log(`[${id}] ${icon} — ${note}`)
}

function okJson(r, label) {
  assert(r.code === 0, `${label} 退出码 ${r.code}: ${r.out.slice(0, 300)}`)
  assert(r.json, `${label} 未返回 JSON: ${r.out.slice(0, 300)}`)
  assert(r.json.ok !== false, `${label} 控制口拒绝: ${JSON.stringify(r.json).slice(0, 300)}`)
  return r.json
}

function count(table, where = '1=1', args = []) {
  return withDb((db) => db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args).c)
}

/** 轮询直到 predicate 为真或超时；返回是否命中 */
function pollUntil(predicate, timeoutMs, intervalMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    sleep(intervalMs)
  }
  return predicate()
}

// ==================== 用例 ====================

function run() {
  console.log('自主进化真实对话 E2E 测试\n')
  assert(fs.existsSync(DB_PATH), `数据库不存在: ${DB_PATH}`)
  assert(fs.existsSync(LUMII_UI), `CLI 不存在: ${LUMII_UI}`)

  // 记录基线计数
  const baseScores = count('autonomous_satisfaction_scores')
  const baseCaps = count('capability_dimensions')
  const baseReflections = count('reflections')
  const baseVariantTrials = withDb((db) =>
    db.prepare('SELECT COALESCE(SUM(trial_count),0) s FROM prompt_variants').get().s,
  )
  console.log(`基线: scores=${baseScores} caps=${baseCaps} reflections=${baseReflections} variantTrials=${baseVariantTrials}\n`)

  // ---- T1: 真实对话触发回合结束管道 ----
  const conv = okJson(ui(['conversation', 'create', '--title', '自主进化E2E']), 'conversation create')
  const sessionKey = conv.sessionKey ?? conv.id
  assert(sessionKey, `conversation create 未返回 sessionKey: ${JSON.stringify(conv).slice(0, 200)}`)
  record('T1.0', 'PASS', `创建会话 sessionKey=${sessionKey.slice(0, 12)}…`)

  // 触发工具调用的消息（list_dir/glob 等 → 能力追踪有数据）
  const send = okJson(
    ui(['send', '--session', sessionKey, '--text', '请用工具列出当前工作目录下的所有文件，并统计数量']),
    'send',
  )
  assert(send.runId, `send 未返回 runId: ${JSON.stringify(send).slice(0, 200)}`)
  record('T1.1', 'PASS', `已发送消息 runId=${send.runId}`)

  // 等待回合结束：满意度评分落库
  const scoreWritten = pollUntil(
    () => count('autonomous_satisfaction_scores') > baseScores,
    TURN_TIMEOUT_MS,
  )
  assert(scoreWritten, `回合结束后满意度评分未落库（等了 ${TURN_TIMEOUT_MS}ms）`)

  const latestScore = withDb((db) =>
    db.prepare('SELECT overall_score, task_completion, user_feedback, efficiency, agent_id FROM autonomous_satisfaction_scores ORDER BY created_at DESC LIMIT 1').get(),
  )
  assert(
    latestScore.overall_score >= 0 && latestScore.overall_score <= 1,
    `overall_score 越界: ${latestScore.overall_score}`,
  )
  record('T1.2', 'PASS', `满意度评分落库 overall=${latestScore.overall_score.toFixed(4)} (task=${latestScore.task_completion.toFixed(2)} fb=${latestScore.user_feedback.toFixed(2)} eff=${latestScore.efficiency.toFixed(2)})`)

  // ---- T2: 能力追踪（工具调用 → capability_dimensions） ----
  const capsAfter = withDb((db) =>
    db.prepare('SELECT dimension, level, test_count FROM capability_dimensions ORDER BY test_count DESC').all(),
  )
  if (capsAfter.length > baseCaps) {
    const top = capsAfter[0]
    record('T2', 'PASS', `能力追踪落库 ${capsAfter.length} 维，最高 test_count=${top.test_count} (${top.dimension} level=${top.level.toFixed(3)})`)
  } else {
    record('T2', 'FAIL', `能力维度未新增（base=${baseCaps} after=${capsAfter.length}）；本轮可能未触发工具调用，属软失败`)
  }

  // ---- T3: Prompt 进化（变体选择 + 反馈回写 → trial_count 增长） ----
  const variantTrialsAfter = withDb((db) =>
    db.prepare('SELECT COALESCE(SUM(trial_count),0) s FROM prompt_variants').get().s,
  )
  if (variantTrialsAfter > baseVariantTrials) {
    record('T3', 'PASS', `Prompt 进化反馈回写 trial_count ${baseVariantTrials} → ${variantTrialsAfter}`)
  } else {
    record('T3', 'FAIL', `prompt_variants trial_count 未增长（${baseVariantTrials} → ${variantTrialsAfter}）`)
  }

  // ---- T4: 反思（真实 LLM 调用） ----
  if (SKIP_REFLECT) {
    record('T4', 'PASS', '跳过反思（E2E_SKIP_REFLECT=1）')
  } else {
    const agentId = latestScore.agent_id || 'assistant'
    const reflect = ui(['autonomous', 'reflect', '--agent', agentId], { retries: 1 })
    if (reflect.code === 0 && reflect.json?.success !== false) {
      const reflectionsAfter = count('reflections')
      if (reflectionsAfter > baseReflections) {
        const r = withDb((db) =>
          db.prepare('SELECT primary_issue, root_cause, trigger_reason FROM reflections ORDER BY created_at DESC LIMIT 1').get(),
        )
        record('T4', 'PASS', `反思落库 primaryIssue="${(r.primary_issue || '').slice(0, 30)}…"`)
      } else {
        record('T4', 'FAIL', `反思命令返回但 reflections 未新增（${baseReflections} → ${reflectionsAfter}）`)
      }
    } else {
      record('T4', 'FAIL', `反思命令失败: ${reflect.out.slice(0, 300)}`)
    }
  }

  // ---- 汇总 ----
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  console.log(`\n${pass} PASS / ${fail} FAIL`)
  if (fail > 0) process.exitCode = 1
}

try {
  run()
} catch (err) {
  console.error(`\nE2E 中断: ${err.message}`)
  process.exitCode = 1
}
