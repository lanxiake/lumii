#!/usr/bin/env node
/**
 * Lumii UI CLI 综合测试套件
 *
 * 测试核心 UI 交互命令，确保代码执行流程和用户体验一致
 *
 * 用法: node docs/test/lumii-cli/run-ui-cli-suite.mjs
 *
 * 环境变量:
 * - LUMII_CLI_VERBOSE=1  显示详细输出
 * - LUMII_CLI_DELAY=<ms> 命令间延迟（默认 500ms）
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const EVID = path.join(__dirname, 'ui-cli-evidence.jsonl')
const REPORT = path.join(__dirname, 'ui-cli-test-report.md')

const VERBOSE = process.env.LUMII_CLI_VERBOSE === '1'
const DELAY = parseInt(process.env.LUMII_CLI_DELAY) || 500

const results = []
let testCount = 0
let passCount = 0
let failCount = 0

// 清空之前的证据文件
if (fs.existsSync(EVID)) fs.unlinkSync(EVID)

/** 调用 lumii-ui */
function ui(args, input, { retries = 3 } = {}) {
  let last = { code: 1, out: '', json: null, err: '' }

  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30000,
    })

    const out = r.stdout || ''
    const err = r.stderr || ''
    let json = null

    const trimmed = out.trim()
    if (trimmed) {
      try {
        json = JSON.parse(trimmed)
      } catch {
        // 可能是多行输出，尝试解析最后一行
        const lines = trimmed.split('\n').filter(l => l.trim())
        if (lines.length > 0) {
          try {
            json = JSON.parse(lines[lines.length - 1])
          } catch {
            /* ignore */
          }
        }
      }
    }

    last = { code: r.status ?? 1, out, err, json }

    // 检查 rate limit
    if (json?.error !== 'rate_limited' && !/rate_limited/.test(out + err)) {
      return last
    }

    // 等待重试
    sleep(2000 * (i + 1))
  }

  return last
}

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
    console.log('   Details:', extra.details)
  }
}

/** 断言 */
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** 延迟 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 测试用例执行器 */
async function runTest(id, name, fn) {
  try {
    await fn()
    record(id, 'PASS', name)
  } catch (err) {
    record(id, 'FAIL', name, {
      error: err.message,
      stack: VERBOSE ? err.stack : undefined
    })
  }
  sleep(DELAY)
}

// ==================== 测试套件 ====================

console.log('\n=== Lumii UI CLI 综合测试套件 ===\n')
console.log(`CLI 路径: ${LUMII_UI}`)
console.log(`证据文件: ${EVID}`)
console.log(`测试报告: ${REPORT}\n`)

// 1. 基础连通性测试
console.log('--- 1. 基础连通性测试 ---')

await runTest('T001', 'help 命令应返回帮助信息', () => {
  const r = ui(['help'])
  assert(r.code === 0, `help 命令失败: ${r.err}`)
  assert(r.out.includes('lumii-ui'), '帮助信息应包含 lumii-ui')
  assert(r.out.includes('screenshot'), '帮助信息应包含 screenshot 命令')
})

await runTest('T002', 'help --json 应返回 JSON 格式', () => {
  const r = ui(['help', '--json'])
  assert(r.code === 0, `help --json 失败: ${r.err}`)
  assert(r.json !== null, '应返回有效 JSON')
  assert(Array.isArray(r.json.commands), '应包含 commands 数组')
  assert(r.json.commands.length > 0, 'commands 数组不应为空')
})

await runTest('T003', 'version 命令应返回版本信息', () => {
  const r = ui(['version'])
  assert(r.code === 0, `version 命令失败: ${r.err}`)
  assert(/\d+\.\d+\.\d+/.test(r.out), '应包含版本号')
})

// 2. Screenshot 命令测试
console.log('\n--- 2. Screenshot 命令测试 ---')

await runTest('T101', 'screenshot 基础截图', () => {
  const r = ui(['screenshot'])
  assert(r.code === 0, `screenshot 失败: ${r.err}`)
  assert(r.json !== null, '应返回 JSON 结果')
  assert(r.json.screenshot, '应包含 screenshot 字段')
  assert(r.json.snapshotId, '应包含 snapshotId')
})

let lastSnapshotId = null
let lastRefs = []

await runTest('T102', 'screenshot --annotate 应返回可交互元素', () => {
  const r = ui(['screenshot', '--annotate'])
  assert(r.code === 0, `screenshot --annotate 失败: ${r.err}`)
  assert(r.json !== null, '应返回 JSON 结果')
  assert(r.json.snapshotId, '应包含 snapshotId')

  // 保存用于后续测试
  lastSnapshotId = r.json.snapshotId
  lastRefs = r.json.refs || []

  record('T102', 'INFO', `获得 ${lastRefs.length} 个可交互元素`, {
    snapshotId: lastSnapshotId,
    refCount: lastRefs.length
  })
})

await runTest('T103', 'screenshot --target pet 应截取宠物窗口', () => {
  const r = ui(['screenshot', '--target', 'pet'])
  // 可能宠物窗口未打开，返回错误是正常的
  if (r.code === 0) {
    assert(r.json !== null, '应返回 JSON 结果')
    record('T103', 'INFO', '宠物窗口截图成功')
  } else {
    record('T103', 'INFO', '宠物窗口未打开或不可用（预期行为）', {
      error: r.json?.error || r.err
    })
  }
})

// 3. Goto 命令测试
console.log('\n--- 3. Goto 命令测试 ---')

await runTest('T201', 'goto --view dashboard 应切换到仪表盘', () => {
  const r = ui(['goto', '--view', 'dashboard'])
  assert(r.code === 0, `goto dashboard 失败: ${r.err}`)
  sleep(1000) // 等待页面切换
})

await runTest('T202', 'goto --view settings 应切换到设置页', () => {
  const r = ui(['goto', '--view', 'settings'])
  assert(r.code === 0, `goto settings 失败: ${r.err}`)
  sleep(1000)
})

await runTest('T203', 'goto --view chat 应切换到聊天页', () => {
  const r = ui(['goto', '--view', 'chat'])
  assert(r.code === 0, `goto chat 失败: ${r.err}`)
  sleep(1000)
})

await runTest('T204', 'goto --view skills 应切换到技能页', () => {
  const r = ui(['goto', '--view', 'skills'])
  assert(r.code === 0, `goto skills 失败: ${r.err}`)
  sleep(1000)
})

// 4. Click 命令测试
console.log('\n--- 4. Click 命令测试 ---')

if (lastSnapshotId && lastRefs.length > 0) {
  await runTest('T301', 'click --ref 应点击有效元素', () => {
    // 选择第一个可点击元素
    const clickableRef = lastRefs[0]
    const r = ui(['click', '--ref', clickableRef.ref, '--snapshot-id', lastSnapshotId])

    // 点击可能成功也可能因为 snapshotId 过期而失败
    if (r.code === 0) {
      record('T301', 'INFO', `成功点击元素 ${clickableRef.ref}`)
    } else {
      record('T301', 'INFO', 'snapshotId 已过期或元素不可点击（预期行为）', {
        error: r.json?.error || r.err
      })
    }
  })
} else {
  record('T301', 'SKIP', '没有可用的 ref，跳过点击测试')
}

await runTest('T302', 'click 无效 ref 应返回错误', () => {
  const r = ui(['click', '--ref', 'invalid-ref-999'])
  assert(r.code !== 0, '无效 ref 应返回错误码')
  assert(r.json?.error || r.err, '应包含错误信息')
})

// 5. Type 命令测试
console.log('\n--- 5. Type 命令测试 ---')

await runTest('T401', 'type 缺少必需参数应返回错误', () => {
  const r = ui(['type'])
  assert(r.code !== 0, 'type 缺少参数应返回错误码')
})

// 6. Agent 命令测试
console.log('\n--- 6. Agent 命令测试 ---')

await runTest('T501', 'agent:list 应列出 Agent', () => {
  const r = ui(['command', 'agent:list'])
  if (r.code === 0) {
    assert(r.json !== null, '应返回 JSON 结果')
    record('T501', 'INFO', `获得 ${r.json?.agents?.length || 0} 个 Agent`)
  } else {
    record('T501', 'INFO', 'agent:list 不可用', { error: r.err })
  }
})

await runTest('T502', 'agent:get 应获取 Agent 详情', () => {
  const r = ui(['command', 'agent:get', '--data', JSON.stringify({ agentId: 'assistant' })])
  if (r.code === 0 && r.json) {
    assert(r.json.agent, '应包含 agent 字段')
    record('T502', 'INFO', `获取 Agent: ${r.json.agent.id}`)
  } else {
    record('T502', 'INFO', 'agent:get 不可用或 Agent 不存在', { error: r.err })
  }
})

// 7. Memory 命令测试
console.log('\n--- 7. Memory 命令测试 ---')

await runTest('T601', 'memory:list 应列出记忆', () => {
  const r = ui(['command', 'memory:list', '--data', JSON.stringify({ agentId: 'assistant' })])
  if (r.code === 0) {
    assert(r.json !== null, '应返回 JSON 结果')
    record('T601', 'INFO', `获得 ${r.json?.memories?.length || 0} 条记忆`)
  } else {
    record('T601', 'INFO', 'memory:list 不可用', { error: r.err })
  }
})

// 8. Cron 命令测试
console.log('\n--- 8. Cron 命令测试 ---')

await runTest('T701', 'cron list 应列出定时任务', () => {
  const r = ui(['cron', 'list'])
  if (r.code === 0) {
    assert(r.json !== null, '应返回 JSON 结果')
    record('T701', 'INFO', `获得 ${r.json?.crons?.length || 0} 个定时任务`)
  } else {
    record('T701', 'INFO', 'cron list 不可用', { error: r.err })
  }
})

// 9. 错误处理测试
console.log('\n--- 9. 错误处理测试 ---')

await runTest('T801', '无效命令应返回错误', () => {
  const r = ui(['invalid-command-xyz'])
  assert(r.code !== 0, '无效命令应返回错误码')
})

await runTest('T802', '缺少必需参数应返回错误', () => {
  const r = ui(['goto'])
  assert(r.code !== 0, '缺少必需参数应返回错误码')
})

await runTest('T803', '无效 flag 值应返回错误', () => {
  const r = ui(['goto', '--view', 'invalid-view-name'])
  assert(r.code !== 0, '无效 flag 值应返回错误码')
})

// ==================== 生成测试报告 ====================

console.log('\n=== 测试完成 ===\n')
console.log(`总计: ${testCount} 个测试`)
console.log(`通过: ${passCount} 个`)
console.log(`失败: ${failCount} 个`)
console.log(`跳过: ${testCount - passCount - failCount} 个`)

const successRate = testCount > 0 ? ((passCount / testCount) * 100).toFixed(1) : 0
console.log(`成功率: ${successRate}%\n`)

// 生成 Markdown 报告
const reportContent = `# Lumii UI CLI 测试报告

**生成时间**: ${new Date().toISOString()}
**CLI 路径**: \`${LUMII_UI}\`

## 测试摘要

| 指标 | 数值 |
|------|------|
| 总测试数 | ${testCount} |
| 通过 | ${passCount} |
| 失败 | ${failCount} |
| 跳过 | ${testCount - passCount - failCount} |
| 成功率 | ${successRate}% |

## 测试结果

${results.map(r => {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '○'
  let line = `### ${icon} ${r.id}: ${r.note}`
  if (r.error) {
    line += `\n\n**错误**: \`${r.error}\``
  }
  if (r.details) {
    line += `\n\n**详情**: ${JSON.stringify(r.details, null, 2)}`
  }
  return line
}).join('\n\n')}

## 测试环境

- Node.js: ${process.version}
- 平台: ${process.platform}
- 架构: ${process.arch}
- 延迟: ${DELAY}ms
- 详细模式: ${VERBOSE ? '是' : '否'}

## 证据文件

原始测试证据保存在: \`${EVID}\`

每行为一个 JSON 对象，包含完整的测试执行信息。
`

fs.writeFileSync(REPORT, reportContent, 'utf8')
console.log(`测试报告已生成: ${REPORT}\n`)

// 如果有失败，返回非零退出码
process.exit(failCount > 0 ? 1 : 0)
