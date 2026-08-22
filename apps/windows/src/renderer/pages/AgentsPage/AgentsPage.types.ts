import type React from 'react'
import type { ModelTier } from '../../services/agent-service'

/** 工具能力配置（白话描述，非技术用户可理解） */
export interface CapabilityOption {
  id: string
  label: string
  description: string
  toolNames: string[]
  icon?: React.ReactNode
}

/** 模型级别配置 */
export interface ModelTierOption {
  value: ModelTier
  label: string
  description: string
}

/** 用户技能类型 */
export interface UserSkill {
  id: string
  name: string
  description?: string
  status?: string
}

/** Agent 编辑/新建表单数据 */
export interface AgentFormData {
  name: string
  description: string
  systemPrompt: string
  enabledCapabilities: Set<string>
  modelTier: ModelTier
  selectedSkills: string[]
  // Pre-LLM Router 路由信号（v2）
  whenToUse: string
  triggerExamples: string  // 换行分隔
  bundledSkills: string    // 换行分隔
  category: string
}

export interface AgentsPageProps {
  onViewChange?: (view: import('../../components/layout/Sidebar/Sidebar').ViewType) => void
  /** Hub 嵌入时收紧布局，弱化页头标题区 */
  embedded?: boolean
}
