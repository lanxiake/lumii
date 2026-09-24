/**
 * Agent Service - Agent 服务
 *
 * 封装所有与 Agent 相关的 API 调用
 * Phase 6: Windows 客户端 Agent 切换功能
 */

type ModelTier = 'basic' | 'balanced' | 'performance'

/** 只读定义详情（系统 Agent 由主进程从内置定义镜像，见 main/agents-repo.ts） */
export interface AgentDefinitionDetail {
  tools?: string[]
  disallowedTools?: string[]
  bundledSkills?: string[]
  whenToUse?: string
  triggerExamples?: string[]
  category?: string
  maxTurns?: number
  canSpawnSubAgents?: boolean
  permissionMode?: string
  memoryScope?: string
}

export interface Agent {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  isEnabled: boolean
  isDefault?: boolean
  userId?: string
  /** 系统 Agent 是否出现在会话选择器（仅对话型系统 Agent 为 true） */
  selectable?: boolean
  modelTier?: ModelTier
  identity?: {
    name?: string
    emoji?: string
    theme?: string
    avatar?: string
  }
  model?: {
    primary?: string
    fallbacks?: string[]
  }
  sandbox?: {
    mode?: 'off' | 'soft' | 'hard'
    workspaceAccess?: 'ro' | 'rw' | 'none'
  }
  skillFilter?: string[]
  skillBlacklist?: string[]
  /** 路由信号（用户 Agent 可编辑；系统 Agent 的填在 definition.whenToUse） */
  whenToUse?: string
  triggerExamples?: string[]
  bundledSkills?: string[]
  category?: string
  /** 只读定义详情：系统 Agent 有值，用户 Agent 无 */
  definition?: AgentDefinitionDetail
  createdAt: string
  updatedAt: string
}

export interface AgentListResponse {
  agents: Agent[]
  total: number
}

interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  code?: string
}

function unwrap<T>(response: ApiResponse<T>, errorMsg: string): T {
  if (!response.success || response.data === undefined) {
    throw new Error(response.error ?? errorMsg)
  }
  return response.data
}

/**
 * 获取用户可用的 Agent 列表（系统 Agent + 用户 Agent）
 */
export async function getAgents(): Promise<AgentListResponse> {
  const response = await window.electronAPI.api.getAgents() as ApiResponse<AgentListResponse>
  return unwrap(response, '获取 Agent 列表失败')
}

/**
 * 获取 Agent 详情
 */
async function getAgent(agentId: string): Promise<Agent> {
  const response = await window.electronAPI.api.getAgent(agentId) as ApiResponse<Agent>
  return unwrap(response, '获取 Agent 详情失败')
}

/**
 * Fork 系统 Agent
 */
export async function forkAgent(
  systemAgentId: string,
  data: { name?: string; description?: string; systemPrompt?: string } = {}
): Promise<Agent> {
  const response = await window.electronAPI.api.forkAgent(systemAgentId, data) as ApiResponse<Agent>
  return unwrap(response, 'Fork Agent 失败')
}

/** 可传 null 清空的字段（主进程按 merge 语义写入，null 即清除该配置） */
type NullableUpdateKeys =
  | 'skillFilter'
  | 'skillBlacklist'
  | 'whenToUse'
  | 'triggerExamples'
  | 'bundledSkills'
  | 'category'
  | 'description'
  | 'systemPrompt'

/**
 * 更新载荷：技能过滤/黑名单与路由信号允许传 null 以清空（主进程写入语义）
 */
export type AgentUpdatePayload = Partial<Omit<Agent, NullableUpdateKeys>> & {
  [K in NullableUpdateKeys]?: Agent[K] | null
}

/**
 * 更新用户 Agent
 */
export async function updateAgent(
  agentId: string,
  data: AgentUpdatePayload
): Promise<Agent> {
  const response = await window.electronAPI.api.updateAgent(agentId, data as Record<string, unknown>) as ApiResponse<Agent>
  return unwrap(response, '更新 Agent 失败')
}

/**
 * 删除用户 Agent
 */
export async function deleteAgent(agentId: string): Promise<void> {
  const response = await window.electronAPI.api.deleteAgent(agentId) as ApiResponse<unknown>
  if (!response.success) {
    throw new Error(response.error ?? '删除 Agent 失败')
  }
}
