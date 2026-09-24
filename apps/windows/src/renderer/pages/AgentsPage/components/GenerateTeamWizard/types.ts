/**
 * AI 生成 Agent 团队 — 共享类型
 */

import type React from 'react'

/** 组内角色 */
export type GroupRole = 'coordinator' | 'executor' | 'reviewer'

/** AI 规划返回的单个 Agent 结构 */
export interface GeneratedAgent {
  name: string
  emoji: string
  /** 所属分组 ID，同组 Agent 协作完成相关任务 */
  groupId: string
  /** 分组显示名称，如"核心开发组" */
  groupName: string
  /** 组内角色：coordinator 协调者（每组最多1个）/ executor 执行者 / reviewer 审查者 */
  groupRole: GroupRole
  description: string
  systemPrompt: string
  capabilities: string[]
  /** AI 推荐分配的技能 ID 列表（来自用户已安装技能），写入 skillFilter */
  skills: string[]
  /** AI 推荐的 MCP 服务名（来自全局已启用 server），未选中的 server 工具进工具黑名单 */
  mcpServers?: string[]
  /** 路由信号：用户视角的「何时使用」，写入 whenToUse */
  whenToUse: string
  /** 路由信号：用户可能说的原话，写入 triggerExamples */
  triggerExamples: string[]
  /** 常驻技能 ID 列表（启动即自动激活），写入 bundledSkills */
  bundledSkills: string[]
}

/** MCP 服务选项（Step3/表单勾选用）；定义在 services 里，这里只做转出方便组件引用 */
export type { McpServerOption } from '../../../../services/mcp-service'

/** 精简编辑表单数据 */
export interface GeneratedAgentForm extends GeneratedAgent {
  id?: string
  status: 'pending' | 'creating' | 'success' | 'error'
}

/** 能力选项 */
export interface CapabilityOption {
  id: string
  label: string
  description: string
  toolNames: string[]
  icon?: React.ReactNode
}

/** 快速模板 */
export interface QuickTemplate {
  id: string
  label: string
  description: string
  content: string
}

/** 向导步骤 */
type WizardStep = 1 | 2 | 3
