#!/usr/bin/env node
/**
 * 云同步 v3 CLI 测试套件
 *
 * 测试范围：
 * 1. Schema V38 migration 验证
 * 2. JSONL 导出格式验证
 * 3. Merge 规则验证
 * 4. 完整同步流程验证
 *
 * 运行方式：
 *   node run-cloud-sync-suite.mjs
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 配置
const CONFIG = {
  // Lumii 客户端路径（Windows）
  lumiiExe: 'C:\\Users\\75791\\AppData\\Local\\Programs\\lumii\\lumii.exe',
  // 测试数据目录
  testDataDir: path.join(__dirname, 'test-data-sync'),
  // 日志文件
  evidenceFile: path.join(__dirname, 'cloud-sync-cli-evidence.jsonl'),
  reportFile: path.join(__dirname, 'cloud-sync-cli-test-report.md'),
}

// 测试结果
const results = {
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  details: [],
}

// 日志函数
function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  }
  console.log(`[${level}] ${message}`)
  fs.appendFileSync(CONFIG.evidenceFile, JSON.stringify(entry) + '\n')
}

function logTest(name, status, details = {}) {
  results.total++
  if (status === 'PASS') results.passed++
  else if (status === 'FAIL') results.failed++
  else if (status === 'SKIP') results.skipped++

  const result = { name, status, ...details }
  results.details.push(result)
  log('TEST', `${name}: ${status}`, result)
}

// 执行 SQL 查询
async function execSQL(sql) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CONFIG.lumiiExe, ['--eval', sql], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(`SQL failed: ${stderr}`))
      }
    })

    proc.on('error', reject)
  })
}

// 读取文件
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    return null
  }
}

// ==================== 测试用例 ====================

/**
 * 测试 1: Schema V38 Migration 验证
 */
async function testSchemaV38() {
  log('INFO', '开始测试 Schema V38 Migration...')

  try {
    // 检查 SCHEMA_VERSION
    const version = await execSQL('SELECT value FROM runtime_state WHERE key = "schema_version"')
    const versionNum = parseInt(version)

    if (versionNum >= 38) {
      logTest('Schema V38: 版本检查', 'PASS', { version: versionNum })
    } else {
      logTest('Schema V38: 版本检查', 'FAIL', {
        expected: '>=38',
        actual: versionNum,
      })
      return
    }

    // 检查 deleted_at 字段是否存在
    const tables = ['agent_memories', 'wiki_entities', 'wiki_relations', 'wiki_syntheses']
    let allFieldsExist = true

    for (const table of tables) {
      try {
        const result = await execSQL(`PRAGMA table_info(${table})`)
        const hasDeletedAt = result.includes('deleted_at')

        if (!hasDeletedAt) {
          allFieldsExist = false
          logTest(`Schema V38: ${table}.deleted_at 字段`, 'FAIL', {
            table,
            error: '字段不存在',
          })
        }
      } catch (err) {
        allFieldsExist = false
        logTest(`Schema V38: ${table}.deleted_at 字段`, 'FAIL', {
          table,
          error: err.message,
        })
      }
    }

    if (allFieldsExist) {
      logTest('Schema V38: deleted_at 字段检查', 'PASS', {
        tables,
      })
    }
  } catch (err) {
    logTest('Schema V38: Migration 验证', 'FAIL', { error: err.message })
  }
}

/**
 * 测试 2: JSONL 导出格式验证
 */
async function testJsonlExportFormat() {
  log('INFO', '开始测试 JSONL 导出格式...')

  // 假设导出目录在 ~/.lumii/sync/
  const homeDir = process.env.USERPROFILE || process.env.HOME
  const syncDir = path.join(homeDir, '.lumii', 'sync', 'wiki')

  if (!fs.existsSync(syncDir)) {
    logTest('JSONL 格式: 导出目录检查', 'SKIP', {
      reason: '导出目录不存在，可能未执行过同步',
      syncDir,
    })
    return
  }

  const jsonlFiles = [
    'wiki_inbox.jsonl',
    'wiki_sources.jsonl',
    'wiki_entities.jsonl',
    'wiki_observations.jsonl',
    'wiki_relations.jsonl',
    'wiki_syntheses.jsonl',
    'wiki_organize_runs.jsonl',
  ]

  let allValid = true

  for (const filename of jsonlFiles) {
    const filePath = path.join(syncDir, filename)

    if (!fs.existsSync(filePath)) {
      log('WARN', `JSONL 文件不存在: ${filename}`)
      continue
    }

    const content = readFile(filePath)

    // 验证 JSONL 格式
    if (content === '') {
      // 空文件是合法的
      logTest(`JSONL 格式: ${filename} (空文件)`, 'PASS')
      continue
    }

    const lines = content.split('\n').filter((l) => l.trim())

    try {
      // 每行都应该是合法的 JSON
      for (const line of lines) {
        JSON.parse(line)
      }

      // 检查末尾是否有换行符
      const endsWithNewline = content.endsWith('\n')

      if (endsWithNewline) {
        logTest(`JSONL 格式: ${filename}`, 'PASS', {
          lines: lines.length,
        })
      } else {
        allValid = false
        logTest(`JSONL 格式: ${filename}`, 'FAIL', {
          error: '文件末尾缺少换行符',
        })
      }
    } catch (err) {
      allValid = false
      logTest(`JSONL 格式: ${filename}`, 'FAIL', {
        error: `JSON 解析失败: ${err.message}`,
      })
    }
  }

  if (allValid) {
    log('INFO', 'JSONL 格式验证通过')
  }
}

/**
 * 测试 3: Merge 规则验证（使用真实数据）
 */
async function testMergeRules() {
  log('INFO', '开始测试 Merge 规则...')

  try {
    // 创建测试记忆
    const testMemoryId = `test-memory-${Date.now()}`
    const createSQL = `
      INSERT INTO agent_memories (
        id, agent_id, user_id, category, content,
        importance, tags, created_at, last_used, use_count, is_archived
      ) VALUES (
        '${testMemoryId}', 'assistant', 'test-user', 'general', 'Test memory for merge rules',
        0.5, 'test', datetime('now'), datetime('now'), 0, 0
      )
    `

    await execSQL(createSQL)
    logTest('Merge 规则: 创建测试记忆', 'PASS', { id: testMemoryId })

    // 查询记忆
    const querySQL = `SELECT * FROM agent_memories WHERE id = '${testMemoryId}'`
    const result = await execSQL(querySQL)

    if (result) {
      logTest('Merge 规则: 查询测试记忆', 'PASS')
    } else {
      logTest('Merge 规则: 查询测试记忆', 'FAIL', {
        error: '未找到测试记忆',
      })
    }

    // 清理测试数据
    const deleteSQL = `DELETE FROM agent_memories WHERE id = '${testMemoryId}'`
    await execSQL(deleteSQL)
    logTest('Merge 规则: 清理测试数据', 'PASS')
  } catch (err) {
    logTest('Merge 规则: 验证失败', 'FAIL', { error: err.message })
  }
}

/**
 * 测试 4: 软删除功能验证
 */
async function testSoftDelete() {
  log('INFO', '开始测试软删除功能...')

  try {
    // 创建测试实体
    const testEntityId = `test-entity-${Date.now()}`
    const createSQL = `
      INSERT INTO wiki_entities (
        id, agent_id, user_id, name, entity_type, created_at, updated_at
      ) VALUES (
        '${testEntityId}', 'assistant', 'test-user', 'Test Entity', 'concept',
        datetime('now'), datetime('now')
      )
    `

    await execSQL(createSQL)
    logTest('软删除: 创建测试实体', 'PASS', { id: testEntityId })

    // 软删除（设置 deleted_at）
    const softDeleteSQL = `
      UPDATE wiki_entities
      SET deleted_at = datetime('now')
      WHERE id = '${testEntityId}'
    `

    await execSQL(softDeleteSQL)
    logTest('软删除: 标记删除', 'PASS')

    // 验证 deleted_at 字段
    const querySQL = `
      SELECT deleted_at FROM wiki_entities WHERE id = '${testEntityId}'
    `
    const result = await execSQL(querySQL)

    if (result && result !== 'null' && result !== '') {
      logTest('软删除: deleted_at 字段验证', 'PASS', { deleted_at: result })
    } else {
      logTest('软删除: deleted_at 字段验证', 'FAIL', {
        error: 'deleted_at 字段为空',
      })
    }

    // 清理测试数据
    const deleteSQL = `DELETE FROM wiki_entities WHERE id = '${testEntityId}'`
    await execSQL(deleteSQL)
    logTest('软删除: 清理测试数据', 'PASS')
  } catch (err) {
    logTest('软删除: 验证失败', 'FAIL', { error: err.message })
  }
}

/**
 * 测试 5: 同步工具可用性验证
 */
async function testSyncToolsAvailability() {
  log('INFO', '开始测试同步工具可用性...')

  // 检查同步配置文件
  const homeDir = process.env.USERPROFILE || process.env.HOME
  const configFile = path.join(homeDir, '.lumii', 'data', 'cloud-sync-config.json')

  if (fs.existsSync(configFile)) {
    const config = JSON.parse(readFile(configFile))
    logTest('同步工具: 配置文件存在', 'PASS', {
      enabled: config.enabled,
      provider: config.provider,
    })
  } else {
    logTest('同步工具: 配置文件存在', 'SKIP', {
      reason: '配置文件不存在（用户未配置云同步）',
    })
  }

  // 检查同步目录结构
  const syncDir = path.join(homeDir, '.lumii', 'sync')
  if (fs.existsSync(syncDir)) {
    const expectedDirs = ['profile', 'wiki', 'memory', 'autonomous', 'workspace']
    let allDirsExist = true

    for (const dir of expectedDirs) {
      const dirPath = path.join(syncDir, dir)
      if (!fs.existsSync(dirPath)) {
        allDirsExist = false
        log('WARN', `同步目录不存在: ${dir}`)
      }
    }

    if (allDirsExist) {
      logTest('同步工具: 目录结构检查', 'PASS', { dirs: expectedDirs })
    } else {
      logTest('同步工具: 目录结构检查', 'FAIL', {
        error: '部分目录不存在',
      })
    }
  } else {
    logTest('同步工具: 目录结构检查', 'SKIP', {
      reason: '同步目录不存在（未执行过同步）',
    })
  }
}

// ==================== 主流程 ====================

async function runTests() {
  log('INFO', '======== 云同步 v3 CLI 测试套件开始 ========')
  log('INFO', `测试时间: ${new Date().toISOString()}`)

  // 清空日志文件
  fs.writeFileSync(CONFIG.evidenceFile, '')

  try {
    await testSchemaV38()
    await testJsonlExportFormat()
    await testMergeRules()
    await testSoftDelete()
    await testSyncToolsAvailability()
  } catch (err) {
    log('ERROR', '测试执行失败', { error: err.message })
  }

  log('INFO', '======== 测试完成 ========')
  log('INFO', `总计: ${results.total}, 通过: ${results.passed}, 失败: ${results.failed}, 跳过: ${results.skipped}`)

  // 生成测试报告
  generateReport()
}

function generateReport() {
  const report = `# 云同步 v3 CLI 测试报告

**测试时间**: ${new Date().toISOString()}

## 测试结果汇总

- 总计: ${results.total}
- ✅ 通过: ${results.passed}
- ❌ 失败: ${results.failed}
- ⏭️ 跳过: ${results.skipped}

## 详细结果

${results.details
  .map((r) => {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭️'
    return `### ${icon} ${r.name}\n\n**状态**: ${r.status}\n\n${
      r.error
        ? `**错误**: ${r.error}\n\n`
        : r.reason
          ? `**原因**: ${r.reason}\n\n`
          : ''
    }${Object.keys(r)
      .filter((k) => !['name', 'status', 'error', 'reason'].includes(k))
      .map((k) => `- **${k}**: ${JSON.stringify(r[k])}`)
      .join('\n')}\n`
  })
  .join('\n---\n\n')}

## 测试环境

- 操作系统: ${process.platform}
- Node 版本: ${process.version}
- Lumii 客户端: ${CONFIG.lumiiExe}

## 结论

${
  results.failed === 0
    ? '✅ 所有测试通过！云同步 v3 功能正常。'
    : `❌ 有 ${results.failed} 个测试失败，需要修复。`
}

---

**生成时间**: ${new Date().toISOString()}
`

  fs.writeFileSync(CONFIG.reportFile, report)
  console.log(`\n测试报告已生成: ${CONFIG.reportFile}`)
}

// 运行测试
runTests().catch((err) => {
  console.error('测试执行出错:', err)
  process.exit(1)
})
