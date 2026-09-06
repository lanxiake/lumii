#!/usr/bin/env node
/**
 * 自主进化「主动规划」真实 E2E 测试
 *
 * 覆盖主动规划设计 §4.2 的落地链路：
 *   规划器触发（心跳 24h 兜底）→ LLM 规划 → 落库（agent-self cron / planned_by='planner'
 *   目标 / 工作记忆待办）→ 预算超限裁剪。
 *
 * 驱动方式与 life-e2e 一致：真实动作走 lumii-ui CLI（cron run autonomous-tick），
 * 探针播种/回查用 node:sqlite。规划器由心跳兜底触发（静默时段 + 距上次规划满 24h），
 * 故本脚本把静默时段设到当前小时并清掉 last_plan_at 来主动拉起一次规划。
 *
 * 用法: node docs/test/lumii-cli/run-autonomous-planning-e2e.mjs
 * 前置: pnpm dev 已启动，chat provider 已配置。
 *
 * 环境变量:
 * - PLANNING_E2E_VERBOSE=1  打印失败堆栈
 * - PLANNING_E2E_NO_RESTORE=1 不清理测试产物（便于人工核查）
 */

import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const DB_PATH = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const EVID = path.join(__dirname, 'autonomous-planning-e2e-evidence.jsonl')
const REPORT = path.join(__dirname, 'autonomous-planning-e2e-report.md')

const VERBOSE = process.env.PLANNING_E2E_VERBOSE === '1'
const NO_RESTORE = process.env.PLANNING_E2E_NO_RESTORE === '1'

const CRON_JOB_ID = 'autonomous-tick'
const LAST_PLAN_KEY = 'autonomous.last_plan_at'
const PROBE_PREFIX = '[planning-e2e]'
const SELF_CRON_PREFIX = 'agent-self:'

const results = []

if (fs.existsSync(EVID)) fs.unlinkSync(EVID)

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function ui(args, { retries = 6, timeoutMs = 30000 } = {}) {
  let last = { code: 1, out: '', json: null }
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
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
    const timedOut = r.error && r.error.code === 'ETIMEDOUT'
    last = { code: r.status ?? (timedOut ? 124 : 1), out, json, timedOut }
    if (timedOut) return last
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

function okJson(r, label) {
  assert(r.code === 0, `${label} 退出码 ${r.code}: ${r.out.slice(0, 300)}`)
  assert(r.json, `${label} 未返回 JSON: ${r.out.slice(0, 300)}`)
  assert(r.json.ok !== false, `${label} 控制口拒绝: ${JSON.stringify(r.json).slice(0, 300)}`)
  return r.json
}

function record(id, status, note, extra = {}) {
  const row = { ts: new Date().toISOString(), id, status, note, ...extra }
  results.push(row)
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n', 'utf8')
  const icon = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL'
  console.log(`[${id}] ${icon} — ${note}`)
  if (VERBOSE && extra.stack) console.log(extra.stack)
}

function runTest(id, name, fn) {
  try {
    const note = fn()
    record(id, 'PASS', note ? `${name}: ${note}` : name)
  } catch (err) {
    record(id, 'FAIL', `${name}: ${err.message}`, { stack: VERBOSE ? err.stack : undefined })
  }
}

// ── runtime_state 快照 / 恢复 ──

const SNAPSHOT_KEYS = [
  'autonomous.settings',
  'autonomous.last_diary_date',
  'autonomous.enabled',
  LAST_PLAN_KEY,
]

function snapshotState() {
  return withDb((db) => {
    const snap = {}
    for (const k of SNAPSHOT_KEYS) {
      const row = db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(k)
      snap[k] = row ? row.value : undefined
    }
    return snap
  })
}

function restoreState(snap) {
  withDb((db) => {
    for (const [k, v] of Object.entries(snap)) {
      if (v === undefined) {
        db.prepare('DELETE FROM runtime_state WHERE key = ?').run(k)
      } else {
        db.prepare(
          `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(k, v, new Date().toISOString())
      }
    }
  })
}

function setState(key, value) {
  withDb((db) =>
    db.prepare(
      `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, new Date().toISOString()),
  )
}

function delState(key) {
  withDb((db) => db.prepare('DELETE FROM runtime_state WHERE key = ?').run(key))
}

// ── 测试产物快照 / 清理（agent-self cron + planner 目标 + 工作记忆待办） ──

function snapshotArtifacts() {
  return withDb((db) => ({
    cronIds: new Set(
      db.prepare(`SELECT id FROM local_cron_jobs WHERE id LIKE ?`).all(`${SELF_CRON_PREFIX}%`).map((r) => r.id),
    ),
    goalIds: new Set(
      db.prepare(`SELECT id FROM autonomous_goals WHERE planned_by = 'planner'`).all().map((r) => r.id),
    ),
    memoryIds: new Set(
      db.prepare(`SELECT id FROM agent_memories WHERE agent_id = 'assistant' AND category = 'reference'`)
        .all()
        .map((r) => r.id),
    ),
  }))
}

function cleanupArtifacts(before) {
  withDb((db) => {
    const cron = db.prepare(`SELECT id FROM local_cron_jobs WHERE id LIKE ?`).all(`${SELF_CRON_PREFIX}%`)
    for (const r of cron) {
      if (!before.cronIds.has(r.id)) db.prepare('DELETE FROM local_cron_jobs WHERE id = ?').run(r.id)
    }
    const goals = db.prepare(`SELECT id FROM autonomous_goals WHERE planned_by = 'planner'`).all()
    for (const r of goals) {
      if (!before.goalIds.has(r.id)) db.prepare('DELETE FROM autonomous_goals WHERE id = ?').run(r.id)
    }
    const mems = db
      .prepare(`SELECT id FROM agent_memories WHERE agent_id = 'assistant' AND category = 'reference'`)
      .all()
    for (const r of mems) {
      if (!before.memoryIds.has(r.id)) db.prepare('DELETE FROM agent_memories WHERE id = ?').run(r.id)
    }
  })
}

// ── 探针播种 ──

function seedRecentReflection() {
  return withDb((db) => {
    const now = new Date().toISOString()
    const id = `planning-e2e-ref-${crypto.randomBytes(8).toString('hex')}`
    db.prepare(
      `INSERT INTO reflections
       (id, agent_id, trigger_reason, primary_issue, affected_dimensions, root_cause, recommendations, suggested_goals, analysis_window_start, analysis_window_end, created_at)
       VALUES (?, 'assistant', 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      `${PROBE_PREFIX} 需要主动学习网络检索技巧`,
      '["knowledge"]',
      '搜索时关键词不够精准',
      '["先明确关键词再搜索"]',
      '[{"type":"learning","description":"练习用多个关键词组合检索","priority":0.8}]',
      now,
      now,
      now,
    )
    return id
  })
}

function seedPendingGoal(description) {
  return withDb((db) => {
    const id = `planning-e2e-goal-${crypto.randomBytes(8).toString('hex')}`
    db.prepare(
      `INSERT INTO autonomous_goals
       (id, agent_id, type, description, trigger_reason, status, priority, created_at)
       VALUES (?, 'assistant', 'learning', ?, 'planning-e2e 测试', 'pending', 0.5, ?)`,
    ).run(id, description, new Date().toISOString())
    return id
  })
}

function clearExecutingGoals() {
  withDb((db) => {
    const rows = db.prepare(
      "SELECT id FROM autonomous_goals WHERE agent_id = 'assistant' AND status = 'executing'",
    ).all()
    for (const r of rows) db.prepare('DELETE FROM autonomous_goals WHERE id = ?').run(r.id)
  })
}

function cleanupProbeReflections() {
  withDb((db) => {
    const rows = db.prepare(
      "SELECT id FROM reflections WHERE agent_id = 'assistant' AND primary_issue LIKE ?",
    ).all(`${PROBE_PREFIX}%`)
    for (const r of rows) db.prepare('DELETE FROM reflections WHERE id = ?').run(r.id)
  })
}

function cleanupProbeGoals() {
  withDb((db) => {
    const rows = db.prepare(
      "SELECT id FROM autonomous_goals WHERE agent_id = 'assistant' AND description LIKE ?",
    ).all(`${PROBE_PREFIX}%`)
    for (const r of rows) db.prepare('DELETE FROM autonomous_goals WHERE id = ?').run(r.id)
  })
}

// ── tick 触发与结果读取 ──

function cronTick({ timeoutMs = 180000 } = {}) {
  return ui(['cron', 'run', CRON_JOB_ID], { retries: 0, timeoutMs })
}

function lastRunSummary() {
  return withDb((db) =>
    db.prepare(
      'SELECT summary, status, error FROM local_cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(CRON_JOB_ID),
  )
}

/** 把环境切成「静默时段内 + 无到期目标 + 规划已超期」，好让心跳兜底拉起规划器 */
function setupPlannerTrigger() {
  clearExecutingGoals()
  const hour = new Date().getHours()
  okJson(
    ui(['autonomous', 'settings', 'set', '--data', `{"quietHours":[${hour},${(hour + 1) % 24}]}`]),
    '设静默时段为当前小时',
  )
  setState('autonomous.last_diary_date', localDateKey()) // 日记不抢跑
  seedRecentReflection() // 反思不抢跑（且给规划器喂一条明确建议目标）
  delState(LAST_PLAN_KEY) // 距上次规划「超期」
}

/** 触发一次规划并返回 (tick 结果, run 记录) */
function triggerPlanner() {
  setupPlannerTrigger()
  const r = cronTick()
  const run = lastRunSummary()
  return { r, run }
}

// ── 用例 ──

function run() {
  console.log('自主进化「主动规划」E2E 测试\n')
  assert(fs.existsSync(DB_PATH), `数据库不存在: ${DB_PATH}，请先启动应用`)
  assert(fs.existsSync(LUMII_UI), `CLI 不存在: ${LUMII_UI}`)

  const snap = snapshotState()
  const artifactsBefore = snapshotArtifacts()
  cleanupProbeReflections()
  cleanupProbeGoals()

  try {
    // ==================== P1：规划器兜底触发（端到端 wiring） ====================
    runTest('P1', '心跳兜底拉起规划器 → 记录 last_plan_at', () => {
      const { r, run } = triggerPlanner()
      assert(r.code === 0, `cron run 退出码 ${r.code}: ${r.out.slice(0, 300)}`)
      assert(run, 'local_cron_runs 无 autonomous-tick 记录')
      assert(run.status === 'ok', `tick 应 ok，实际 ${run.status}: ${run.error ?? ''}`)
      assert(/plan/.test(run.summary ?? ''), `应 plan，实际 summary="${run.summary}"`)
      const lastPlan = withDb((db) =>
        db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(LAST_PLAN_KEY),
      )
      assert(lastPlan?.value, '规划后应写入 autonomous.last_plan_at')
      return `summary="${run.summary}"，last_plan_at 已记录`
    })

    // ==================== P2：落库结构正确 ====================
    runTest('P2', '落库结构：agent-self cron + planner 目标 + 待办', () => {
      const selfCron = withDb((db) =>
        db
          .prepare(`SELECT id, agent_id, notify_targets FROM local_cron_jobs WHERE id LIKE ?`)
          .all(`${SELF_CRON_PREFIX}%`),
      )
      const plannerGoals = withDb((db) =>
        db
          .prepare(`SELECT id, type, planned_by, scheduled_for FROM autonomous_goals WHERE planned_by = 'planner'`)
          .all(),
      )
      const todos = withDb((db) =>
        db
          .prepare(`SELECT id FROM agent_memories WHERE agent_id = 'assistant' AND category = 'reference'`)
          .all(),
      )
      for (const j of selfCron) {
        assert(j.agent_id === 'assistant', `agent-self cron ${j.id} agent_id 应 assistant，实际 ${j.agent_id}`)
        assert(j.notify_targets === 'silent', `agent-self cron ${j.id} notify_targets 应 silent，实际 ${j.notify_targets}`)
      }
      for (const g of plannerGoals) {
        assert(g.planned_by === 'planner', `planner 目标 ${g.id} planned_by 应 planner`)
      }
      return `cron=${selfCron.length} plannerGoals=${plannerGoals.length} todos=${todos.length}`
    })

    // ==================== P3：预算超限 → 目标受限 ====================
    runTest('P3', '目标配额耗尽 → enforcePlanBudget 裁剪为 0', () => {
      // 塞满今日目标配额（7 个 pending，不计入 executing 不会被误执行），goalsRemaining 归零
      for (let i = 0; i < 7; i++) seedPendingGoal(`${PROBE_PREFIX} 占位目标 ${i}`)
      const before = withDb((db) =>
        db.prepare(`SELECT COUNT(*) c FROM autonomous_goals WHERE planned_by = 'planner'`).get().c,
      )
      const { r } = triggerPlanner()
      assert(r.code === 0, `cron run 退出码 ${r.code}: ${r.out.slice(0, 300)}`)
      const after = withDb((db) =>
        db.prepare(`SELECT COUNT(*) c FROM autonomous_goals WHERE planned_by = 'planner'`).get().c,
      )
      assert(after === before, `配额耗尽后不应新增 planner 目标（${before} → ${after}）`)
      return `planner 目标数 ${before} 保持不变（配额已满）`
    })
  } finally {
    if (!NO_RESTORE) {
      cleanupArtifacts(artifactsBefore)
      cleanupProbeReflections()
      cleanupProbeGoals()
      restoreState(snap)
      console.log('\n[restore] 已清理测试产物并恢复 runtime_state 快照')
    }
  }

  // ── 报告 ──
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skip = results.filter((r) => r.status === 'SKIP').length
  console.log(`\n${pass} PASS / ${fail} FAIL / ${skip} SKIP`)
  const lines = [
    '# 自主进化「主动规划」E2E 测试报告',
    '',
    `> 时间：${new Date().toISOString()}`,
    '',
    '| 用例 | 结果 | 说明 |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${r.note} |`),
    '',
    `**结论**：${pass} PASS / ${fail} FAIL / ${skip} SKIP`,
    '',
  ]
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8')
  console.log(`报告: ${REPORT}`)
  process.exit(fail > 0 ? 1 : 0)
}

run()
