#!/usr/bin/env node
/**
 * 自主进化 CLI 命令测试脚本
 *
 * 测试所有新添加的 autonomous CLI 命令
 */

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const CLI_PATH = 'apps/windows/resources/app-ui-cli/lumii-ui.mjs'
const TEST_PREFIX = 'autonomous-cli-test-'

console.log('🧪 自主进化 CLI 命令测试\n')

// 测试命令列表
const tests = [
  {
    name: '查看状态',
    command: 'node apps/windows/resources/app-ui-cli/lumii-ui.mjs autonomous status',
  },
  {
    name: '列出目标',
    command: 'node apps/windows/resources/app-ui-cli/lumii-ui.mjs autonomous goals list',
  },
  {
    name: '列出待审批目标',
    command: 'node apps/windows/resources/app-ui-cli/lumii-ui.mjs autonomous goals list --status pending',
  },
  {
    name: '查看能力',
    command: 'node apps/windows/resources/app-ui-cli/lumii-ui.mjs autonomous capabilities',
  },
  {
    name: '查看反思',
    command: 'node apps/windows/resources/app-ui-cli/lumii-ui.mjs autonomous reflections --limit 3',
  },
  {
    name: '满意度历史（7天）',
    command: 'node apps/windows/resources/app-ui-cli/lumii-ui.mjs autonomous satisfaction history',
  },
  {
    name: '满意度历史（30天）',
    command: 'node apps/windows/resources/app-ui-cli/lumii-ui.mjs autonomous satisfaction history --window 30d',
  },
  {
    name: 'Prompt 变体',
    command: 'node apps/windows/resources/app-ui-cli/lumii-ui.mjs autonomous prompt variants',
  },
  {
    name: '启用自主进化',
    command: 'node apps/windows/resources/app-ui-cli/lumii-ui.mjs autonomous enable',
  },
  {
    name: '查看启用后状态',
    command: 'node apps/windows/resources/app-ui-cli/lumii-ui.mjs autonomous status',
  },
]

let passed = 0
let failed = 0

for (const test of tests) {
  process.stdout.write(`📝 ${test.name}... `)

  try {
    const output = execSync(test.command, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })

    // 检查输出是否为 JSON
    try {
      const result = JSON.parse(output)
      if (result.error) {
        console.log('❌ 失败:', result.error)
        failed++
      } else {
        console.log('✅ 通过')
        passed++
      }
    } catch {
      console.log('✅ 通过（非 JSON 输出）')
      passed++
    }
  } catch (error) {
    console.log('❌ 失败:', error.message)
    failed++
  }
}

console.log(`\n📊 测试结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
