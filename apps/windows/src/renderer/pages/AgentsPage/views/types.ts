import type { ModelTier } from '../../../services/agent-service'

// Agent 数据结构（与 agent-service 保持一致）
export interface Agent {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  userId?: string
  isDefault?: boolean
  modelTier?: ModelTier
  model?: { primary?: string }
  identity?: { emoji?: string; theme?: string }
  skillBlacklist?: string[]
  skillFilter?: string[]
}

export interface MissingSkill {
  id: string
  name: string
  inStore: boolean
}

/** Agent 运行态快照（用于列表/Map/Grid 动态标识） */
export interface AgentRuntimeState {
  readonly anyRunning: boolean
  readonly runningCount: number
}

export type AgentView = 'map' | 'grid' | 'feed'

export const VIEW_STORAGE_KEY = 'mtbot-ai-team-view'

export function getStoredView(): AgentView {
  const v = localStorage.getItem(VIEW_STORAGE_KEY)
  if (v === 'map' || v === 'grid' || v === 'feed') return v
  return 'grid'
}

export const TIER_LABELS: Record<ModelTier, string> = {
  basic: '⚡ 基础',
  balanced: '⚖️ 均衡',
  performance: '🚀 性能',
}

export function agentColor(agent: Agent): string {
  if (agent.identity?.theme) return agent.identity.theme
  const PALETTE = [
    '#60a5fa', '#34d399', '#f472b6', '#fbbf24',
    '#a78bfa', '#fb923c', '#2dd4bf', '#e879f9',
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
  runtimeStateMap: Record<string, AgentRuntimeState | undefined>
  onEdit: (agent: Agent) => void
  onDelete: (agentId: string) => void
  onFork: (agent: Agent) => void
  onStartChat: (agentId: string) => void
  missingSkillsMap?: Record<string, MissingSkill[]>
  onInstallSkill?: (agentId: string, skillId: string, skillName: string) => Promise<boolean>
  onNavigateToStore?: (skillName: string) => void
}
