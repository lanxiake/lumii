/**
 * AI 生成 Agent 团队 — 共享类型
 */

import type React from 'react'
import type { ModelTier } from '../../../../services/agent-service'

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
  modelTier: ModelTier
  capabilities: string[]
  /** AI 推荐分配的技能 ID 列表（来自用户已安装技能） */
  skills: string[]
}

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
export type WizardStep = 1 | 2 | 3
