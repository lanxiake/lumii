import type { AgentDefinitionDetail } from '../../../services/agent-service'

// Agent 数据结构（与 agent-service 保持一致）
export interface Agent {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  userId?: string
  isDefault?: boolean
  /** 系统 Agent 是否出现在会话选择器（仅对话型系统 Agent 为 true） */
  selectable?: boolean
  identity?: { emoji?: string; theme?: string }
  skillBlacklist?: string[]
  skillFilter?: string[]
  whenToUse?: string
  triggerExamples?: string[]
  bundledSkills?: string[]
  category?: string
  /** 只读定义详情：系统 Agent 有值，用户 Agent 无 */
  definition?: AgentDefinitionDetail
}

export interface MissingSkill {
  id: string
  name: string
  inStore: boolean
}

export type AgentView = 'map' | 'grid' | 'feed'

export const VIEW_STORAGE_KEY = 'mtbot-ai-team-view'

export function getStoredView(): AgentView {
  const v = localStorage.getItem(VIEW_STORAGE_KEY)
  if (v === 'map' || v === 'grid' || v === 'feed') return v
  return 'grid'
}

/**
 * 按 agent 名哈希取一个稳定的展示色。
 *
 * 走 `--mt-chart-*` 令牌以跟随主题。**关键约束是稳定性**：同名 agent 必须
 * 永远同色，否则用户对"哪个是哪个"的认知会崩。所以这里保持
 * **数组长度与顺序完全不变**，只把元素从 hex 换成令牌字符串 ——
 * 哈希取模的结果不变，同名仍取到同一**位置**的颜色；
 * 该位置的颜色值随主题不同，这是期望行为。
 */
export function agentColor(agent: Agent): string {
  if (agent.identity?.theme) return agent.identity.theme
  const PALETTE = [
    'var(--mt-chart-1)', 'var(--mt-chart-6)', 'var(--mt-chart-4)', 'var(--mt-chart-3)',
    'var(--mt-chart-5)', 'var(--mt-chart-7)', 'var(--mt-chart-2)', 'var(--mt-chart-8)',
  ]
  let hash = 0
  for (let i = 0; i < agent.name.length; i++) {
    hash = ((hash << 5) - hash + agent.name.charCodeAt(i)) | 0
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

export interface ViewProps {
  userAgents: Agent[]
  systemAgents: Agent[]
  searchQuery: string
  onEdit: (agent: Agent) => void
  onDelete: (agentId: string) => void
  onFork: (agent: Agent) => void
  onStartChat: (agentId: string) => void
  /** 打开详情面板（三视图共用同一个面板实例，由 AgentsPage 挂载） */
  onOpenDetail: (agent: Agent) => void
  missingSkillsMap?: Record<string, MissingSkill[]>
  onInstallSkill?: (agentId: string, skillId: string, skillName: string) => Promise<boolean>
  onNavigateToStore?: (skillName: string) => void
}
