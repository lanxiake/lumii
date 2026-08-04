#!/usr/bin/env node
/**
 * 免审批功能验证脚本
 *
 * 用于快速验证审批配置管理功能是否正常工作
 */

import { GatewayClient } from '../src/main/gateway-client.js'
import { ExecApprovalsManager } from '../src/main/exec-approvals-manager.js'

const log = {
  info: (...args) => console.log('[验证]', ...args),
  error: (...args) => console.error('[验证]', ...args),
  success: (...args) => console.log('✅', ...args),
  fail: (...args) => console.error('❌', ...args),
}

async function main() {
  log.info('开始验证免审批功能...')

  // 1. 创建 Gateway 客户端
  const gatewayUrl = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789'
  const token = process.env.GATEWAY_TOKEN || ''
  const nodeId = process.env.NODE_ID || ''

  if (!nodeId) {
    log.fail('请设置 NODE_ID 环境变量')
    process.exit(1)
  }

  log.info(`连接到 Gateway: ${gatewayUrl}`)
  const client = new GatewayClient({
    url: gatewayUrl,
    token,
    role: 'user',
  })

  try {
    await client.connect()
    log.success('Gateway 连接成功')
  } catch (err) {
    log.fail('Gateway 连接失败:', err)
    process.exit(1)
  }

  // 2. 创建审批配置管理器
  const manager = new ExecApprovalsManager(client)

  // 3. 获取当前配置
  log.info('获取节点审批配置...')
  let snapshot
  try {
    snapshot = await manager.getNodeConfig(nodeId)
    log.success('成功获取配置')
    log.info('当前配置:', JSON.stringify(snapshot.file.defaults, null, 2))
    log.info('当前模式:', manager.getCurrentMode(snapshot))
  } catch (err) {
    log.fail('获取配置失败:', err)
    process.exit(1)
  }

  // 4. 测试设置为免审批模式
  log.info('设置为免审批模式...')
  try {
    const updated = await manager.setNoApprovalMode(nodeId)
    log.success('成功设置为免审批模式')
    log.info('新配置:', JSON.stringify(updated.file.defaults, null, 2))
    log.info('新模式:', manager.getCurrentMode(updated))

    // 验证配置是否正确
    if (updated.file.defaults?.ask === 'off' && updated.file.defaults?.security === 'full') {
      log.success('配置验证通过')
    } else {
      log.fail('配置验证失败')
      process.exit(1)
    }
  } catch (err) {
    log.fail('设置免审批模式失败:', err)
    process.exit(1)
  }

  // 5. 测试恢复为平衡模式
  log.info('恢复为平衡模式...')
  try {
    const restored = await manager.setBalancedMode(nodeId)
    log.success('成功恢复为平衡模式')
    log.info('恢复后配置:', JSON.stringify(restored.file.defaults, null, 2))
    log.info('恢复后模式:', manager.getCurrentMode(restored))

    // 验证配置是否正确
    if (restored.file.defaults?.ask === 'on-miss' && restored.file.defaults?.security === 'allowlist') {
      log.success('配置验证通过')
    } else {
      log.fail('配置验证失败')
      process.exit(1)
    }
  } catch (err) {
    log.fail('恢复平衡模式失败:', err)
    process.exit(1)
  }

  // 6. 断开连接
  await client.disconnect()
  log.success('所有测试通过！')
}

main().catch((err) => {
  log.fail('验证失败:', err)
  process.exit(1)
})
