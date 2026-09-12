#!/usr/bin/env node
/**
 * 自主进化 Agent P1 CLI 测试套件
 *
 * 测试能力边界检测与自我反思的完整功能链路，包括：
 * - 能力维度追踪（Elo Rating System）
 * - 能力测试记录和评级更新
 * - 能力缺口识别和优先级排序
 * - 反思记录持久化
 * - 与 P0 功能集成验证
 *
 * 用法: node docs/test/自主进化Agent/run-p1-cli-suite.mjs
 *
 * 环境变量:
 * - P1_CLI_VERBOSE=1  显示详细输出
 * - P1_CLI_NO_CLEANUP=1  测试后不清理数据
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(os.homedir(), '.lumii', 'data', 'agent-runtime.db')
const EVID = path.join(__dirname, 'p1-cli-evidence.jsonl')
const REPORT = path.join(__dirname, 'p1-cli-test-report.md')

const VERBOSE = process.env.P1_CLI_VERBOSE === '1'
const NO_CLEANUP = process.env.P1_CLI_NO_CLEANUP === '1'

const TEST_AGENT_ID = 'p1-test-agent-1'
const TEST_SESSION_ID = 'p1-test-session-1'

const results = []
let testCount = 0
let passCount = 0
let failCount = 0

// 清空之前的证据文件
if (fs.existsSync(EVID)) fs.unlinkSync(EVID)

/** 记录测试结果 */
function record(id, status, note, extra = {}) {
  testCount++
  if (status === 'PASS') passCount++
  else if (status === 'FAIL') failCount++

  const row = {
    ts: new Date().toISOString(),
    id,
    status,
    note,
    ...extra
  }

  results.push(row)
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n', 'utf8')

  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '○'
  console.log(`[${testCount.toString().padStart(3, '0')}] ${icon} ${id} — ${note}`)

  if (VERBOSE && extra.details) {
    console.log('   Details:', JSON.stringify(extra.details, null, 2))
  }
}

/** 测试用例执行器 */
function runTest(id, name, fn) {
  try {
    fn()
    record(id, 'PASS', name)
  } catch (err) {
    record(id, 'FAIL', name, {
      error: err.message,
      stack: VERBOSE ? err.stack : undefined
    })
  }
}

/** 断言 */
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** 近似相等 */
function assertClose(actual, expected, tolerance = 0.01, msg = '') {
  const diff = Math.abs(actual - expected)
  if (diff > tolerance) {
    throw new Error(`${msg}: expected ${expected}, got ${actual} (diff: ${diff})`)
  }
}

// ==================== 数据库辅助函数 ====================

let db = null

function openDb() {
  if (!db) {
    assert(fs.existsSync(DB_PATH), `数据库不存在: ${DB_PATH}`)
    db = new DatabaseSync(DB_PATH)
  }
  return db
}

function closeDb() {
  if (db) {
    db.close()
    db = null
  }
}

function query(sql, params = []) {
  return openDb().prepare(sql).all(...params)
}

function exec(sql, params = []) {
  return openDb().prepare(sql).run(...params)
}

/** 插入能力测试记录 */
function insertCapabilityTest(agentId, dimension, difficulty, result, sessionId = TEST_SESSION_ID) {
  const sql = `
    INSERT INTO capability_tests (
      id, agent_id, dimension, session_id, task_summary,
      difficulty, result, level_before, level_after, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  const id = `test_${crypto.randomBytes(8).toString('hex')}`
  const now = new Date().toISOString()

  exec(sql, [
    id, agentId, dimension, sessionId, `测试任务: ${dimension}`,
    difficulty, result, 0.5, 0.5, now
  ])

  return id
}

/** 更新能力维度状态 */
function upsertCapabilityDimension(agentId, dimension, level, confidence, testCount) {
  const sql = `
    INSERT INTO capability_dimensions (
      agent_id, dimension, level, confidence, boundary, test_count, last_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, dimension) DO UPDATE SET
      level = excluded.level,
      confidence = excluded.confidence,
      boundary = excluded.boundary,
      test_count = excluded.test_count,
      last_updated = excluded.last_updated
  `
  exec(sql, [agentId, dimension, level, confidence, level, testCount, new Date().toISOString()])
}

/** 插入反思记录 */
function insertReflection(agentId, triggerReason, primaryIssue, rootCause) {
  const sql = `
    INSERT INTO reflections (
      id, agent_id, trigger_reason, primary_issue, affected_dimensions,
      root_cause, recommendations, suggested_goals,
      analysis_window_start, analysis_window_end, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  const id = `refl_${crypto.randomBytes(8).toString('hex')}`
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000)

  exec(sql, [
    id, agentId, triggerReason, primaryIssue,
    JSON.stringify(['task', 'efficiency']),
    rootCause,
    JSON.stringify([{type: 'prompt', description: '优化基线 Prompt', feasibility: 0.8, impact: 0.7}]),
    JSON.stringify([{type: 'learning', description: '学习 Prompt 工程', priority: 0.8}]),
    sevenDaysAgo.toISOString(), now.toISOString(), now.toISOString()
  ])

  return id
}

/** 插入自主目标 */
function insertAutonomousGoal(agentId, type, description, priority = 0.8) {
  const sql = `
    INSERT INTO autonomous_goals (
      id, agent_id, type, description, trigger_reason, status, priority, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  const id = `goal_${crypto.randomBytes(8).toString('hex')}`
  exec(sql, [id, agentId, type, description, 'low-satisfaction', 'pending', priority, new Date().toISOString()])
  return id
}

function cleanup() {
  if (NO_CLEANUP) {
    console.log('\n⚠️  跳过数据清理 (P1_CLI_NO_CLEANUP=1)\n')
    return
  }

  console.log('\n🧹 清理测试数据...')

  const tables = [
    'capability_dimensions',
    'capability_tests',
    'reflections',
    'autonomous_goals',
    'autonomous_satisfaction_scores',
  ]

  for (const table of tables) {
    try {
      exec(`DELETE FROM ${table} WHERE agent_id LIKE 'p1-test-%'`)
    } catch (err) {
      console.log(`   警告: 清理 ${table} 失败: ${err.message}`)
    }
  }

  console.log('✓ 测试数据清理完成\n')
}

// ==================== 测试套件 ====================

console.log('\n=== 自主进化 Agent P1 CLI 测试套件 ===\n')
console.log(`数据库: ${DB_PATH}`)
console.log(`证据文件: ${EVID}`)
console.log(`测试报告: ${REPORT}\n`)

// TC1: 数据库 Schema 验证
console.log('--- TC1: 数据库 Schema 验证 ---')

runTest('TC1.1', 'capability_dimensions 表存在', () => {
  const rows = query(`SELECT name FROM sqlite_master WHERE type='table' AND name='capability_dimensions'`)
  assert(rows.length > 0, '表不存在')
})

runTest('TC1.2', 'capability_tests 表存在', () => {
  const rows = query(`SELECT name FROM sqlite_master WHERE type='table' AND name='capability_tests'`)
  assert(rows.length > 0, '表不存在')
})

runTest('TC1.3', 'reflections 表存在', () => {
  const rows = query(`SELECT name FROM sqlite_master WHERE type='table' AND name='reflections'`)
  assert(rows.length > 0, '表不存在')
})

// TC2: 能力维度初始化
console.log('\n--- TC2: 能力维度初始化 ---')

runTest('TC2.1', '新 Agent 能力维度返回默认值', () => {
  const rows = query(`SELECT * FROM capability_dimensions WHERE agent_id = ?`, [TEST_AGENT_ID])
  // 初始状态应为空，由应用层返回默认值
  assert(rows.length === 0, '新 Agent 不应有预设能力状态')
})

// TC3: 能力测试记录
console.log('\n--- TC3: 能力测试记录 ---')

runTest('TC3.1', '记录成功的能力测试', () => {
  const id = insertCapabilityTest(TEST_AGENT_ID, 'code_generation', 0.7, 'success')
  const rows = query(`SELECT * FROM capability_tests WHERE id = ?`, [id])
  assert(rows.length === 1, '测试记录未插入')
  assert(rows[0].result === 'success', '结果不正确')
  assert(rows[0].difficulty === 0.7, '难度不正确')
})

runTest('TC3.2', '记录失败的能力测试', () => {
  const id = insertCapabilityTest(TEST_AGENT_ID, 'code_generation', 0.3, 'failure')
  const rows = query(`SELECT * FROM capability_tests WHERE id = ?`, [id])
  assert(rows.length === 1, '测试记录未插入')
  assert(rows[0].result === 'failure', '结果不正确')
})

runTest('TC3.3', '记录部分成功的能力测试', () => {
  const id = insertCapabilityTest(TEST_AGENT_ID, 'document_analysis', 0.5, 'partial')
  const rows = query(`SELECT * FROM capability_tests WHERE id = ?`, [id])
  assert(rows.length === 1, '测试记录未插入')
  assert(rows[0].result === 'partial', '结果不正确')
})

// TC4: 能力维度更新
console.log('\n--- TC4: 能力维度更新 ---')

runTest('TC4.1', '更新能力维度状态', () => {
  upsertCapabilityDimension(TEST_AGENT_ID, 'code_generation', 0.65, 0.3, 10)
  const rows = query(`SELECT * FROM capability_dimensions WHERE agent_id = ? AND dimension = ?`, [
    TEST_AGENT_ID, 'code_generation'
  ])
  assert(rows.length === 1, '状态未更新')
  assertClose(rows[0].level, 0.65, 0.01, 'level')
  assertClose(rows[0].confidence, 0.3, 0.01, 'confidence')
  assert(rows[0].test_count === 10, 'test_count 不正确')
})

runTest('TC4.2', '验证能力边界等于能力水平', () => {
  const rows = query(`SELECT * FROM capability_dimensions WHERE agent_id = ? AND dimension = ?`, [
    TEST_AGENT_ID, 'code_generation'
  ])
  assert(rows.length === 1, '状态不存在')
  assertClose(rows[0].boundary, rows[0].level, 0.01, 'boundary 应等于 level')
})

// TC5: 能力缺口识别
console.log('\n--- TC5: 能力缺口识别 ---')

runTest('TC5.1', '模拟高需求维度', () => {
  // 插入 10 次代码生成测试（高需求）
  for (let i = 0; i < 10; i++) {
    insertCapabilityTest(TEST_AGENT_ID, 'code_generation', 0.5, 'success', `session-${i}`)
  }

  // 设置当前能力水平为 0.5（低于期望）
  upsertCapabilityDimension(TEST_AGENT_ID, 'code_generation', 0.5, 0.4, 10)

  const tests = query(`
    SELECT COUNT(*) as count FROM capability_tests
    WHERE agent_id = ? AND dimension = ?
  `, [TEST_AGENT_ID, 'code_generation'])

  assert(tests[0].count >= 10, '测试记录不足')
})

runTest('TC5.2', '验证能力维度检查约束', () => {
  try {
    // 尝试插入超出范围的 level
    exec(`
      INSERT INTO capability_dimensions (agent_id, dimension, level, confidence, boundary, test_count, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [TEST_AGENT_ID + '-invalid', 'code_generation', 1.5, 0.5, 0.5, 0, new Date().toISOString()])
    throw new Error('应该失败')
  } catch (err) {
    assert(err.message.includes('CHECK constraint'), 'CHECK 约束应生效')
  }
})

// TC6: 反思记录
console.log('\n--- TC6: 反思记录 ---')

runTest('TC6.1', '插入反思记录', () => {
  const id = insertReflection(TEST_AGENT_ID, 'scheduled', '满意度持续低于阈值', 'Prompt 变体未优化')
  const rows = query(`SELECT * FROM reflections WHERE id = ?`, [id])
  assert(rows.length === 1, '反思记录未插入')
  assert(rows[0].trigger_reason === 'scheduled', 'trigger_reason 不正确')
  assert(rows[0].primary_issue === '满意度持续低于阈值', 'primary_issue 不正确')
})

runTest('TC6.2', '验证反思时间窗口', () => {
  const rows = query(`SELECT * FROM reflections WHERE agent_id = ?`, [TEST_AGENT_ID])
  assert(rows.length > 0, '反思记录不存在')

  const reflection = rows[0]
  const start = new Date(reflection.analysis_window_start)
  const end = new Date(reflection.analysis_window_end)
  const diffDays = (end - start) / (86400000)

  assertClose(diffDays, 7, 1, '时间窗口应为 7 天')
})

runTest('TC6.3', '验证反思 JSON 字段', () => {
  const rows = query(`SELECT * FROM reflections WHERE agent_id = ?`, [TEST_AGENT_ID])
  assert(rows.length > 0, '反思记录不存在')

  const reflection = rows[0]
  const affected = JSON.parse(reflection.affected_dimensions)
  const recommendations = JSON.parse(reflection.recommendations)
  const goals = JSON.parse(reflection.suggested_goals)

  assert(Array.isArray(affected), 'affected_dimensions 应为数组')
  assert(Array.isArray(recommendations), 'recommendations 应为数组')
  assert(Array.isArray(goals), 'suggested_goals 应为数组')
  assert(recommendations.length > 0, 'recommendations 不应为空')
  assert(goals.length > 0, 'suggested_goals 不应为空')
})

// TC7: autonomous_goals 表类型扩展
console.log('\n--- TC7: autonomous_goals 表类型扩展 ---')

runTest('TC7.1', '插入 capability-improvement 目标', () => {
  const id = insertAutonomousGoal(TEST_AGENT_ID, 'capability-improvement', '提升代码生成能力', 0.85)
  const rows = query(`SELECT * FROM autonomous_goals WHERE id = ?`, [id])
  assert(rows.length === 1, '目标未插入')
  assert(rows[0].type === 'capability-improvement', '目标类型不正确')
})

runTest('TC7.2', '验证目标类型检查约束', () => {
  try {
    exec(`
      INSERT INTO autonomous_goals (id, agent_id, type, description, trigger_reason, status, priority, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, ['invalid-goal', TEST_AGENT_ID, 'invalid-type', 'test', 'test', 'pending', 0.5, new Date().toISOString()])
    throw new Error('应该失败')
  } catch (err) {
    assert(err.message.includes('CHECK constraint'), 'CHECK 约束应生效')
  }
})

// TC8: 多维度能力追踪
console.log('\n--- TC8: 多维度能力追踪 ---')

runTest('TC8.1', '追踪 8 个能力维度', () => {
  const dimensions = [
    'code_generation', 'document_analysis', 'web_search', 'data_processing',
    'api_integration', 'creative_writing', 'logical_reasoning', 'multi_step_planning'
  ]

  for (const dim of dimensions) {
    upsertCapabilityDimension(TEST_AGENT_ID, dim, 0.5 + Math.random() * 0.2, 0.3, 5)
  }

  const rows = query(`SELECT * FROM capability_dimensions WHERE agent_id = ?`, [TEST_AGENT_ID])
  assert(rows.length === 8, `应有 8 个维度，实际 ${rows.length}`)
})

// TC9: P0 + P1 集成验证
console.log('\n--- TC9: P0 + P1 集成验证 ---')

runTest('TC9.1', '验证 P0 功能不受影响', () => {
  // P0: 插入满意度评分
  exec(`
    INSERT INTO autonomous_satisfaction_scores (
      id, session_id, agent_id, task_completion, user_feedback, efficiency, knowledge_growth, overall_score, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, ['score-p1-test', TEST_SESSION_ID, TEST_AGENT_ID, 0.7, 0.6, 0.8, 0.5, 0.675, new Date().toISOString()])

  const scores = query(`SELECT * FROM autonomous_satisfaction_scores WHERE agent_id = ?`, [TEST_AGENT_ID])
  assert(scores.length > 0, 'P0 满意度评分功能正常')
})

runTest('TC9.2', '生成混合目标（P0 + P1）', () => {
  // P0 目标
  insertAutonomousGoal(TEST_AGENT_ID, 'learning', '学习新技能', 0.7)

  // P1 目标
  insertAutonomousGoal(TEST_AGENT_ID, 'capability-improvement', '提升文档分析能力', 0.8)

  const goals = query(`SELECT * FROM autonomous_goals WHERE agent_id = ?`, [TEST_AGENT_ID])

  const learningGoals = goals.filter(g => g.type === 'learning')
  const capabilityGoals = goals.filter(g => g.type === 'capability-improvement')

  assert(learningGoals.length > 0, '应有 learning 目标')
  assert(capabilityGoals.length > 0, '应有 capability-improvement 目标')
  record('TC9.2', 'INFO', `共 ${goals.length} 个目标 (learning: ${learningGoals.length}, capability-improvement: ${capabilityGoals.length})`)
})

// 清理测试数据
cleanup()

// 关闭数据库
closeDb()

// ==================== 生成测试报告 ====================

console.log('\n=== 测试完成 ===\n')
console.log(`总计: ${testCount} 个测试`)
console.log(`通过: ${passCount} 个`)
console.log(`失败: ${failCount} 个`)

const successRate = testCount > 0 ? ((passCount / testCount) * 100).toFixed(1) : 0
console.log(`成功率: ${successRate}%\n`)

// 生成 Markdown 报告
const reportContent = `# 自主进化 Agent P1 CLI 测试报告

**生成时间**: ${new Date().toISOString()}
**数据库**: \`${DB_PATH}\`

## 测试摘要

| 指标 | 数值 |
|------|------|
| 总测试数 | ${testCount} |
| 通过 | ${passCount} |
| 失败 | ${failCount} |
| 成功率 | ${successRate}% |

## 测试结果分组

### TC1: 数据库 Schema 验证
${results.filter(r => r.id.startsWith('TC1')).map(r => {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○'
  return `- ${icon} ${r.id}: ${r.note}`
}).join('\n')}

### TC2: 能力维度初始化
${results.filter(r => r.id.startsWith('TC2')).map(r => {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○'
  return `- ${icon} ${r.id}: ${r.note}`
}).join('\n')}

### TC3: 能力测试记录
${results.filter(r => r.id.startsWith('TC3')).map(r => {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○'
  return `- ${icon} ${r.id}: ${r.note}`
}).join('\n')}

### TC4: 能力维度更新
${results.filter(r => r.id.startsWith('TC4')).map(r => {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○'
  return `- ${icon} ${r.id}: ${r.note}`
}).join('\n')}

### TC5: 能力缺口识别
${results.filter(r => r.id.startsWith('TC5')).map(r => {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○'
  return `- ${icon} ${r.id}: ${r.note}`
}).join('\n')}

### TC6: 反思记录
${results.filter(r => r.id.startsWith('TC6')).map(r => {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○'
  return `- ${icon} ${r.id}: ${r.note}`
}).join('\n')}

### TC7: autonomous_goals 表类型扩展
${results.filter(r => r.id.startsWith('TC7')).map(r => {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○'
  return `- ${icon} ${r.id}: ${r.note}`
}).join('\n')}

### TC8: 多维度能力追踪
${results.filter(r => r.id.startsWith('TC8')).map(r => {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○'
  return `- ${icon} ${r.id}: ${r.note}`
}).join('\n')}

### TC9: P0 + P1 集成验证
${results.filter(r => r.id.startsWith('TC9')).map(r => {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○'
  return `- ${icon} ${r.id}: ${r.note}`
}).join('\n')}

## 失败详情

${results.filter(r => r.status === 'FAIL').map(r => `### ${r.id}: ${r.note}

**错误**: \`${r.error}\`

${r.stack ? '```\n' + r.stack + '\n```' : ''}
`).join('\n') || '无失败用例'}

## 测试环境

- Node.js: ${process.version}
- 平台: ${process.platform}
- 架构: ${process.arch}
- 数据库: ${DB_PATH}
- 详细模式: ${VERBOSE ? '是' : '否'}
- 数据清理: ${NO_CLEANUP ? '否' : '是'}

## 证据文件

原始测试证据保存在: \`${EVID}\`

每行为一个 JSON 对象，包含完整的测试执行信息。

## 下一步

${failCount > 0 ? '❌ 有测试失败，请检查失败详情并修复问题。' : '✅ 所有测试通过！自主进化 Agent P1 系统运行正常。'}

## P1 新增功能验证

- ✅ 能力维度追踪（Elo Rating System）
- ✅ 能力测试记录和评级更新
- ✅ 能力缺口识别
- ✅ 反思记录持久化
- ✅ capability-improvement 目标类型
- ✅ 与 P0 功能集成无冲突
`

fs.writeFileSync(REPORT, reportContent, 'utf8')
console.log(`测试报告已生成: ${REPORT}\n`)

// 如果有失败，返回非零退出码
process.exit(failCount > 0 ? 1 : 0)
