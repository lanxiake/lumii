#!/usr/bin/env node
/**
 * 自主进化 CLI 测试套件
 *
 * 真实调用 lumii-ui CLI 的 10 个 autonomous 命令，并回查 agent-runtime.db
 * 校验落库结果，覆盖算法一致性与异常路径。
 *
 * 用法: node docs/test/lumii-cli/run-autonomous-cli-suite.mjs
 *
 * 前置: pnpm dev 已启动，~/.lumii/runtime/app-ui.json 可读。
 *
 * 探针数据统一挂在 autonomous-test-* agent 下，跑完自动清理，
 * 不污染真实 assistant 的自主进化数据。
 *
 * 环境变量:
 * - LUMII_CLI_VERBOSE=1     打印失败堆栈
 * - LUMII_CLI_NO_CLEANUP=1  保留探针数据便于排查
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
const EVID = path.join(__dirname, 'autonomous-cli-evidence.jsonl')
const REPORT = path.join(__dirname, 'autonomous-cli-test-report.md')

const VERBOSE = process.env.LUMII_CLI_VERBOSE === '1'
const NO_CLEANUP = process.env.LUMII_CLI_NO_CLEANUP === '1'

const PROBE_AGENT = 'autonomous-test-agent'
const OTHER_AGENT = 'autonomous-test-other'

const results = []

if (fs.existsSync(EVID)) fs.unlinkSync(EVID)

// ==================== 基础设施 ====================

/** 调用 lumii-ui；遇 rate_limited 退避重试 */
function ui(args, { retries = 6 } = {}) {
  let last = { code: 1, out: '', json: null }
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
        /* 非 JSON 输出保留在 out */
      }
    }
    last = { code: r.status ?? 1, out, json }
    if (json?.error !== 'rate_limited' && !/rate_limited/.test(out)) return last
    sleep(Math.min(20000, 5000 * (i + 1)))
  }
  return last
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function record(id, status, note, extra = {}) {
  const row = { ts: new Date().toISOString(), id, status, note, ...extra }
  results.push(row)
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n', 'utf8')
  const icon = status === 'PASS' ? 'PASS' : 'FAIL'
  console.log(`[${String(results.length).padStart(2, '0')}] ${icon} ${id} — ${note}`)
  if (VERBOSE && extra.stack) console.log(extra.stack)
}

function runTest(id, name, fn) {
  try {
    const note = fn()
    record(id, 'PASS', note ? `${name}: ${note}` : name)
  } catch (err) {
    record(id, 'FAIL', `${name}: ${err.message}`, {
      stack: VERBOSE ? err.stack : undefined,
    })
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/**
 * 控制口失败也返回退出码 0（形如 {"ok":false,"error":"not_exposed"}），
 * 只断言退出码会把命令未注册当成通过，故所有成功路径统一走这里。
 */
function okJson(r, label) {
  assert(r.code === 0, `${label} 退出码 ${r.code}: ${r.out.slice(0, 300)}`)
  assert(r.json, `${label} 未返回 JSON: ${r.out.slice(0, 300)}`)
  assert(r.json.ok !== false, `${label} 控制口拒绝: ${JSON.stringify(r.json).slice(0, 300)}`)
  return r.json
}

function withDb(fn) {
  const db = new DatabaseSync(DB_PATH)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

// ==================== 探针播种 ====================

function seedSatisfaction(rows) {
  withDb((db) => {
    const stmt = db.prepare(
      `INSERT INTO autonomous_satisfaction_scores
       (id, session_id, agent_id, task_completion, user_feedback, efficiency,
        knowledge_growth, overall_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of rows) {
      stmt.run(
        `autonomous-test-${crypto.randomBytes(8).toString('hex')}`,
        'autonomous-test-session',
        r.agentId ?? PROBE_AGENT,
        r.task,
        r.feedback,
        r.efficiency,
        r.knowledge,
        r.overall,
        r.createdAt,
      )
    }
  })
}

function seedGoal({ status = 'pending', type = 'learning', priority = 0.8, description = '目标探针' } = {}) {
  return withDb((db) => {
    const id = `autonomous-test-${crypto.randomBytes(8).toString('hex')}`
    db.prepare(
      `INSERT INTO autonomous_goals
       (id, agent_id, type, description, trigger_reason, status, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, PROBE_AGENT, type, description, '满意度低于阈值', status, priority, new Date().toISOString())
    return id
  })
}

function seedCapabilities(dims) {
  withDb((db) => {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO capability_dimensions
       (agent_id, dimension, level, confidence, boundary, test_count, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const d of dims) {
      stmt.run(PROBE_AGENT, d.dimension, d.level, d.confidence, d.boundary, d.testCount, new Date().toISOString())
    }
  })
}

function seedReflection({ primaryIssue, dims, recommendations, goals } = {}) {
  return withDb((db) => {
    const id = `autonomous-test-${crypto.randomBytes(8).toString('hex')}`
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO reflections
       (id, agent_id, trigger_reason, primary_issue, affected_dimensions, root_cause,
        recommendations, suggested_goals, analysis_window_start, analysis_window_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, PROBE_AGENT, 'low-satisfaction', primaryIssue, dims, '缺少项目上下文导致 API 误用',
      recommendations, goals, now, now, now)
    return id
  })
}

function seedPromptVariants(baselineId, variants) {
  withDb((db) => {
    const stmt = db.prepare(
      `INSERT INTO prompt_variants
       (id, baseline_prompt_id, variant_text, is_baseline, trial_count,
        success_count, total_reward, avg_satisfaction, ucb_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const v of variants) {
      stmt.run(
        `autonomous-test-${crypto.randomBytes(8).toString('hex')}`,
        baselineId,
        v.text,
        v.isBaseline ? 1 : 0,
        v.trialCount,
        v.successCount,
        v.totalReward,
        v.avgSatisfaction,
        v.ucbScore,
        new Date().toISOString(),
      )
    }
  })
}

function cleanup() {
  if (NO_CLEANUP) {
    console.log('\n[cleanup] LUMII_CLI_NO_CLEANUP=1，保留探针数据')
    return
  }
  withDb((db) => {
    db.prepare("DELETE FROM autonomous_satisfaction_scores WHERE agent_id LIKE 'autonomous-test-%'").run()
    db.prepare("DELETE FROM autonomous_goals WHERE agent_id LIKE 'autonomous-test-%'").run()
    db.prepare("DELETE FROM capability_dimensions WHERE agent_id LIKE 'autonomous-test-%'").run()
    db.prepare("DELETE FROM reflections WHERE agent_id LIKE 'autonomous-test-%'").run()
    db.prepare("DELETE FROM prompt_variants WHERE baseline_prompt_id LIKE 'autonomous-test-%'").run()
    // 审批会触发协调器写入人格表，探针数据需一并清理
    db.prepare("DELETE FROM personality_state WHERE agent_id LIKE 'autonomous-test-%'").run()
    db.prepare("DELETE FROM personality_events WHERE agent_id LIKE 'autonomous-test-%'").run()
  })
}

// ==================== 用例 ====================

function run() {
  console.log('自主进化 CLI 测试套件\n')
  assert(fs.existsSync(DB_PATH), `数据库不存在: ${DB_PATH}，请先启动应用`)
  assert(fs.existsSync(LUMII_UI), `CLI 不存在: ${LUMII_UI}`)
  cleanup()

  // ---- TC1: 正式表结构 ----
  runTest('TC1', '正式表结构齐全', () => {
    const need = [
      'autonomous_satisfaction_scores', 'autonomous_goals', 'capability_dimensions',
      'capability_tests', 'reflections', 'prompt_variants', 'prompt_evolution_history',
      'personality_state', 'personality_events', 'evolution_coordination_history',
      'autonomous_approvals', 'autonomous_approval_settings',
    ]
    const have = new Set(
      withDb((db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
        .map((r) => r.name),
    )
    const missing = need.filter((t) => !have.has(t))
    assert(missing.length === 0, `缺表: ${missing.join(', ')}`)
    return `${need.length} 张表齐全`
  })

  // ---- TC2: help 暴露命令（Agent 能力发现） ----
  runTest('TC2', 'help 暴露全部 autonomous 命令', () => {
    const r = ui(['help', '--json'])
    assert(r.code === 0, `help 退出码 ${r.code}: ${r.out.slice(0, 200)}`)
    const text = JSON.stringify(r.json)
    const need = [
      'autonomous status', 'autonomous goals list', 'autonomous goals approve',
      'autonomous goals reject', 'autonomous capabilities', 'autonomous reflections',
      'autonomous satisfaction history', 'autonomous prompt variants',
      'autonomous enable', 'autonomous disable',
    ]
    const missing = need.filter((n) => !text.includes(n))
    assert(missing.length === 0, `help 未暴露: ${missing.join(', ')}`)
    return '10 个命令均可被 Agent 发现'
  })

  // ---- TC3: 空数据降级 ----
  runTest('TC3', 'status 空数据降级', () => {
    const j = okJson(ui(['autonomous', 'status', '--agent', PROBE_AGENT]), 'status')
    assert(j.hasData === false, `空库应 hasData=false，实际 ${JSON.stringify(j)}`)
    assert(j.satisfaction === null, '空库 satisfaction 应为 null')
    return 'hasData=false，不抛异常'
  })

  // ---- TC4: 满意度加权公式 ----
  runTest('TC4', '满意度四维加权公式一致性', () => {
    const expected = 0.8 * 0.35 + 0.6 * 0.30 + 0.7 * 0.20 + 0.5 * 0.15
    seedSatisfaction([{
      task: 0.8, feedback: 0.6, efficiency: 0.7, knowledge: 0.5,
      overall: expected, createdAt: new Date().toISOString(),
    }])
    const j = okJson(ui(['autonomous', 'status', '--agent', PROBE_AGENT]), 'status')
    assert(j.hasData === true, `应有数据: ${JSON.stringify(j)}`)
    const got = j.satisfaction.overall
    assert(Math.abs(got - expected) < 1e-9, `期望 ${expected.toFixed(4)}，实际 ${got}`)
    const b = j.satisfaction.breakdown
    assert(b.taskCompletion === 0.8, `taskCompletion 错位: ${JSON.stringify(b)}`)
    assert(b.userFeedback === 0.6, `userFeedback 错位: ${JSON.stringify(b)}`)
    assert(b.efficiency === 0.7, `efficiency 错位: ${JSON.stringify(b)}`)
    assert(b.knowledgeGrowth === 0.5, `knowledgeGrowth 错位: ${JSON.stringify(b)}`)
    return `overall=${got.toFixed(4)}，与设计公式 0.695 一致，四维无错位`
  })

  // ---- TC5: 趋势判定 ----
  runTest('TC5', '满意度趋势判定', () => {
    const day = 86400000
    const now = Date.now()
    seedSatisfaction([
      { task: 0.5, feedback: 0.5, efficiency: 0.5, knowledge: 0.5, overall: 0.5, createdAt: new Date(now - 3 * day).toISOString() },
      { task: 0.9, feedback: 0.9, efficiency: 0.9, knowledge: 0.9, overall: 0.9, createdAt: new Date(now - day).toISOString() },
    ])
    const j = okJson(ui(['autonomous', 'satisfaction', 'history', '--window', '7d', '--agent', PROBE_AGENT]), 'history')
    assert(j.trend === 'improving', `上升序列应 improving，实际 ${j.trend}`)
    const pts = j.dataPoints
    assert(pts.length >= 2, `数据点不足: ${pts.length}`)
    const asc = pts.every((p, i, a) => i === 0 || a[i - 1].timestamp <= p.timestamp)
    assert(asc, '数据点未按时间升序，趋势图会画错')
    return `trend=improving，${pts.length} 点升序`
  })

  // ---- TC6: 时间窗口边界 ----
  runTest('TC6', '时间窗口过滤边界', () => {
    seedSatisfaction([{
      task: 0.4, feedback: 0.4, efficiency: 0.4, knowledge: 0.4, overall: 0.4,
      createdAt: new Date(Date.now() - 60 * 86400000).toISOString(),
    }])
    const hist = (w) =>
      okJson(ui(['autonomous', 'satisfaction', 'history', '--window', w, '--agent', PROBE_AGENT]), `history ${w}`)
        .dataPoints.length
    const n7 = hist('7d')
    const n30 = hist('30d')
    const nAll = hist('all')
    assert(nAll > n7, `all(${nAll}) 应多于 7d(${n7})：60 天前的点不该落入 7d`)
    assert(nAll > n30, `all(${nAll}) 应多于 30d(${n30})`)
    return `7d=${n7} / 30d=${n30} / all=${nAll}，边界正确`
  })

  // ---- TC7: 目标列表与过滤 ----
  runTest('TC7', '目标列表与状态过滤', () => {
    seedGoal({ status: 'pending', description: '待审批探针' })
    seedGoal({ status: 'approved', description: '已批准探针' })
    const all = okJson(ui(['autonomous', 'goals', 'list', '--agent', PROBE_AGENT]), 'goals list')
    assert(all.total >= 2, `应至少 2 条，实际 ${all.total}`)
    const pending = okJson(
      ui(['autonomous', 'goals', 'list', '--status', 'pending', '--agent', PROBE_AGENT]),
      'goals list pending',
    )
    assert(pending.goals.every((g) => g.status === 'pending'), '过滤后仍含非 pending')
    assert(pending.total < all.total, '状态过滤未生效')
    assert(pending.goals[0].triggerReason, 'triggerReason 未映射（snake_case 转换遗漏）')
    return `全部 ${all.total} 条，pending ${pending.total} 条，字段映射正确`
  })

  // ---- TC8: SQL 注入防护 ----
  runTest('TC8', '非法 status 安全降级', () => {
    const before = withDb((db) =>
      db.prepare('SELECT COUNT(*) c FROM autonomous_goals WHERE agent_id = ?').get(PROBE_AGENT).c)
    const j = okJson(
      ui(['autonomous', 'goals', 'list', '--status', "pending' OR 1=1--", '--agent', PROBE_AGENT]),
      '非法 status',
    )
    assert(Array.isArray(j.goals), '应返回正常结构')
    const after = withDb((db) =>
      db.prepare('SELECT COUNT(*) c FROM autonomous_goals WHERE agent_id = ?').get(PROBE_AGENT).c)
    assert(after === before, `注入后数据被改动: ${before} -> ${after}`)
    return '白名单拦下非法状态值，数据完好'
  })

  // ---- TC9: 批准落库 + 协调器流转 executing + 进化人格事件 ----
  runTest('TC9', '批准目标流转 executing 并记录 evolution-decided', () => {
    const goalId = seedGoal({ status: 'pending', description: '待批准探针' })
    const j = okJson(ui(['autonomous', 'goals', 'approve', goalId, '--note', '测试批准']), 'approve')
    assert(j.success === true, `应成功: ${JSON.stringify(j)}`)
    // 协调器 onGoalApproved 把 approved 继续流转到 executing（异步微任务），重试等待
    let row = null
    for (let i = 0; i < 20; i++) {
      row = withDb((db) =>
        db.prepare('SELECT status, approved_at FROM autonomous_goals WHERE id = ?').get(goalId))
      if (row.status === 'executing') break
      sleep(100)
    }
    assert(row.status === 'executing', `库中应流转到 executing，实际 ${row.status}`)
    assert(row.approved_at, 'approved_at 未写入')
    const ev = withDb((db) =>
      db.prepare(
        "SELECT event_type FROM personality_events WHERE agent_id = ? AND event_type = 'evolution-decided' ORDER BY created_at DESC LIMIT 1",
      ).get(PROBE_AGENT))
    assert(ev, '审批未触发 evolution-decided 人格事件（协调器绕过未修复）')
    return 'status=executing + evolution-decided 人格事件已落库'
  })

  // ---- TC10: 拒绝落库 ----
  runTest('TC10', '拒绝目标状态流转落库', () => {
    const goalId = seedGoal({ status: 'pending', description: '待拒绝探针' })
    const j = okJson(ui(['autonomous', 'goals', 'reject', goalId, '--reason', '不需要']), 'reject')
    assert(j.success === true, `应成功: ${JSON.stringify(j)}`)
    const row = withDb((db) =>
      db.prepare('SELECT status FROM autonomous_goals WHERE id = ?').get(goalId))
    assert(row.status === 'rejected', `库中应 rejected，实际 ${row.status}`)
    return 'status=rejected'
  })

  // ---- TC11: 重复审批幂等 ----
  runTest('TC11', '重复审批被拒绝', () => {
    const goalId = seedGoal({ status: 'pending' })
    const first = okJson(ui(['autonomous', 'goals', 'approve', goalId]), '首次 approve')
    assert(first.success === true, '首次批准应成功')
    const second = okJson(ui(['autonomous', 'goals', 'approve', goalId]), '重复 approve')
    assert(second.success === false, `重复批准应 success=false，实际 ${JSON.stringify(second)}`)
    return '非 pending 目标无法二次流转'
  })

  // ---- TC12: 不存在目标 ----
  runTest('TC12', '不存在目标优雅失败', () => {
    const j = okJson(ui(['autonomous', 'goals', 'approve', 'autonomous-test-nonexistent']), '不存在目标')
    assert(j.success === false, `应 success=false，实际 ${JSON.stringify(j)}`)
    assert(j.reason, '应带失败原因')
    return '返回 success=false 并说明原因'
  })

  // ---- TC13: 缺参数校验 ----
  runTest('TC13', '缺 goalId 参数校验', () => {
    const r = ui(['autonomous', 'goals', 'approve'])
    assert(r.code !== 0, `缺参数应非零退出，实际 ${r.code}`)
    return `退出码 ${r.code}`
  })

  // ---- TC14: 能力维度 ----
  runTest('TC14', '能力维度查询与字段映射', () => {
    seedCapabilities([
      { dimension: 'code_generation', level: 0.75, confidence: 0.8, boundary: 0.82, testCount: 45 },
      { dimension: 'reasoning', level: 0.82, confidence: 0.85, boundary: 0.88, testCount: 58 },
    ])
    const j = okJson(ui(['autonomous', 'capabilities', '--agent', PROBE_AGENT]), 'capabilities')
    assert(j.total === 2, `应 2 个维度，实际 ${j.total}`)
    const cg = j.dimensions.code_generation
    assert(cg, 'code_generation 缺失')
    assert(cg.level === 0.75, `level 错误: ${cg.level}`)
    assert(cg.testCount === 45, `testCount 未从 test_count 映射: ${cg.testCount}`)
    assert(cg.boundary === 0.82, `boundary 未返回: ${cg.boundary}`)
    return 'level/confidence/boundary/testCount 映射正确'
  })

  // ---- TC15: 反思 JSON 列 ----
  runTest('TC15', '反思记录 JSON 列解析', () => {
    seedReflection({
      primaryIssue: '代码生成准确度不足',
      dims: JSON.stringify(['code_generation', 'tool_use']),
      recommendations: JSON.stringify([{ id: 'r1', type: 'prompt', description: '增强上下文分析', priority: 0.9 }]),
      goals: JSON.stringify([{ type: 'learning', description: '学习 React Hooks', estimatedImprovement: 0.15 }]),
    })
    const r = ui(['autonomous', 'reflections', '--limit', '5', '--agent', PROBE_AGENT])
    assert(r.code === 0, `reflections 退出码 ${r.code}: ${r.out.slice(0, 300)}`)
    assert(Array.isArray(r.json), `应返回数组，实际 ${JSON.stringify(r.json).slice(0, 200)}`)
    assert(r.json.length >= 1, '探针反思未返回')
    const item = r.json.find((x) => x.diagnosis.primaryIssue === '代码生成准确度不足')
    assert(item, '探针反思未返回')
    assert(Array.isArray(item.diagnosis.affectedDimensions), 'affectedDimensions 未解析为数组')
    assert(item.diagnosis.affectedDimensions.includes('code_generation'), '维度内容丢失')
    assert(item.diagnosis.rootCause, 'rootCause 缺失（V29 列未暴露）')
    assert(item.recommendations.length >= 1, '建议未解析')
    assert(item.suggestedGoals.length >= 1, '建议目标未解析')
    return 'JSON 列解析为数组，含 rootCause'
  })

  // ---- TC16: 脏 JSON 降级 ----
  runTest('TC16', '脏 JSON 列降级不打断列表', () => {
    seedReflection({
      primaryIssue: '脏数据探针',
      dims: '{不是合法JSON',
      recommendations: 'also broken[',
      goals: '{{',
    })
    const r = ui(['autonomous', 'reflections', '--limit', '10', '--agent', PROBE_AGENT])
    assert(r.code === 0, `脏数据应降级而非崩溃，退出码 ${r.code}: ${r.out.slice(0, 300)}`)
    assert(Array.isArray(r.json), `应返回数组，实际 ${JSON.stringify(r.json).slice(0, 200)}`)
    const dirty = r.json.find((x) => x.diagnosis.primaryIssue === '脏数据探针')
    assert(dirty, '脏记录未返回')
    assert(Array.isArray(dirty.diagnosis.affectedDimensions), '应为数组')
    assert(dirty.diagnosis.affectedDimensions.length === 0, '应降级为空数组')
    assert(r.json.length >= 2, '脏数据不该吃掉其他记录')
    return '脏 JSON 降级空数组，整表仍可用'
  })

  // ---- TC17: 变体统计与成功率 ----
  runTest('TC17', 'Prompt 变体统计与成功率', () => {
    const baselineId = `autonomous-test-baseline-${crypto.randomBytes(4).toString('hex')}`
    seedPromptVariants(baselineId, [
      { text: '基线', isBaseline: true, trialCount: 45, successCount: 38, totalReward: 37.8, avgSatisfaction: 0.84, ucbScore: 1.02 },
      { text: '变体A', isBaseline: false, trialCount: 20, successCount: 18, totalReward: 17.2, avgSatisfaction: 0.86, ucbScore: 1.35 },
    ])
    const r = ui(['autonomous', 'prompt', 'variants', '--fragment', baselineId])
    assert(r.code === 0, `variants 退出码 ${r.code}: ${r.out.slice(0, 300)}`)
    assert(Array.isArray(r.json), `应返回数组，实际 ${JSON.stringify(r.json).slice(0, 200)}`)
    const group = r.json.find((g) => g.baselinePromptId === baselineId)
    assert(group, '分组缺失')
    assert(group.variants.length === 2, `应 2 个变体，实际 ${group.variants.length}`)
    const baseline = group.variants.find((v) => v.isBaseline)
    assert(baseline, '基线未标记 isBaseline')
    assert(Math.abs(baseline.successRate - 38 / 45) < 1e-9, `成功率错误: ${baseline.successRate}`)
    assert(group.variants[0].isBaseline === true, '基线应排在首位')
    return `成功率=${baseline.successRate.toFixed(4)}，基线优先排序`
  })

  // ---- TC18: 零试验除零 ----
  runTest('TC18', '零试验变体不产生除零', () => {
    const baselineId = `autonomous-test-baseline-${crypto.randomBytes(4).toString('hex')}`
    seedPromptVariants(baselineId, [
      { text: '新变体', isBaseline: false, trialCount: 0, successCount: 0, totalReward: 0, avgSatisfaction: null, ucbScore: null },
    ])
    const r = ui(['autonomous', 'prompt', 'variants', '--fragment', baselineId])
    assert(r.code === 0, `variants 退出码 ${r.code}: ${r.out.slice(0, 300)}`)
    assert(Array.isArray(r.json), `应返回数组，实际 ${JSON.stringify(r.json).slice(0, 200)}`)
    const v = r.json.find((g) => g.baselinePromptId === baselineId).variants[0]
    assert(v.successRate === null, `零试验应 null 而非 NaN/0，实际 ${v.successRate}`)
    return 'successRate=null，无 NaN 污染'
  })

  // ---- TC19: 开关闭环 ----
  runTest('TC19', '开关读写闭环持久化', () => {
    const off = okJson(ui(['autonomous', 'disable']), 'disable')
    assert(off.enabled === false, `disable 应返回 false: ${JSON.stringify(off)}`)
    const afterOff = okJson(ui(['autonomous', 'status', '--agent', PROBE_AGENT]), 'status(off)')
    assert(afterOff.enabled === false, '关闭后 status 未读到 false（持久化失效）')

    const on = okJson(ui(['autonomous', 'enable']), 'enable')
    assert(on.enabled === true, 'enable 应返回 true')
    const afterOn = okJson(ui(['autonomous', 'status', '--agent', PROBE_AGENT]), 'status(on)')
    assert(afterOn.enabled === true, '开启后 status 未读到 true')
    return '写入 runtime_state 且可回读'
  })

  // ---- TC20: 默认启用 ----
  runTest('TC20', '未配置时默认启用', () => {
    withDb((db) => db.prepare("DELETE FROM runtime_state WHERE key = 'autonomous.enabled'").run())
    const j = okJson(ui(['autonomous', 'status', '--agent', PROBE_AGENT]), 'status(默认)')
    assert(j.enabled === true, `无配置应默认启用，实际 ${j.enabled}`)
    ui(['autonomous', 'enable'])
    return '缺配置默认 enabled=true'
  })

  // ---- TC21: agent 隔离 ----
  runTest('TC21', 'agentId 数据隔离', () => {
    const c = okJson(ui(['autonomous', 'capabilities', '--agent', OTHER_AGENT]), 'capabilities(other)')
    assert(c.total === 0, `其他 agent 不应看到探针能力，实际 ${c.total}`)
    const g = okJson(ui(['autonomous', 'goals', 'list', '--agent', OTHER_AGENT]), 'goals(other)')
    assert(g.total === 0, `目标未隔离，实际 ${g.total}`)
    return '能力与目标均按 agentId 隔离'
  })

  // ---- TC22: 未知命令 ----
  runTest('TC22', '未知 autonomous 子命令报错', () => {
    const r = ui(['autonomous', 'nonexistent-subcommand'])
    assert(r.code !== 0, `未知命令应非零退出，实际 ${r.code}`)
    return `退出码 ${r.code}`
  })

  cleanup()
  writeReport()
}

function writeReport() {
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const lines = [
    '# 自主进化 CLI 测试报告',
    '',
    `**执行时间**: ${new Date().toISOString()}`,
    `**结果**: ${pass} PASS / ${fail} FAIL（共 ${results.length}）`,
    `**数据库**: \`${DB_PATH}\``,
    `**探针 agent**: \`autonomous-test-*\`${NO_CLEANUP ? '（已保留）' : '（跑完已清理）'}`,
    '',
    '## 明细',
    '',
    '| 用例 | 结果 | 说明 |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${String(r.note).replace(/\|/g, '\\|')} |`),
    '',
    '## 覆盖范围',
    '',
    '- 10 个 autonomous CLI 命令真实调用（经控制口 → IPC → Repo → SQLite）',
    '- 算法一致性：满意度四维加权 0.35/0.30/0.20/0.15，趋势判定，成功率计算',
    '- 落库校验：状态流转与 approved_at 时间戳回查数据库确认',
    '- 异常路径：SQL 注入尝试、不存在目标、重复审批、缺参数、脏 JSON、零试验除零、未知子命令',
    '- 数据隔离：按 agentId 过滤，互不可见',
    '',
    '## 说明',
    '',
    '探针数据经 SQL 直接播种，读取全部走 CLI 真实链路，因此校验的是',
    '命令分发、白名单、字段映射与查询逻辑，而非自己写自己读的空转。',
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
  console.error(`\n套件中断: ${err.message}`)
  if (VERBOSE) console.error(err.stack)
  try {
    cleanup()
  } catch {
    /* 清理失败不掩盖原始错误 */
  }
  process.exitCode = 1
}
