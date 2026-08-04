/**
 * useAgents.ts - Agent 管理 Hook
 *
 * Phase 6: Windows 客户端 Agent 切换功能
 * 提供 Agent 列表查询、当前选中 Agent 管理等功能
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { getAgents, forkAgent, type Agent } from '../../../services/agent-service'

const STORAGE_KEY = 'mtbot-selected-agent'

/** 主进程 DefinitionStore 同步状态在 UI 上的简化分类 */
export type AgentDefinitionSyncUiKind = 'synced' | 'syncing' | 'error' | 'stale' | 'idle'

export interface AgentDefinitionSyncUi {
  kind: AgentDefinitionSyncUiKind
  /** 最近一次成功同步时间 */
  lastSyncAt: Date | null
  lastError: string | null
}

export interface UseAgentsReturn {
  /** Agent 列表 */
  agents: Agent[]
  /** 系统 Agent 列表 */
  systemAgents: Agent[]
  /** 用户 Agent 列表 */
  userAgents: Agent[]
  /** 主系统 Agent 的 ID（用于"系统默认"对话） */
  mainAgentId: string | null
  /** 当前选中的用户 Agent（null 表示使用系统默认） */
  selectedAgent: Agent | null
  /** 是否加载中 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
  /** 刷新 Agent 列表 */
  refreshAgents: () => Promise<void>
  /** 选择 Agent */
  selectAgent: (agent: Agent | null) => void
  /** 根据 ID 选择 Agent */
  selectAgentById: (agentId: string) => void
  /** Fork 系统 Agent */
  forkSystemAgent: (systemAgentId: string, name?: string, description?: string, systemPrompt?: string) => Promise<Agent | null>
  /** Agent ID 到 Agent 的快速查找 Map */
  agentsMap: Map<string, Agent>
  /** 本地 Agent 定义缓存同步状态（与主进程 DefinitionStore 对齐） */
  definitionSync: AgentDefinitionSyncUi
  /** 重新读取主进程同步状态 */
  refreshDefinitionSync: () => Promise<void>
  /** 触发全量同步（失败可点重试） */
  syncUserAgentDefinitions: () => Promise<void>
}

export function useAgents(): UseAgentsReturn {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [mainAgentId, setMainAgentId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [definitionSync, setDefinitionSync] = useState<AgentDefinitionSyncUi>({
    kind: 'idle',
    lastSyncAt: null,
    lastError: null,
  })

  // 过滤系统 Agent 和用户 Agent（用户 Agent 按名称字母序排列，编辑后顺序稳定）
  const systemAgents = agents.filter((a) => !a.userId)
  const userAgents = agents.filter((a) => a.userId).sort((a, b) => a.name.localeCompare(b.name, 'zh'))

  /**
   * 从主进程拉取 DefinitionStore 同步状态并映射为 UI 分类
   */
  const refreshDefinitionSync = useCallback(async () => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.getDefinitionSyncStatus) return
    try {
      const s = await api.getDefinitionSyncStatus()
      const lastSyncAt = s.lastSyncAt ? new Date(s.lastSyncAt as string) : null
      const lastError = s.lastError ?? null
      let kind: AgentDefinitionSyncUiKind = 'idle'
      if (s.isSyncing) {
        kind = 'syncing'
      } else if (lastError) {
        kind = 'error'
      } else if (lastSyncAt) {
        const age = Date.now() - lastSyncAt.getTime()
        kind = age < 60 * 60 * 1000 ? 'synced' : 'stale'
      } else {
        kind = 'idle'
      }
      setDefinitionSync({ kind, lastSyncAt, lastError })
    } catch {
      setDefinitionSync((prev) => ({ ...prev, kind: 'error', lastError: '无法读取同步状态' }))
    }
  }, [])

  /**
   * 手动触发用户 Agent 全量同步
   */
  const syncUserAgentDefinitions = useCallback(async () => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.syncUserAgentDefinitions) return
    await api.syncUserAgentDefinitions()
    await refreshDefinitionSync()
  }, [refreshDefinitionSync])

  /**
   * 加载 Agent 列表
   */
  const loadAgents = useCallback(async () => {
    try {
      setIsLoading(true)
      setError(null)
      const response = await getAgents()
      const loadedAgents = response.agents ?? []
      setAgents(loadedAgents)

      // 提取主系统 Agent ID（优先 isDefault，其次 id='assistant'，再 id='main'，最后取第一个系统 Agent）
      const defaultSys = loadedAgents.find((a) => !a.userId && a.isDefault)
      const assistantSys = loadedAgents.find((a) => a.id === 'assistant' && !a.userId)
      const mainSys = loadedAgents.find((a) => a.id === 'main' && !a.userId)
      const firstSys = loadedAgents.find((a) => !a.userId)
      const resolvedMainId = defaultSys?.id ?? assistantSys?.id ?? mainSys?.id ?? firstSys?.id ?? null
      setMainAgentId(resolvedMainId)

      // 仅从用户 Agent 中恢复选中状态，系统 Agent 固定为"系统默认"
      const savedAgentId = localStorage.getItem(STORAGE_KEY)
      if (savedAgentId) {
        const savedAgent = loadedAgents.find((a) => a.id === savedAgentId && a.userId)
        if (savedAgent) {
          setSelectedAgent(savedAgent)
        } else {
          // 保存的 Agent 已不存在或是系统 Agent，清除并使用系统默认
          localStorage.removeItem(STORAGE_KEY)
          setSelectedAgent(null)
        }
      } else {
        // 没有保存记录，使用系统默认（null）
        setSelectedAgent(null)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '未知错误'
      const errorType = err instanceof Error && err.name === 'NetworkError'
        ? '网络连接失败，请检查网络设置'
        : err instanceof Error && err.message?.includes('权限')
          ? '没有权限访问 Agent 列表'
          : `加载 Agent 列表失败: ${errorMessage}`
      setError(errorType)
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * 刷新 Agent 列表
   */
  const refreshAgents = useCallback(async () => {
    await loadAgents()
    await refreshDefinitionSync()
  }, [loadAgents, refreshDefinitionSync])

  /**
   * 选择 Agent
   */
  const selectAgent = useCallback((agent: Agent | null) => {
    setSelectedAgent(agent)
    if (agent) {
      localStorage.setItem(STORAGE_KEY, agent.id)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  }, [])

  /**
   * 根据 ID 选择 Agent
   */
  const selectAgentById = useCallback(
    (agentId: string) => {
      const agent = agents.find((a) => a.id === agentId)
      if (agent) {
        selectAgent(agent)
      }
    },
    [agents, selectAgent]
  )

  /**
   * Fork 系统 Agent
   */
  const forkSystemAgent = useCallback(
    async (systemAgentId: string, name?: string, description?: string, systemPrompt?: string): Promise<Agent | null> => {
      try {
        setIsLoading(true)
        const newAgent = await forkAgent(systemAgentId, { name, description, systemPrompt })
        // 刷新列表
        await loadAgents()
        // 自动选中新创建的 Agent
        selectAgent(newAgent)
        return newAgent
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : '未知错误'
        const errorType = err instanceof Error && err.name === 'NetworkError'
          ? '网络连接失败，请检查网络设置'
          : err instanceof Error && err.message?.includes('权限')
            ? '没有权限 Fork 此 Agent'
            : `Fork Agent 失败: ${errorMessage}`
        setError(errorType)
        return null
      } finally {
        setIsLoading(false)
      }
    },
    [loadAgents, selectAgent]
  )

  // 构建 agentsMap 用于快速查找
  const agentsMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  // 初始化加载
  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  // 监听 Agent 增删改事件（由 AgentsPage 等页面 dispatch），跨组件同步列表
  useEffect(() => {
    const handleAgentsChanged = () => {
      void loadAgents()
    }
    window.addEventListener('mtbot:agents-changed', handleAgentsChanged)
    return () => window.removeEventListener('mtbot:agents-changed', handleAgentsChanged)
  }, [loadAgents])

  // 页面可见性变化时自动刷新（用户从其他页面切回时同步最新数据）
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadAgents()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [loadAgents])

  useEffect(() => {
    void refreshDefinitionSync()
    const t = window.setInterval(() => {
      void refreshDefinitionSync()
    }, 20_000)
    return () => window.clearInterval(t)
  }, [refreshDefinitionSync])

  return {
    agents,
    systemAgents,
    userAgents,
    mainAgentId,
    selectedAgent,
    isLoading,
    error,
    refreshAgents,
    selectAgent,
    selectAgentById,
    forkSystemAgent,
    agentsMap,
    definitionSync,
    refreshDefinitionSync,
    syncUserAgentDefinitions,
  }
}
