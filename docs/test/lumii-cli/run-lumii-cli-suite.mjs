#!/usr/bin/env node
/**
 * Lumii CLI 通用功能测试套件
 * 覆盖 UI、Agent、Cron、Memory 等核心命令
 *
 * 用法：node docs/test/lumii-cli/run-lumii-cli-suite.mjs
 *
 * 环境变量：
 * - LUMII_CLI_VERBOSE=1  详细日志
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const LUMII_UI = path.join(ROOT, 'apps/windows/resources/app-ui-cli/lumii-ui.mjs')
const EVID = path.join(__dirname, 'lumii-cli-evidence.jsonl')
const REPORT = path.join(__dirname, 'lumii-cli-test-report.md')
const VERBOSE = process.env.LUMII_CLI_VERBOSE === '1'

const results = []

/** 调用 lumii-ui */
function ui(args, input, { retries = 3 } = {}) {
  let last = { code: 1, out: '', json: null, stderr: '' }
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync(process.execPath, [LUMII_UI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      maxBuffer: 20 * 1024 * 1024,
    })
    const out = (r.stdout || '')
    const stderr = (r.stderr || '')
    let json = null
    const trimmed = out.trim()
    if (trimmed) {
      try {
        json = JSON.parse(trimmed)
      } catch {
        /* 非 JSON 输出 */
      }
    }
    last = { code: r.status ?? 1, out, stderr, json }
    if (json?.error !== 'rate_limited' && !/rate_limited/.test(out)) return last
    sleep(5000 * (i + 1))
  }
  return last
}

function record(id, status, note, extra = {}) {
  const row = { ts: new Date().toISOString(), id, status, note, ...extra }
  results.push(row)
  fs.appendFileSync(EVID, JSON.stringify(row) + '\n', 'utf8')
  const emoji = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⚠️'
  console.log(`${emoji} [${id}] ${status} — ${note}`)
  if (VERBOSE && extra.output) {
    console.log(`   输出: ${extra.output.substring(0, 200)}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function asArray(v) {
  return Array.isArray(v) ? v : null
}

/** ============ 测试用例 ============ */

function runTests() {
  console.log('🚀 开始 Lumii CLI 测试套件\n')

  // 清空旧证据
  if (fs.existsSync(EVID)) fs.unlinkSync(EVID)

  // 记录测试开始
  record('TEST_START', 'info', `开始测试，时间: ${new Date().toISOString()}`)

  // A. 基础命令测试
  console.log('━'.repeat(60))
  testHelp()
  testScreenshot()
  testGoto()

  // B. Wiki 功能测试
  console.log('━'.repeat(60))
  testWikiOverview()
  testWikiSearch()

  // C. Agent 功能测试
  console.log('━'.repeat(60))
  testAgentList()

  // D. Cron 功能测试
  console.log('━'.repeat(60))
  testCronList()

  // E. Memory 功能测试
  console.log('━'.repeat(60))
  testMemorySearch()

  // F. 错误处理测试
  console.log('━'.repeat(60))
  testErrorHandling()

  // 记录测试结束
  record('TEST_END', 'info', `测试结束，时间: ${new Date().toISOString()}`)

  // 生成报告
  console.log('━'.repeat(60))
  generateReport()
}

/** ============ A. 基础命令测试 ============ */

function testHelp() {
  console.log('\n📋 A. 基础命令测试\n')

  // A.G1: 主帮助
  try {
    const r = ui(['help'])
    if (r.code === 0 && r.out.includes('看') && r.out.includes('动')) {
      record('A.G1', 'pass', 'help 命令返回分组列表')
    } else {
      record('A.G1', 'fail', 'help 未返回预期内容', { output: r.out })
    }
  } catch (e) {
    record('A.G1', 'fail', `help 异常: ${e.message}`)
  }

  // A.G3: JSON 格式帮助
  try {
    const r = ui(['help', '--json'])
    if (r.code === 0 && r.json && Array.isArray(r.json)) {
      record('A.G3', 'pass', `help --json 返回 ${r.json.length} 个命令`)
    } else {
      record('A.G3', 'fail', 'help --json 未返回有效 JSON', { output: r.out })
    }
  } catch (e) {
    record('A.G3', 'fail', `help --json 异常: ${e.message}`)
  }
}

function testScreenshot() {
  // A1: 基础截图
  try {
    const r = ui(['screenshot'])
    if (r.code === 0 && r.json) {
      const hasJpeg = typeof r.json.jpeg === 'string' && r.json.jpeg.length > 100
      const hasElements = Array.isArray(r.json.elements)
      if (hasJpeg && hasElements) {
        record('A1', 'pass', `screenshot 返回截图和 ${r.json.elements.length} 个元素`)
      } else {
        record('A1', 'fail', 'screenshot 返回数据不完整', {
          hasJpeg,
          hasElements,
          output: JSON.stringify(r.json).substring(0, 200)
        })
      }
    } else {
      record('A1', 'fail', 'screenshot 未成功', { code: r.code, output: r.out })
    }
  } catch (e) {
    record('A1', 'fail', `screenshot 异常: ${e.message}`)
  }

  // A2: 标注截图
  try {
    const r = ui(['screenshot', '--annotate'])
    if (r.code === 0 && r.json) {
      const hasSnapshotId = typeof r.json.snapshotId === 'string'
      const hasJpeg = typeof r.json.jpeg === 'string'
      if (hasSnapshotId && hasJpeg) {
        record('A2', 'pass', `screenshot --annotate 返回 snapshotId: ${r.json.snapshotId.substring(0, 8)}...`)
      } else {
        record('A2', 'fail', 'screenshot --annotate 缺少字段', { hasSnapshotId, hasJpeg })
      }
    } else {
      record('A2', 'fail', 'screenshot --annotate 失败', { code: r.code })
    }
  } catch (e) {
    record('A2', 'fail', `screenshot --annotate 异常: ${e.message}`)
  }
}

function testGoto() {
  // A3: 页面导航
  const views = ['dashboard', 'settings', 'chat']
  for (const view of views) {
    try {
      const r = ui(['goto', '--view', view])
      if (r.code === 0 && r.json?.success) {
        record(`A3.${view}`, 'pass', `goto --view ${view} 成功`)
      } else {
        record(`A3.${view}`, 'fail', `goto --view ${view} 失败`, { code: r.code, json: r.json })
      }
    } catch (e) {
      record(`A3.${view}`, 'fail', `goto --view ${view} 异常: ${e.message}`)
    }
    sleep(500) // 避免过快切换
  }
}

/** ============ B. Wiki 功能测试 ============ */

function testWikiOverview() {
  console.log('\n📚 B. Wiki 功能测试\n')

  // B1: Wiki 概览
  try {
    const r = ui(['wiki', 'overview'])
    if (r.code === 0 && r.json) {
      const hasSources = typeof r.json.sources === 'number'
      const hasEntities = typeof r.json.entities === 'number'
      if (hasSources) {
        record('B1', 'pass', `wiki overview 返回 ${r.json.sources} 个资料`, { json: r.json })
      } else {
        record('B1', 'fail', 'wiki overview 返回数据不完整', { json: r.json })
      }
    } else {
      record('B1', 'fail', 'wiki overview 失败', { code: r.code, output: r.out })
    }
  } catch (e) {
    record('B1', 'fail', `wiki overview 异常: ${e.message}`)
  }
}

function testWikiSearch() {
  // B2: Wiki 搜索
  try {
    const r = ui(['wiki', 'search', '--q', 'test'])
    if (r.code === 0 && r.json) {
      const results = asArray(r.json.results) || asArray(r.json)
      if (results) {
        record('B2', 'pass', `wiki search 返回 ${results.length} 个结果`)
      } else {
        record('B2', 'warn', 'wiki search 返回格式异常', { json: r.json })
      }
    } else {
      record('B2', 'warn', 'wiki search 失败（可能无匹配结果）', { code: r.code })
    }
  } catch (e) {
    record('B2', 'fail', `wiki search 异常: ${e.message}`)
  }
}

/** ============ C. Agent 功能测试 ============ */

function testAgentList() {
  console.log('\n🤖 C. Agent 功能测试\n')

  // C1: Agent 列表
  try {
    const r = ui(['agent', 'list'])
    if (r.code === 0 && r.json) {
      const agents = asArray(r.json.agents) || asArray(r.json)
      if (agents) {
        record('C1', 'pass', `agent list 返回 ${agents.length} 个 Agent`)
      } else {
        record('C1', 'fail', 'agent list 返回格式异常', { json: r.json })
      }
    } else {
      record('C1', 'fail', 'agent list 失败', { code: r.code, output: r.out })
    }
  } catch (e) {
    record('C1', 'fail', `agent list 异常: ${e.message}`)
  }
}

/** ============ D. Cron 功能测试 ============ */

function testCronList() {
  console.log('\n⏰ D. Cron 功能测试\n')

  // D1: Cron 列表
  try {
    const r = ui(['cron', 'list'])
    if (r.code === 0 && r.json) {
      const crons = asArray(r.json.crons) || asArray(r.json)
      if (crons !== null) {
        record('D1', 'pass', `cron list 返回 ${crons.length} 个任务`)
      } else {
        record('D1', 'fail', 'cron list 返回格式异常', { json: r.json })
      }
    } else {
      record('D1', 'fail', 'cron list 失败', { code: r.code, output: r.out })
    }
  } catch (e) {
    record('D1', 'fail', `cron list 异常: ${e.message}`)
  }
}

/** ============ E. Memory 功能测试 ============ */

function testMemorySearch() {
  console.log('\n🧠 E. Memory 功能测试\n')

  // E1: Memory 搜索
  try {
    const r = ui(['memory', 'search', '--q', 'user'])
    if (r.code === 0 && r.json) {
      const memories = asArray(r.json.memories) || asArray(r.json.results) || asArray(r.json)
      if (memories !== null) {
        record('E1', 'pass', `memory search 返回 ${memories.length} 个记忆`)
      } else {
        record('E1', 'warn', 'memory search 返回格式异常', { json: r.json })
      }
    } else {
      record('E1', 'warn', 'memory search 失败（可能无匹配结果）', { code: r.code })
    }
  } catch (e) {
    record('E1', 'fail', `memory search 异常: ${e.message}`)
  }
}

/** ============ F. 错误处理测试 ============ */

function testErrorHandling() {
  console.log('\n🚨 F. 错误处理测试\n')

  // F1: 无效命令
  try {
    const r = ui(['invalid-command-xyz'])
    if (r.code !== 0 && (r.out.includes('Unknown') || r.stderr.includes('Unknown'))) {
      record('F1', 'pass', '无效命令正确返回错误')
    } else {
      record('F1', 'fail', '无效命令未正确处理', { code: r.code, output: r.out })
    }
  } catch (e) {
    record('F1', 'fail', `无效命令测试异常: ${e.message}`)
  }

  // F2: 缺少必需参数
  try {
    const r = ui(['goto']) // 缺少 --view
    if (r.code !== 0) {
      record('F2', 'pass', '缺少参数正确返回错误', { code: r.code })
    } else {
      record('F2', 'fail', '缺少参数未检测', { code: r.code })
    }
  } catch (e) {
    record('F2', 'fail', `缺少参数测试异常: ${e.message}`)
  }
}

/** ============ 报告生成 ============ */

function generateReport() {
  console.log('\n📊 生成测试报告\n')

  const passed = results.filter(r => r.status === 'pass').length
  const failed = results.filter(r => r.status === 'fail').length
  const warned = results.filter(r => r.status === 'warn').length
  const total = results.length

  const passRate = ((passed / total) * 100).toFixed(1)

  const report = `# Lumii CLI 测试报告

**生成时间**: ${new Date().toISOString()}
**总用例数**: ${total}
**通过**: ${passed} ✅
**失败**: ${failed} ❌
**警告**: ${warned} ⚠️
**通过率**: ${passRate}%

## 测试结果

| ID | 状态 | 说明 |
|---|---|---|
${results.map(r => `| ${r.id} | ${r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⚠️'} | ${r.note} |`).join('\n')}

## P0 测试状态

- A.G1 (help): ${results.find(r => r.id === 'A.G1')?.status || 'skip'}
- A1 (screenshot): ${results.find(r => r.id === 'A1')?.status || 'skip'}
- A3 (goto): ${results.filter(r => r.id.startsWith('A3.')).every(r => r.status === 'pass') ? 'pass' : 'fail'}
- B1 (wiki overview): ${results.find(r => r.id === 'B1')?.status || 'skip'}
- C1 (agent list): ${results.find(r => r.id === 'C1')?.status || 'skip'}
- D1 (cron list): ${results.find(r => r.id === 'D1')?.status || 'skip'}
- F1 (错误处理): ${results.find(r => r.id === 'F1')?.status || 'skip'}

## 详细证据

见 [lumii-cli-evidence.jsonl](./lumii-cli-evidence.jsonl)
`

  fs.writeFileSync(REPORT, report, 'utf8')
  console.log(`\n✅ 测试完成！`)
  console.log(`   通过: ${passed}/${total} (${passRate}%)`)
  console.log(`   失败: ${failed}`)
  console.log(`   警告: ${warned}`)
  console.log(`\n📄 报告: ${REPORT}`)
  console.log(`📋 证据: ${EVID}`)

  // 如果有失败用例，退出码为 1
  process.exit(failed > 0 ? 1 : 0)
}

/** ============ 主入口 ============ */

// 先检查控制口是否可用
console.log('🔍 检查 Lumii 应用状态...\n')
const pingTest = ui(['help'])
if (pingTest.code === 3 || pingTest.out.includes('ECONNREFUSED') || pingTest.out.includes('connection_failed')) {
  console.error('❌ Lumii 应用未运行！')
  console.error('\n请先启动应用：')
  console.error('  1. 打开 Lumii 桌面应用')
  console.error('  2. 或运行 pnpm dev (开发模式)')
  console.error('  3. 确保控制口已启动（默认端口见 ~/.lumii/runtime/app-ui.json）')
  console.error('\n然后重新运行此测试套件。')
  process.exit(3)
}

console.log('✅ Lumii 应用已运行，开始测试...\n')
runTests()
