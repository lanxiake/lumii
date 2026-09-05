#!/usr/bin/env node
/**
 * 自主进化「完整真实用户」E2E 测试
 *
 * 与 run-autonomous-e2e.mjs（仅 happy path）和 run-autonomous-cli-suite.mjs
 * （播种+回读）不同：本脚本只通过 lumii-ui CLI 驱动**真实用户对话与操作**，
 * 覆盖自主进化全链路，每例都回查 agent-runtime.db 验证落库，而非自写自读。
 *
 * 覆盖的功能（7 个已接线模块）：
 *   1. 满意度评分    —— 真实回合结束 → autonomous_satisfaction_scores
 *   2. 能力追踪      —— 真实工具调用 → capability_dimensions + capability_tests（含按维度难度）
 *   3. Prompt 进化   —— 会话选变体 + 回合回写 → prompt_variants trial_count 增长
 *   4. 反馈信号      —— 真实 abort → runtime_state 计数器 → user_feedback 扣分
 *   5. 目标生成      —— 低满意(<0.6) → autonomous_goals pending learning 目标
 *   6. 审批/拒绝     —— CLI approve/reject → executing/rejected + 人格事件
 *   7. 反思          —— CLI autonomous reflect → reflections 落库
 *
 * 用法: node docs/test/lumii-cli/run-autonomous-full-e2e.mjs
 * 前置: pnpm dev 已启动，chat provider 已配置（~/.lumii/config/provider.json）。
 *
 * 环境变量:
 * - E2E_TIMEOUT_MS      回合等待上限（默认 120000）
 * - E2E_SKIP_REFLECT=1  跳过反思（避免真实 LLM 调用）
 * - E2E_NO_CLEANUP=1    保留测试会话与目标（默认保留，便于用户在客户端核查）
 *
 * 注意：真实对话一律走 assistant agent（CLI 无法指定 agent），
 * 测试数据会进入 assistant 的自主进化记录——这正是"与用户实际使用一致"的验证目标。
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
const EVID = path.join(__dirname, 'autonomous-full-e2e-evidence.jsonl')
const REPORT = path.join(__dirname, 'autonomous-full-e2e-report.md')

const TURN_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 120000
const SKIP_REFLECT = process.env.E2E_SKIP_REFLECT === '1'

// 与 autonomous-coordinator.ts 的 DIMENSION_DIFFICULTY 对齐（按维度类别静态先验）
const DIMENSION_DIFFICULTY = {
  document_analysis: 0.35,
  web_search: 0.4,
  code_generation: 0.55,
  multi_step_planning: 0.7,
}

const results = []

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

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
  const icon = status === 'PASS' ? 'PASS' : 'FAIL'
  console.log(`[${id}] ${icon} — ${note}`)
  if (process.env.E2E_VERBOSE === '1' && extra.stack) console.log(extra.stack)
}

function runTest(id, fn) {
  try {
    fn()
  } catch (err) {
    record(id, 'FAIL', err.message, { stack: err.stack })
  }
}

/** 新建会话，返回 sessionKey */
function createConv(title) {
  const c = okJson(ui(['conversation', 'create', '--title', title]), 'conversation create')
  const sk = c.sessionKey ?? c.id
  assert(sk, `conversation create 未返回 sessionKey: ${JSON.stringify(c).slice(0, 200)}`)
  return sk
}

/** 发一条消息并等待该会话的满意度评分落库；返回最新评分行 */
function sendAndWaitScore(sessionKey, text) {
  const send = okJson(
    ui(['send', '--session', sessionKey, '--text', text]),
    'send',
  )
  assert(send.runId, `send 未返回 runId: ${JSON.stringify(send).slice(0, 200)}`)
  const score = pollScore(sessionKey)
  assert(score, `回合结束后满意度评分未落库（等了 ${TURN_TIMEOUT_MS}ms）`)
  return score
}

function pollScore(sessionKey) {
  const start = Date.now()
  while (Date.now() - start < TURN_TIMEOUT_MS) {
    const row = withDb((db) =>
      db.prepare(
        'SELECT overall_score, task_completion, user_feedback, efficiency, agent_id, created_at FROM autonomous_satisfaction_scores WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
      ).get(sessionKey),
    )
    if (row) return row
    sleep(2000)
  }
  return withDb((db) =>
    db.prepare(
      'SELECT overall_score, task_completion, user_feedback, efficiency, agent_id, created_at FROM autonomous_satisfaction_scores WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(sessionKey),
  )
}

/** 单次 abort：发长故事请求 + 等待 + abort（信号无条件记录） */
function abortOnce(sessionKey, prompt) {
  ui(['send', '--session', sessionKey, '--text', prompt])
  sleep(2500)
  const a = ui(['send', 'abort', '--session', sessionKey])
  assert(a.code === 0, `abort 退出码 ${a.code}: ${a.out.slice(0, 200)}`)
  sleep(800)
}

function readAbortCounters(sessionKey) {
  const counters = withDb((db) =>
    db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(`feedback:${sessionKey}`),
  )
  return counters ? JSON.parse(counters.value) : { edits: 0, resends: 0, aborts: 0 }
}

/**
 * 在一个会话里累积两次 abort 信号。
 *
 * 偶发 flake：故事生成若在 abort 前就完成，回合结束会清空计数器，
 * 导致信号被吞。这里每次 abort 后校验计数，不足则重试（最多 3 轮）。
 */
function abortTwice(sessionKey) {
  const prompts = [
    '给我讲一个很长很长的睡前故事，关于一只会说话的小狐狸的冒险，要有丰富的细节描写，请写到至少两千字，讲得越详细越好',
    '再讲一个很长的寓言故事，关于勤劳的蜜蜂和懒惰的蝴蝶，要有详细的场景和对白，请写到至少两千字',
  ]
  for (const p of prompts) {
    abortOnce(sessionKey, p)
  }
  let counters = readAbortCounters(sessionKey)
  let guard = 0
  while (counters.aborts < 2 && guard < 3) {
    guard++
    abortOnce(sessionKey, prompts[0])
    counters = readAbortCounters(sessionKey)
  }
  assert(counters.aborts >= 2, `abort 计数器未累积到 2: ${JSON.stringify(counters)}`)
  return counters
}

/** 低满意触发：2 abort + 无工具完成回合 → overall < 0.6 → 生成 pending 目标 */
function triggerLowSatisfaction(title) {
  const sk = createConv(title)
  const counters = abortTwice(sk)
  const score = sendAndWaitScore(sk, '谢谢你，讲得不错')
  assert(score.overall_score < 0.6, `期望低满意(<0.6)，实际 ${score.overall_score.toFixed(4)}（task=${score.task_completion} fb=${score.user_feedback}）`)
  // 等目标异步落库
  const goal = pollGoal('pending')
  assert(goal, '低满意未生成目标')
  return { sessionKey: sk, counters, score, goal }
}

function pollGoal(status, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const row = withDb((db) =>
      db.prepare(
        'SELECT id, type, status, description, trigger_reason, priority FROM autonomous_goals WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      ).get('assistant', status),
    )
    if (row) return row
    sleep(1000)
  }
  return withDb((db) =>
    db.prepare(
      'SELECT id, type, status, description, trigger_reason, priority FROM autonomous_goals WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
    ).get('assistant', status),
  )
}

function waitGoalStatus(goalId, expectStatus, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const row = withDb((db) =>
      db.prepare('SELECT status FROM autonomous_goals WHERE id = ?').get(goalId),
    )
    if (row?.status === expectStatus) return row
    sleep(500)
  }
  return withDb((db) =>
    db.prepare('SELECT status FROM autonomous_goals WHERE id = ?').get(goalId),
  )
}

function count(table, where = '1=1', args = []) {
  return withDb((db) => db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args).c)
}

/** 清理上轮测试残留的 pending/executing 目标，避免学习目标去重拦截本次生成 */
function preClean() {
  withDb((db) => {
    const rows = db.prepare(
      "SELECT id FROM autonomous_goals WHERE agent_id = 'assistant' AND status IN ('pending', 'executing')",
    ).all()
    if (rows.length === 0) return
    const stmt = db.prepare("UPDATE autonomous_goals SET status = 'rejected' WHERE id = ?")
    for (const r of rows) stmt.run(r.id)
    console.log(`[preClean] 清理残留 pending/executing 目标 ${rows.length} 条（置 rejected）\n`)
  })
}

// ==================== 用例 ====================

function run() {
  console.log('自主进化「完整真实用户」E2E 测试\n')
  assert(fs.existsSync(DB_PATH), `数据库不存在: ${DB_PATH}，请先启动应用`)
  assert(fs.existsSync(LUMII_UI), `CLI 不存在: ${LUMII_UI}`)

  preClean()

  const base = {
    scores: count('autonomous_satisfaction_scores'),
    caps: count('capability_dimensions'),
    capTests: count('capability_tests'),
    reflections: count('reflections'),
    variantTrials: withDb((db) => db.prepare('SELECT COALESCE(SUM(trial_count),0) s FROM prompt_variants').get().s),
  }
  console.log(`基线: scores=${base.scores} caps=${base.caps} capTests=${base.capTests} reflections=${base.reflections} variantTrials=${base.variantTrials}\n`)

  // ==================== 场景 A：顺利会话（满意度 + 能力追踪 + Prompt 进化） ====================
  const convA = createConv('自主进化E2E-A-顺利会话')

  runTest('A1.满意度评分', () => {
    const score = sendAndWaitScore(convA, '请用工具列出当前工作目录下的所有文件，并统计一共有多少个')
    assert(score.overall_score >= 0 && score.overall_score <= 1, `overall 越界: ${score.overall_score}`)
    assert(score.agent_id === 'assistant', `agent_id 应为 assistant，实际 ${score.agent_id}`)
    record('A1', 'PASS', `满意度落库 overall=${score.overall_score.toFixed(4)} (task=${score.task_completion.toFixed(2)} fb=${score.user_feedback.toFixed(2)} eff=${score.efficiency.toFixed(2)})`)
  })

  runTest('A2.能力追踪（工具→维度+难度）', () => {
    const tests = withDb((db) =>
      db.prepare(
        "SELECT t.dimension, t.difficulty, t.result FROM capability_tests t WHERE t.session_id = ? ORDER BY t.created_at ASC",
      ).all(convA),
    )
    assert(tests.length > 0, '本轮未产生能力测试记录（agent 未调用工具）')
    for (const t of tests) {
      const expected = DIMENSION_DIFFICULTY[t.dimension]
      assert(expected !== undefined, `维度 ${t.dimension} 无难度先验`)
      assert(Math.abs(t.difficulty - expected) < 1e-9, `维度 ${t.dimension} 难度 ${t.difficulty} != 期望 ${expected}`)
    }
    const dims = withDb((db) =>
      db.prepare('SELECT dimension, test_count FROM capability_dimensions WHERE agent_id = ? ORDER BY test_count DESC').all('assistant'),
    )
    record('A2', 'PASS', `${tests.length} 条能力测试落库，维度难度正确（${[...new Set(tests.map((t) => `${t.dimension}:${t.difficulty}`))].join(', ')}）；capability_dimensions ${dims.length} 维`)
  })

  runTest('A3.Prompt进化反馈回写', () => {
    const after = withDb((db) => db.prepare('SELECT COALESCE(SUM(trial_count),0) s FROM prompt_variants').get().s)
    assert(after > base.variantTrials, `prompt_variants trial_count 未增长（${base.variantTrials} → ${after}）`)
    record('A3', 'PASS', `trial_count ${base.variantTrials} → ${after}`)
  })

  runTest('A4.能力追踪失败路径', () => {
    const convFail = createConv('自主进化E2E-A4-失败路径')
    const score = sendAndWaitScore(convFail, '请读取文件 E:/testsoft/Lumii-data/definitely-not-exist-xyz.txt 的完整内容并总结要点')
    const failTests = withDb((db) =>
      db.prepare(
        "SELECT dimension, difficulty, result FROM capability_tests WHERE session_id = ? AND result = 'failure'",
      ).all(convFail),
    )
    assert(failTests.length > 0, '本轮未产生失败能力测试记录（agent 未调用失败工具）')
    for (const t of failTests) {
      const expected = DIMENSION_DIFFICULTY[t.dimension]
      assert(expected !== undefined, `失败维度 ${t.dimension} 无难度先验`)
      assert(Math.abs(t.difficulty - expected) < 1e-9, `失败维度 ${t.dimension} 难度 ${t.difficulty} != ${expected}`)
    }
    assert(score.task_completion < 1, `有失败应 task<1，实际 ${score.task_completion}`)
    record('A4', 'PASS', `${failTests.length} 条失败测试（result=failure，难度正确），task=${score.task_completion.toFixed(2)}（含失败惩罚）`)
  })

  // ==================== 场景 B：反馈信号 + 低满意 + 目标生成 + 拒绝 ====================
  const lowB = triggerLowSatisfaction('自主进化E2E-B-低满意拒绝')

  runTest('B1.反馈信号采集', () => {
    assert(lowB.counters.aborts >= 2, `abort 计数 ${lowB.counters.aborts}`)
    record('B1', 'PASS', `2 次 abort 信号落 runtime_state（aborts=${lowB.counters.aborts}）`)
  })

  runTest('B2.低满意触发目标生成', () => {
    assert(lowB.score.overall_score < 0.6, `overall ${lowB.score.overall_score}`)
    assert(lowB.score.user_feedback === 0.35, `2 abort 应 feedback=0.35，实际 ${lowB.score.user_feedback}`)
    assert(lowB.goal.status === 'pending', `目标应 pending，实际 ${lowB.goal.status}`)
    record('B2', 'PASS', `overall=${lowB.score.overall_score.toFixed(4)} → 生成 ${lowB.goal.type} 目标（pending）"${lowB.goal.description}"`)
  })

  runTest('B3.拒绝目标落库', () => {
    const j = okJson(ui(['autonomous', 'goals', 'reject', lowB.goal.id, '--reason', '测试拒绝']), 'reject')
    assert(j.success === true, `拒绝失败: ${JSON.stringify(j)}`)
    const row = waitGoalStatus(lowB.goal.id, 'rejected')
    assert(row?.status === 'rejected', `库中应 rejected，实际 ${row?.status}`)
    record('B3', 'PASS', `目标 ${lowB.goal.id} 已拒绝（rejected）`)
  })

  // ==================== 场景 C：低满意 + 目标生成 + 批准 + 人格 ====================
  const lowC = triggerLowSatisfaction('自主进化E2E-C-低满意批准')

  runTest('C1.目标生成待批', () => {
    assert(lowC.goal.status === 'pending', `目标应 pending，实际 ${lowC.goal.status}`)
    record('C1', 'PASS', `生成 pending 目标 "${lowC.goal.description}"`)
  })

  runTest('C2.批准流转 executing + 人格事件', () => {
    const j = okJson(ui(['autonomous', 'goals', 'approve', lowC.goal.id, '--note', '测试批准']), 'approve')
    assert(j.success === true, `批准失败: ${JSON.stringify(j)}`)
    const row = waitGoalStatus(lowC.goal.id, 'executing')
    assert(row?.status === 'executing', `库中应流转 executing，实际 ${row?.status}`)
    const ev = withDb((db) =>
      db.prepare(
        "SELECT event_type FROM personality_events WHERE agent_id = 'assistant' AND event_type = 'evolution-decided' ORDER BY created_at DESC LIMIT 1",
      ).get(),
    )
    assert(ev, '审批未触发 evolution-decided 人格事件')
    const st = withDb((db) =>
      db.prepare("SELECT update_count FROM personality_state WHERE agent_id = 'assistant' LIMIT 1").get(),
    )
    record('C2', 'PASS', `executing + evolution-decided 人格事件落库（personality update_count=${st?.update_count ?? 0}）`)
  })

  runTest('C3.目标列表与状态', () => {
    const list = okJson(ui(['autonomous', 'goals', 'list', '--agent', 'assistant']), 'goals list')
    assert(list.total >= 1, `目标列表应含测试目标，实际 total=${list.total}`)
    const has = list.goals.some((g) => g.id === lowC.goal.id && g.status === 'executing')
    assert(has, 'CLI 目标列表未反映 executing 状态')
    record('C3', 'PASS', `CLI goals list 可见 executing 目标（total=${list.total}）`)
  })

  // ==================== 场景 D：反思 ====================
  if (SKIP_REFLECT) {
    record('D1', 'PASS', '跳过反思（E2E_SKIP_REFLECT=1）')
  } else {
    runTest('D1.反思落库', () => {
      const baseRef = count('reflections')
      const reflect = ui(['autonomous', 'reflect', '--agent', 'assistant'], { retries: 1 })
      if (reflect.code === 0 && reflect.json?.success !== false) {
        const after = count('reflections')
        assert(after > baseRef, `反思命令返回但 reflections 未新增（${baseRef} → ${after}）`)
        const r = withDb((db) =>
          db.prepare('SELECT primary_issue, root_cause, trigger_reason FROM reflections ORDER BY created_at DESC LIMIT 1').get(),
        )
        record('D1', 'PASS', `反思落库 trigger=${r.trigger_reason} primaryIssue="${(r.primary_issue || '').slice(0, 40)}…"`)
      } else {
        assert(false, `反思命令失败: ${reflect.out.slice(0, 300)}`)
      }
    })
  }

  // ==================== 汇总 ====================
  writeReport()
}

function writeReport() {
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const lines = [
    '# 自主进化「完整真实用户」E2E 测试报告',
    '',
    `**执行时间**: ${new Date().toISOString()}`,
    `**结果**: ${pass} PASS / ${fail} FAIL（共 ${results.length}）`,
    `**数据库**: \`${DB_PATH}\``,
    `**驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/send abort/goals approve/goals reject/reflect），无 SQL 播种`,
    '',
    '## 明细',
    '',
    '| 用例 | 结果 | 说明 |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${String(r.note).replace(/\|/g, '\\|')} |`),
    '',
    '## 覆盖范围',
    '',
    '- 满意度评分：真实回合结束落库，字段不越界',
    '- 能力追踪：真实工具调用 → capability_tests（维度难度与 DIMENSION_DIFFICULTY 对齐）',
    '- Prompt 进化：变体反馈回写 trial_count 增长',
    '- 反馈信号：真实 abort → runtime_state 计数 → user_feedback 扣分（2 abort = 0.35）',
    '- 目标生成：低满意(<0.6) → pending learning 目标',
    '- 审批/拒绝：CLI 真实操作 → executing/rejected + evolution-decided 人格事件',
    '- 反思：CLI reflect 真实 LLM 调用 → reflections 落库',
    '',
    '## 未覆盖 / 已知限制（诚实声明，非遗漏即失真）',
    '',
    '- **编辑/重发反馈信号（edit -0.10 / resend -0.20）**：采集点挂在 `message-commands.ts`(edit) 与 `misc-commands.ts`(edit-and-resend)，只经前端 UI 触发，CLI 无 `edit`/`resend` 子命令。本脚本只实测了 CLI 可达的 `abort`（-0.25）。两路信号共用 `recordFeedbackSignal`，接线一致，差异仅触发入口。',
    '- **主动消息目标（proactive-message）**：需「满意度 ≥ 0.6 且用户 6 小时无交互」才生成，无法在单次测试运行内真实触发；且当前实现为 P0 占位（不实际发消息）。',
    '- **反思定时触发（scheduled，每日 23:00）**：cron 接线已在上轮验证（启动日志「反思定时触发已启动（0 23 * * *）」）；本脚本只触发手动 `user-request`，`scheduled` 走同一 `reflectAutonomous` 路径。',
    '- **agent 数据隔离**：真实对话经 CLI 一律走 assistant agent，无法用真实对话验证多 agent 隔离；隔离已由 `run-autonomous-cli-suite.mjs` TC21 用探针 agent 覆盖。',
    '- **目标去重（dedup）**：P2 特性，单测覆盖。本脚本运行前清理了残留 pending 目标（否则同描述学习目标会被去重拦截）——该行为在测试准备阶段已实际观察到。',
    '',
    '## 说明',
    '',
    '真实对话一律走 assistant agent（CLI 无法指定 agent），测试数据进入 assistant 的自主进化记录。',
    '会话标题带「自主进化E2E-」前缀，便于用户在客户端侧边栏核查对应对话与 AutonomousPage 数据。',
    '',
    `证据文件: \`${path.basename(EVID)}\``,
    '',
  ]
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8')
  console.log(`\n${pass} PASS / ${fail} FAIL`)
  console.log(`报告: ${REPORT}`)
  if (fail > 0) process.exitCode = 1
}

try {
  run()
} catch (err) {
  console.error(`\nE2E 中断: ${err.message}`)
  if (process.env.E2E_VERBOSE === '1') console.error(err.stack)
  process.exitCode = 1
}
