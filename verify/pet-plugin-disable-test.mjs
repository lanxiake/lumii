#!/usr/bin/env node
/**
 * 桌宠插件禁用功能验证
 *
 * 验证点:
 * 1. 禁用配置能正确读取
 * 2. 禁用后插件不激活
 * 3. 启用后插件正常工作
 *
 * 使用方法:
 * 1. node verify/pet-plugin-disable-test.mjs --disable  # 禁用桌宠
 * 2. 启动应用,检查日志中是否有 "扩展已按配置禁用: com.lumii.pet"
 * 3. 尝试切换宠物模式,应该失败
 * 4. node verify/pet-plugin-disable-test.mjs --enable   # 启用桌宠
 * 5. 重启应用,桌宠应该正常工作
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const stateDir = join(homedir(), '.lumii', 'state')
const configPath = join(stateDir, 'extensions.json')

function readConfig() {
  if (!existsSync(configPath)) {
    return { version: 2, disabled: [], disabledClient: [] }
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return { version: 2, disabled: [], disabledClient: [] }
  }
}

function writeConfig(config) {
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
}

const args = process.argv.slice(2)
const action = args[0]

if (action === '--disable') {
  const config = readConfig()
  if (!config.disabled.includes('com.lumii.pet')) {
    config.disabled.push('com.lumii.pet')
    writeConfig(config)
    console.log('✅ 已禁用桌宠插件')
    console.log('   配置文件:', configPath)
    console.log('   重启应用生效')
    console.log('\n验证步骤:')
    console.log('   1. 启动应用')
    console.log('   2. 查看日志: ~/.lumii/logs/app/mtbot-*.log')
    console.log('   3. 应包含: "扩展已按配置禁用: com.lumii.pet"')
    console.log('   4. 托盘菜单"宠物模式"应该置灰或消失')
    console.log('   5. Ctrl+Shift+P 快捷键无响应')
  } else {
    console.log('⚠️  桌宠插件已经是禁用状态')
  }
} else if (action === '--enable') {
  const config = readConfig()
  const idx = config.disabled.indexOf('com.lumii.pet')
  if (idx >= 0) {
    config.disabled.splice(idx, 1)
    writeConfig(config)
    console.log('✅ 已启用桌宠插件')
    console.log('   配置文件:', configPath)
    console.log('   重启应用生效')
  } else {
    console.log('⚠️  桌宠插件已经是启用状态')
  }
} else if (action === '--status') {
  const config = readConfig()
  const disabled = config.disabled.includes('com.lumii.pet')
  console.log('桌宠插件状态:', disabled ? '❌ 禁用' : '✅ 启用')
  console.log('配置文件:', configPath)
  console.log('所有禁用的扩展:', config.disabled.length > 0 ? config.disabled.join(', ') : '(无)')
} else {
  console.log('用法:')
  console.log('  node verify/pet-plugin-disable-test.mjs --disable   # 禁用桌宠')
  console.log('  node verify/pet-plugin-disable-test.mjs --enable    # 启用桌宠')
  console.log('  node verify/pet-plugin-disable-test.mjs --status    # 查看状态')
  process.exit(1)
}
