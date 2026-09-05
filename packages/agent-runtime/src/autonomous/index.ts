/**
 * 自主进化 Agent - 统一导出
 *
 * 包含所有自主进化相关的模块和类型。
 */

// 核心类型
export * from './types'

// P0 - 基础功能
export * from './meta-cognition-engine'
export * from './intrinsic-goal-generator'
export * from './prompt-evolution'
export * from './personality-tracker'
export * from './autonomous-coordinator'
export * from './metrics-collector'
export * from './db-adapter'
export * from './config'

// P1 - 高级功能
export * from './capability-tracker'
export * from './reflection-engine'

// 审批系统（离线审批架构）
export * from './goal-risk-classifier'
export * from './auto-approval-policy'
export * from './approval-queue'
export * from './approval-delivery'
export * from './approval-reply-parser'
export * from './approval-timeout-scanner'
export * from './approval-db-adapter'

// 实用工具
// export * from './satisfaction-calculator' // TODO: 待实现

// 示例（仅开发使用）
export * from './approval-integration-example'
