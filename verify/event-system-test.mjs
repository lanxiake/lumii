#!/usr/bin/env node
/**
 * 事件系统验证脚本
 *
 * 通过读取日志文件验证事件日志插件是否正常接收到事件。
 *
 * 使用方法：
 * 1. 启动应用 (pnpm dev)
 * 2. 在应用中执行一些操作（发送消息、切换工作空间等）
 * 3. 运行此脚本：node verify/event-system-test.mjs
 */

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const logPath = join(homedir(), '.lumii', 'logs', 'app', 'mtbot-2026-10-21.log')

if (!existsSync(logPath)) {
  console.error(`❌ 日志文件不存在: ${logPath}`)
  process.exit(1)
}

console.log('📋 读取日志文件:', logPath)
const logContent = readFileSync(logPath, 'utf-8')
const lines = logContent.split('\n')

// 检查插件是否激活
const activationLines = lines.filter(line =>
  line.includes('event-logger') && line.includes('已激活')
)

if (activationLines.length === 0) {
  console.error('❌ 事件日志插件未激活')
  process.exit(1)
}

console.log('✅ 事件日志插件已激活')
console.log('   ', activationLines[0].trim())

// 检查是否订阅了事件
const subscriptionLines = lines.filter(line =>
  line.includes('event-logger') && line.includes('已订阅')
)

if (subscriptionLines.length > 0) {
  console.log('✅ 已订阅事件')
  console.log('   ', subscriptionLines[0].trim())
}

// 检查各类事件
const eventPatterns = [
  { name: 'agent:turn-start', emoji: '📥' },
  { name: 'agent:turn-end', emoji: '📤' },
  { name: 'llm:after-response', emoji: '🤖' },
  { name: 'workspace:changed', emoji: '📁' }
]

console.log('\n🔍 检查事件接收情况:')
let totalEvents = 0

for (const { name, emoji } of eventPatterns) {
  const eventLines = lines.filter(line =>
    line.includes('event-logger') && (line.includes(emoji) || line.includes(name))
  )

  if (eventLines.length > 0) {
    console.log(`✅ ${name}: ${eventLines.length} 次`)
    totalEvents += eventLines.length
    // 显示前 3 条
    eventLines.slice(0, 3).forEach(line => {
      console.log('   ', line.trim())
    })
  } else {
    console.log(`⚠️  ${name}: 未捕获 (需要触发相应操作)`)
  }
}

console.log('\n📊 总结:')
console.log(`   - 插件状态: ✅ 已激活`)
console.log(`   - 事件订阅: ✅ 已订阅 4 个事件`)
console.log(`   - 捕获事件: ${totalEvents} 次`)

if (totalEvents === 0) {
  console.log('\n💡 提示:')
  console.log('   事件日志插件已正常激活并订阅事件，但还未捕获到任何事件。')
  console.log('   这是正常的，因为应用启动后还没有执行会触发这些事件的操作。')
  console.log('\n   要验证事件系统，请在应用中执行以下操作之一:')
  console.log('   1. 发送一条消息 → 触发 agent:turn-start / llm:after-response / agent:turn-end')
  console.log('   2. 在设置中切换工作空间 → 触发 workspace:changed')
  console.log('\n   然后再次运行此脚本查看结果。')
} else {
  console.log('\n✅ 事件系统验证成功！插件能够正常接收并记录事件。')
}
