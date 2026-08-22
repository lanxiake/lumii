/**
 * AgentsPage - Agent 管理页面
 *
 * 支持查看系统 Agent、创建/编辑/删除用户 Agent
 * 包含技能和工具配置（对非技术用户友好的白话描述）
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Zap, Rocket, Network, LayoutGrid, List, RefreshCw, Check, X, Loader2, Sparkles } from 'lucide-react'
import clsx from 'clsx'
import { useAgents } from '../../hooks/business/useAgents/useAgents'
import { updateAgent, deleteAgent, type ModelTier } from '../../services/agent-service'
import { MapView } from './views/MapView'
import { GridView } from './views/GridView'
import { FeedView } from './views/FeedView'
import { getStoredView, VIEW_STORAGE_KEY, type AgentView, type Agent as ViewAgent } from './views/types'
import { GenerateTeamWizard } from './components/GenerateTeamWizard/GenerateTeamWizard'
import { OptimizeTeamWizard } from './components/OptimizeTeamWizard/OptimizeTeamWizard'
import { EmptyStateGuide } from './components/EmptyStateGuide/EmptyStateGuide'
import { AgentBasicFields } from './components/AgentFormModal/AgentBasicFields'
import { AgentRoutingFields } from './components/AgentFormModal/AgentRoutingFields'
import { AgentCategoryModelFields } from './components/AgentFormModal/AgentCategoryModelFields'
import { AgentSkillsField } from './components/AgentFormModal/AgentSkillsField'
import { AgentCapabilitiesField } from './components/AgentFormModal/AgentCapabilitiesField'
import {
  CAPABILITY_OPTIONS,
  capabilitiesToSkillBlacklist,
  skillBlacklistToCapabilityIds,
  defaultCapabilities,
  DEFAULT_MODEL_TIER,
} from './AgentsPage.const'
import type { AgentFormData, UserSkill, AgentsPageProps } from './AgentsPage.types'
import styles from './AgentsPage.module.css'
import type { AgentRuntimeState } from './views/types'

// ── 主页面 ───────────────────────────────────────────────────────────────

const AgentsPage: React.FC<AgentsPageProps> = ({ onViewChange, embedded = false }) => {
  const {
    agents,
    systemAgents,
    userAgents,
    isLoading,
    error,
    refreshAgents,
    forkSystemAgent,
    definitionSync,
    syncUserAgentDefinitions,
  } = useAgents()

  const [currentView, setCurrentView] = useState<AgentView>(getStoredView)
  const [searchQuery, setSearchQuery] = useState('')
  const [editingAgent, setEditingAgent] = useState<{ id: string; data: AgentFormData } | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createSourceId, setCreateSourceId] = useState<string | null>(null)
  const [createForm, setCreateForm] = useState<AgentFormData>({
    name: '',
    description: '',
    systemPrompt: '',
    enabledCapabilities: defaultCapabilities(),
    modelTier: DEFAULT_MODEL_TIER,
    selectedSkills: [],
    whenToUse: '',
    triggerExamples: '',
    bundledSkills: '',
    category: '',
  })
  const [showGenerateWizard, setShowGenerateWizard] = useState(false)
  const [showOptimizeWizard, setShowOptimizeWizard] = useState(false)
  // 技能同步：per-agent 缺失技能映射（agentId → 缺失技能列表）
  const [agentMissingSkills, setAgentMissingSkills] = useState<Record<string, Array<{ id: string; name: string; inStore: boolean }>>>({ })
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [resultMessage, setResultMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [userSkills, setUserSkills] = useState<UserSkill[]>([])
  const [runtimeStateMap, setRuntimeStateMap] = useState<Record<string, AgentRuntimeState | undefined>>({})
  // 用 ref 持有最新的 userAgents，避免 refreshRuntimeStates 依赖 userAgents 导致定时器频繁重置
  const userAgentsRef = useRef(userAgents)

  const showResult = useCallback((type: 'success' | 'error', text: string) => {
    setResultMessage({ type, text })
    setTimeout(() => setResultMessage(null), 3000)
  }, [])

  // 视图切换记忆
  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, currentView)
  }, [currentView])

  // 加载本地已安装技能列表（与"我的技能"页面数据源一致）
  useEffect(() => {
    const fetchSkills = async () => {
      try {
        const raw = await window.electronAPI.skills.listLocalInstalled()
        // IPC 返回 { success, data } 格式，兼容旧版裸数组
        const localSkills: Array<{
          id: string
          name?: string
          description?: string
          enabled?: boolean
        }> = Array.isArray(raw) ? raw : ((raw as any)?.data ?? [])
        if (Array.isArray(localSkills)) {
          const skills: UserSkill[] = localSkills
            .filter((s) => s.enabled !== false)
            .map((s) => ({
              id: s.id,
              name: s.name || s.id,
              description: s.description,
            }))
          setUserSkills(skills)
        }
      } catch {
        // 技能列表加载失败不影响页面主功能
      }
    }
    fetchSkills()
  }, [])

  // 技能差异检测：稳定的 skillFilter key，避免 userAgents 引用变化导致无限循环
  const skillFilterKey = useMemo(
    () => userAgents.flatMap((a) => (a as any).skillFilter ?? []).sort().join(','),
    [userAgents],
  )
  useEffect(() => {
    if (!skillFilterKey) {
      setAgentMissingSkills({})
      return
    }
    const detect = async () => {
      try {
        const raw = await window.electronAPI.skills.listLocalInstalled()
        const localSkills: Array<{ id: string; name?: string; enabled?: boolean }> =
          Array.isArray(raw) ? raw : ((raw as any)?.data ?? [])
        const installedNames = new Set(
          localSkills.filter((s) => s.enabled !== false).map((s) => (s.name || s.id).toLowerCase()),
        )

        // 收集所有 agent 需要但本地缺失的唯一技能名（去重后统一查商店）
        const allMissingNames = new Set<string>()
        for (const agent of userAgentsRef.current) {
          for (const skillName of (agent as any).skillFilter ?? []) {
            if (!installedNames.has(skillName.toLowerCase())) {
              allMissingNames.add(skillName)
            }
          }
        }
        if (allMissingNames.size === 0) {
          setAgentMissingSkills({})
          return
        }

        // 批量查商店（去重，每个名字只查一次）
        const skillLookup = new Map<string, { id: string; name: string; inStore: boolean }>()
        for (const skillName of allMissingNames) {
          try {
            const result = await (window.electronAPI.api as any).getStoreSkills?.({ search: skillName, limit: 1 })
            // data 可能是数组（旧格式）或 { items, meta }（新格式）
            const rawData = result?.data
            const items: Array<{ id: string; name?: string }> = Array.isArray(rawData)
              ? rawData
              : (rawData?.items ?? result?.items ?? [])
            skillLookup.set(
              skillName.toLowerCase(),
              items.length > 0
                ? { id: items[0].id, name: items[0].name ?? skillName, inStore: true }
                : { id: skillName, name: skillName, inStore: false },
            )
          } catch {
            skillLookup.set(skillName.toLowerCase(), { id: skillName, name: skillName, inStore: false })
          }
        }

        // 构建 per-agent 缺失映射
        const newMap: Record<string, Array<{ id: string; name: string; inStore: boolean }>> = {}
        for (const agent of userAgentsRef.current) {
          const agentMissing: Array<{ id: string; name: string; inStore: boolean }> = []
          for (const skillName of (agent as any).skillFilter ?? []) {
            if (!installedNames.has(skillName.toLowerCase())) {
              const info = skillLookup.get(skillName.toLowerCase())
              agentMissing.push(info ?? { id: skillName, name: skillName, inStore: false })
            }
          }
          if (agentMissing.length > 0) {
            newMap[agent.id] = agentMissing
          }
        }
        setAgentMissingSkills(newMap)
      } catch {
        // 查询失败不影响主功能
      }
    }
    void detect()
  }, [skillFilterKey])

  // 安装缺失技能：成功后从映射中移除该技能
  const handleInstallSkill = useCallback(
    async (agentId: string, skillId: string, skillName: string): Promise<boolean> => {
      try {
        const result = await (window.electronAPI.api as any).installStoreSkill(skillId)
        if (result?.success === false) return false
        setAgentMissingSkills((prev) => {
          const agentList = prev[agentId]
          if (!agentList) return prev
          const newList = agentList.filter((s) => s.id !== skillId && s.name !== skillName)
          if (newList.length === 0) {
            const { [agentId]: _, ...rest } = prev
            return rest
          }
          return { ...prev, [agentId]: newList }
        })
        // 刷新本地技能列表
        const raw = await window.electronAPI.skills.listLocalInstalled()
        const localSkills: Array<{ id: string; name?: string; description?: string; enabled?: boolean }> =
          Array.isArray(raw) ? raw : ((raw as any)?.data ?? [])
        setUserSkills(
          localSkills
            .filter((s) => s.enabled !== false)
            .map((s) => ({ id: s.id, name: s.name || s.id, description: s.description })),
        )
        return true
      } catch {
        return false
      }
    },
    [],
  )

  // 跳转到技能商店并自动填充搜索词
  const handleNavigateToStore = useCallback(
    (skillName: string) => {
      window.dispatchEvent(
        new CustomEvent('mtbot:open-skill-store', { detail: { query: skillName } }),
      )
      onViewChange?.('skills')
    },
    [onViewChange],
  )

  // 发起对话：dispatch 自定义事件通知始终挂载的 ChatPage，再跳转视图
  const handleStartChat = useCallback(
    (agentId: string) => {
      window.dispatchEvent(new CustomEvent('mtbot:start-chat-agent', { detail: agentId }))
      onViewChange?.('chat')
    },
    [onViewChange],
  )

  const filteredUserAgents = userAgents.filter(
    (a) =>
      !searchQuery ||
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.description?.toLowerCase().includes(searchQuery.toLowerCase()),
  )
  const filteredSystemAgents = systemAgents.filter(
    (a) =>
      !searchQuery ||
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.description?.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const handleCreate = useCallback(
    async (sourceId: string | null) => {
      if (!sourceId) return
      setIsSubmitting(true)
      try {
        const result = await forkSystemAgent(
          sourceId,
          createForm.name || undefined,
          createForm.description || undefined,
          createForm.systemPrompt || undefined,
        )
        if (result) {
          const blacklist = capabilitiesToSkillBlacklist(createForm.enabledCapabilities)
          const splitLines = (s: string): string[] =>
            s.split('\n').map((l) => l.trim()).filter(Boolean)
          const triggerExamplesList = splitLines(createForm.triggerExamples)
          const bundledSkillsList = splitLines(createForm.bundledSkills)
          await updateAgent(result.id, {
            systemPrompt: createForm.systemPrompt || null,
            skillBlacklist: blacklist.length > 0 ? blacklist : null,
            skillFilter: createForm.selectedSkills,
            modelTier: createForm.modelTier,
            whenToUse: createForm.whenToUse || null,
            triggerExamples: triggerExamplesList.length > 0 ? triggerExamplesList : null,
            bundledSkills: bundledSkillsList.length > 0 ? bundledSkillsList : null,
            category: createForm.category || null,
          } as any)
          await syncUserAgentDefinitions()
          showResult('success', `Agent「${result.name}」已创建`)
          setShowCreateModal(false)
          setCreateForm({
            name: '',
            description: '',
            systemPrompt: '',
            enabledCapabilities: defaultCapabilities(),
            modelTier: DEFAULT_MODEL_TIER,
            selectedSkills: [],
            whenToUse: '',
            triggerExamples: '',
            bundledSkills: '',
            category: '',
          })
          await refreshAgents()
          window.dispatchEvent(new CustomEvent('mtbot:agents-changed'))
        }
      } catch {
        showResult('error', '创建失败，请重试')
      } finally {
        setIsSubmitting(false)
      }
    },
    [createForm, forkSystemAgent, refreshAgents, showResult, syncUserAgentDefinitions],
  )

  const handleCreateBlank = useCallback(async () => {
    const first = systemAgents[0]
    if (!first) {
      showResult('error', '暂无可用的系统 Agent 模板')
      return
    }
    setCreateSourceId(first.id)
    setCreateForm({
      name: '',
      description: '',
      systemPrompt: '',
      enabledCapabilities: defaultCapabilities(),
      modelTier: DEFAULT_MODEL_TIER,
      selectedSkills: [],
      whenToUse: '',
      triggerExamples: '',
      bundledSkills: '',
      category: '',
    })
    setShowCreateModal(true)
  }, [systemAgents, showResult])

  const handleForkSystem = useCallback((agentId: string, agentName: string, agentDescription?: string, agentSystemPrompt?: string) => {
    setCreateSourceId(agentId)
    setCreateForm({
      name: `${agentName}（副本）`,
      description: agentDescription || '',
      systemPrompt: agentSystemPrompt || '',
      enabledCapabilities: defaultCapabilities(),
      modelTier: DEFAULT_MODEL_TIER,
      selectedSkills: [],
      whenToUse: '',
      triggerExamples: '',
      bundledSkills: '',
      category: '',
    })
    setShowCreateModal(true)
  }, [])

  const handleOpenEdit = useCallback((agent: any) => {
    setEditingAgent({
      id: agent.id,
      data: {
        name: agent.name,
        description: agent.description || '',
        systemPrompt: agent.systemPrompt || '',
        enabledCapabilities: skillBlacklistToCapabilityIds(agent.skillBlacklist),
        modelTier: (agent.modelTier as ModelTier) || DEFAULT_MODEL_TIER,
        selectedSkills: agent.skillFilter || [],
        whenToUse: agent.whenToUse || '',
        triggerExamples: Array.isArray(agent.triggerExamples) ? agent.triggerExamples.join('\n') : '',
        bundledSkills: Array.isArray(agent.bundledSkills) ? agent.bundledSkills.join('\n') : '',
        category: agent.category || '',
      },
    })
  }, [])

  const handleSave = useCallback(async () => {
    if (!editingAgent) return
    setIsSubmitting(true)
    try {
      const blacklist = capabilitiesToSkillBlacklist(editingAgent.data.enabledCapabilities)
      const splitLines = (s: string): string[] =>
        s.split('\n').map((l) => l.trim()).filter(Boolean)
      const triggerExamplesList = splitLines(editingAgent.data.triggerExamples)
      const bundledSkillsList = splitLines(editingAgent.data.bundledSkills)
      await updateAgent(editingAgent.id, {
        name: editingAgent.data.name,
        description: editingAgent.data.description || null,
        systemPrompt: editingAgent.data.systemPrompt || null,
        skillBlacklist: blacklist.length > 0 ? blacklist : null,
        skillFilter: editingAgent.data.selectedSkills,
        modelTier: editingAgent.data.modelTier,
        whenToUse: editingAgent.data.whenToUse || null,
        triggerExamples: triggerExamplesList.length > 0 ? triggerExamplesList : null,
        bundledSkills: bundledSkillsList.length > 0 ? bundledSkillsList : null,
        category: editingAgent.data.category || null,
      } as any)
      await syncUserAgentDefinitions()
      showResult('success', '保存成功')
      setEditingAgent(null)
      await refreshAgents()
      window.dispatchEvent(new CustomEvent('mtbot:agents-changed'))
    } catch {
      showResult('error', '保存失败，请重试')
    } finally {
      setIsSubmitting(false)
    }
  }, [editingAgent, refreshAgents, showResult, syncUserAgentDefinitions])

  const handleDelete = useCallback(async () => {
    if (!confirmDeleteId) return
    setIsSubmitting(true)
    try {
      await deleteAgent(confirmDeleteId)
      showResult('success', 'Agent 已删除')
      setConfirmDeleteId(null)
      await refreshAgents()
      window.dispatchEvent(new CustomEvent('mtbot:agents-changed'))
    } catch {
      showResult('error', '删除失败，请重试')
    } finally {
      setIsSubmitting(false)
    }
  }, [confirmDeleteId, refreshAgents, showResult])

  const handleCreateCapabilityChange = useCallback((id: string, enabled: boolean) => {
    setCreateForm((prev) => {
      const next = new Set(prev.enabledCapabilities)
      if (enabled) next.add(id)
      else next.delete(id)
      return { ...prev, enabledCapabilities: next }
    })
  }, [])

  // 同步最新的 userAgents 到 ref（不触发 refreshRuntimeStates 重建）
  useEffect(() => {
    userAgentsRef.current = userAgents
  }, [userAgents])

  /**
   * 批量拉取用户 Agent 的运行时状态快照。
   * 用于在 Feed / Grid / Map 中展示”运行中”动态图标。
   * 使用 ref 读取最新 userAgents，避免依赖变化导致定时器频繁重置、Map 节点消失。
   */
  const refreshRuntimeStates = useCallback(async () => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.getLifecycleSnapshot) return
    const ids = userAgentsRef.current.map((a) => a.id)
    if (ids.length === 0) return  // 不清空已有数据，等列表加载完再更新
    const entries = await Promise.all(
      ids.map(async (id) => {
        try {
          const snapshot = await api.getLifecycleSnapshot(id) as { anyRunning?: boolean; runningCount?: number }
          return [id, { anyRunning: !!snapshot.anyRunning, runningCount: Number(snapshot.runningCount ?? 0) } satisfies AgentRuntimeState] as const
        } catch {
          return [id, undefined] as const
        }
      }),
    )
    setRuntimeStateMap(Object.fromEntries(entries))
  }, [])  // 无依赖：定时器只启动一次，通过 ref 读最新数据

  useEffect(() => {
    void refreshRuntimeStates()
    const timer = window.setInterval(() => {
      void refreshRuntimeStates()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [refreshRuntimeStates])  // refreshRuntimeStates 是稳定引用，定时器只创建一次

  const handleEditCapabilityChange = useCallback((id: string, enabled: boolean) => {
    setEditingAgent((prev) => {
      if (!prev) return prev
      const next = new Set(prev.data.enabledCapabilities)
      if (enabled) next.add(id)
      else next.delete(id)
      return { ...prev, data: { ...prev.data, enabledCapabilities: next } }
    })
  }, [])

  // suppress unused warning — agents is used by parent components via useAgents hook
  void agents

  // 将 Agent 数据转换为 ViewProps 兼容类型
  const viewUserAgents = userAgents as unknown as ViewAgent[]
  const viewSystemAgents = systemAgents as unknown as ViewAgent[]

  const handleViewEdit = useCallback(
    (agent: ViewAgent) => handleOpenEdit(agent as any),
    [handleOpenEdit],
  )
  const handleViewDelete = useCallback(
    (agentId: string) => setConfirmDeleteId(agentId),
    [],
  )
  const handleViewFork = useCallback(
    (agent: ViewAgent) =>
      handleForkSystem(agent.id, agent.name, agent.description, agent.systemPrompt),
    [handleForkSystem],
  )

  return (
    <div className={clsx(styles['agents-page'], embedded && styles['agents-page--embedded'])}>
      {/* Header */}
      <div className={styles['agents-header']}>
        <div className={styles['agents-title-section']}>
          {!embedded && (
            <>
              <h1 className={styles['agents-title']}>AI 团队</h1>
              <p className={styles['agents-subtitle']}>
                可视化管理你的 AI 助手团队，协调者将自动调用它们完成复杂任务
              </p>
            </>
          )}
        </div>
        <div className={styles['agents-action-buttons']}>
          <button
            className={styles['agents-generate-btn']}
            onClick={() => setShowGenerateWizard(true)}
          >
            <Sparkles size={14} /> AI 生成团队
          </button>
          {userAgents.length > 0 && (
            <button
              className={styles['agents-optimize-btn']}
              onClick={() => setShowOptimizeWizard(true)}
            >
              <Zap size={14} /> 优化团队
            </button>
          )}
          <button className={styles['agents-create-btn']} onClick={handleCreateBlank}>
            + 新建 Agent
          </button>
          <button
            className={styles['agents-sync-btn']}
            onClick={() => { void syncUserAgentDefinitions() }}
            disabled={definitionSync.kind === 'syncing'}
            title="将 Agent 配置同步到本地运行时"
          >
            {definitionSync.kind === 'syncing' ? <><Loader2 size={14} className="animate-spin" /> 同步中…</> : <><RefreshCw size={14} /> 同步定义</>}
          </button>
        </div>
      </div>

      {resultMessage && (
        <div className={clsx(styles['result-banner'], styles[`result-banner--${resultMessage.type}`])}>
          {resultMessage.type === 'success' ? <Check size={14} /> : <X size={14} />} {resultMessage.text}
        </div>
      )}


      {/* Toolbar: 视图切换 + 搜索 */}
      <div className={styles['agents-toolbar']}>
        <div className={styles['view-switcher']}>
          <button
            className={clsx(styles['view-btn'], currentView === 'map' && styles['view-btn--active'])}
            onClick={() => setCurrentView('map')}
            title="组织架构图"
          >
            <Network size={14} /> Map
          </button>
          <button
            className={clsx(styles['view-btn'], currentView === 'grid' && styles['view-btn--active'])}
            onClick={() => setCurrentView('grid')}
            title="卡片网格"
          >
            <LayoutGrid size={14} /> Grid
          </button>
          <button
            className={clsx(styles['view-btn'], currentView === 'feed' && styles['view-btn--active'])}
            onClick={() => setCurrentView('feed')}
            title="紧凑列表"
          >
            <List size={14} /> Feed
          </button>
        </div>
        <div className={styles['agents-search']}>
          <input
            type="text"
            placeholder="搜索 Agent..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={styles['agents-search-input']}
          />
          <div
            className={styles['agents-sync-status']}
            title={
              definitionSync.lastError
                ? definitionSync.lastError
                : definitionSync.lastSyncAt
                  ? `上次同步：${definitionSync.lastSyncAt.toLocaleString()}`
                  : '尚未完成本地定义同步'
            }
          >
            <span
              className={clsx(
                styles['agents-sync-dot'],
                definitionSync.kind === 'synced' && styles['agents-sync-dot--synced'],
                definitionSync.kind === 'stale' && styles['agents-sync-dot--stale'],
                definitionSync.kind === 'syncing' && styles['agents-sync-dot--syncing'],
                definitionSync.kind === 'error' && styles['agents-sync-dot--error'],
                definitionSync.kind === 'idle' && styles['agents-sync-dot--idle'],
              )}
              onClick={
                definitionSync.kind === 'error'
                  ? () => {
                      void syncUserAgentDefinitions()
                    }
                  : undefined
              }
              role={definitionSync.kind === 'error' ? 'button' : undefined}
            />
            <span className={styles['agents-sync-label']}>
              {definitionSync.kind === 'syncing' && '同步中…'}
              {definitionSync.kind === 'error' && '同步失败（点击重试）'}
              {definitionSync.kind === 'synced' && '已同步'}
              {definitionSync.kind === 'stale' && '建议刷新'}
              {definitionSync.kind === 'idle' && '待同步'}
            </span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className={clsx(styles['agents-content'], currentView === 'map' && styles['agents-content--map'])}>
        {isLoading ? (
          <div className={styles['agents-loading']}>加载中...</div>
        ) : error ? (
          <div className={styles['agents-error']}>{error}</div>
        ) : currentView === 'map' ? (
          <MapView
            userAgents={viewUserAgents}
            systemAgents={viewSystemAgents}
            searchQuery={searchQuery}
            runtimeStateMap={runtimeStateMap}
            onEdit={handleViewEdit}
            onDelete={handleViewDelete}
            onFork={handleViewFork}
            onStartChat={handleStartChat}
            missingSkillsMap={agentMissingSkills}
            onInstallSkill={handleInstallSkill}
            onNavigateToStore={handleNavigateToStore}
          />
        ) : currentView === 'grid' ? (
          <GridView
            userAgents={viewUserAgents}
            systemAgents={viewSystemAgents}
            searchQuery={searchQuery}
            runtimeStateMap={runtimeStateMap}
            onEdit={handleViewEdit}
            onDelete={handleViewDelete}
            onFork={handleViewFork}
            onStartChat={handleStartChat}
            missingSkillsMap={agentMissingSkills}
            onInstallSkill={handleInstallSkill}
            onNavigateToStore={handleNavigateToStore}
          />
        ) : (
          <FeedView
            userAgents={viewUserAgents}
            systemAgents={viewSystemAgents}
            searchQuery={searchQuery}
            runtimeStateMap={runtimeStateMap}
            onEdit={handleViewEdit}
            onDelete={handleViewDelete}
            onFork={handleViewFork}
            onStartChat={handleStartChat}
            missingSkillsMap={agentMissingSkills}
            onInstallSkill={handleInstallSkill}
            onNavigateToStore={handleNavigateToStore}
          />
        )}
      </div>

      {/* 编辑 Modal */}
      {editingAgent && (
        <div className={styles['modal-overlay']} onClick={() => setEditingAgent(null)}>
          <div className={styles['modal']} onClick={(e) => e.stopPropagation()}>
            <div className={styles['modal-header']}>
              <h2 className={styles['modal-title']}>编辑 Agent</h2>
              <button className={styles['modal-close']} onClick={() => setEditingAgent(null)}>✕</button>
            </div>
            <div className={styles['modal-body']}>
              <AgentBasicFields
                value={editingAgent.data}
                onChange={(patch) => setEditingAgent((prev) => prev ? { ...prev, data: { ...prev.data, ...patch } } : null)}
                mode="edit"
              />
              <AgentRoutingFields
                value={editingAgent.data}
                onChange={(patch) => setEditingAgent((prev) => prev ? { ...prev, data: { ...prev.data, ...patch } } : null)}
                mode="edit"
              />
              <AgentCategoryModelFields
                value={editingAgent.data}
                onChange={(patch) => setEditingAgent((prev) => prev ? { ...prev, data: { ...prev.data, ...patch } } : null)}
              />
              <AgentSkillsField
                value={editingAgent.data}
                onChange={(patch) => setEditingAgent((prev) => prev ? { ...prev, data: { ...prev.data, ...patch } } : null)}
                userSkills={userSkills}
                mode="edit"
                onNavigateToStoreAndClose={(skillName) => {
                  setEditingAgent(null)
                  window.dispatchEvent(
                    new CustomEvent('mtbot:open-skill-store', {
                      detail: { query: skillName },
                    }),
                  )
                  onViewChange?.('skills')
                }}
              />
              <AgentCapabilitiesField
                enabledCapabilities={editingAgent.data.enabledCapabilities}
                onToggle={handleEditCapabilityChange}
                mode="edit"
              />
            </div>
            <div className={styles['modal-footer']}>
              <button
                className={clsx(styles['modal-btn'], styles['modal-btn--primary'])}
                onClick={handleSave}
                disabled={isSubmitting || !editingAgent.data.name.trim()}
              >
                {isSubmitting ? '保存中...' : '保存'}
              </button>
              <button
                className={clsx(styles['modal-btn'], styles['modal-btn--ghost'])}
                onClick={() => setEditingAgent(null)}
                disabled={isSubmitting}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建 Modal */}
      {showCreateModal && (
        <div className={styles['modal-overlay']} onClick={() => setShowCreateModal(false)}>
          <div className={styles['modal']} onClick={(e) => e.stopPropagation()}>
            <div className={styles['modal-header']}>
              <h2 className={styles['modal-title']}>新建 Agent</h2>
              <button className={styles['modal-close']} onClick={() => setShowCreateModal(false)}>✕</button>
            </div>
            <div className={styles['modal-body']}>
              <AgentBasicFields
                value={createForm}
                onChange={(patch) => setCreateForm((prev) => ({ ...prev, ...patch }))}
                mode="create"
              />
              <AgentRoutingFields
                value={createForm}
                onChange={(patch) => setCreateForm((prev) => ({ ...prev, ...patch }))}
                mode="create"
              />
              <AgentCategoryModelFields
                value={createForm}
                onChange={(patch) => setCreateForm((prev) => ({ ...prev, ...patch }))}
              />
              <AgentSkillsField
                value={createForm}
                onChange={(patch) => setCreateForm((prev) => ({ ...prev, ...patch }))}
                userSkills={userSkills}
                mode="create"
              />
              <AgentCapabilitiesField
                enabledCapabilities={createForm.enabledCapabilities}
                onToggle={handleCreateCapabilityChange}
                mode="create"
              />
            </div>
            <div className={styles['modal-footer']}>
              <button
                className={clsx(styles['modal-btn'], styles['modal-btn--primary'])}
                onClick={() => handleCreate(createSourceId)}
                disabled={isSubmitting || !createForm.name.trim() || !createForm.description.trim() || !createForm.systemPrompt.trim()}
              >
                {isSubmitting ? '创建中...' : '创建 Agent'}
              </button>
              <button
                className={clsx(styles['modal-btn'], styles['modal-btn--ghost'])}
                onClick={() => setShowCreateModal(false)}
                disabled={isSubmitting}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 空状态引导 */}
      {!isLoading && !error && userAgents.length === 0 && (
        <EmptyStateGuide
          onGenerate={() => setShowGenerateWizard(true)}
          onCreateBlank={handleCreateBlank}
        />
      )}

      {/* AI 生成团队向导 */}
      {showGenerateWizard && (
        <GenerateTeamWizard
          systemAgents={systemAgents}
          capabilityOptions={CAPABILITY_OPTIONS}
          userSkills={userSkills}
          onClose={() => setShowGenerateWizard(false)}
          onComplete={() => { void refreshAgents(); window.dispatchEvent(new CustomEvent('mtbot:agents-changed')) }}
        />
      )}

      {/* 优化团队向导 */}
      {showOptimizeWizard && (
        <OptimizeTeamWizard
          userAgents={userAgents.map((a) => ({
            id: a.id,
            name: a.name,
            emoji: (a as any).emoji,
            description: a.description,
            systemPrompt: (a as any).systemPrompt,
          }))}
          onClose={() => setShowOptimizeWizard(false)}
          onComplete={() => { setShowOptimizeWizard(false); void refreshAgents() }}
        />
      )}

      {/* 删除确认 */}
      {confirmDeleteId && (
        <div className={styles['modal-overlay']} onClick={() => setConfirmDeleteId(null)}>
          <div className={clsx(styles['modal'], styles['modal--sm'])} onClick={(e) => e.stopPropagation()}>
            <div className={styles['modal-header']}>
              <h2 className={styles['modal-title']}>删除 Agent</h2>
            </div>
            <div className={styles['modal-body']}>
              <p className={styles['confirm-text']}>
                确认删除这个 Agent？删除后协调者将无法再调用它。
              </p>
            </div>
            <div className={styles['modal-footer']}>
              <button
                className={clsx(styles['modal-btn'], styles['modal-btn--danger'])}
                onClick={handleDelete}
                disabled={isSubmitting}
              >
                {isSubmitting ? '删除中...' : '确认删除'}
              </button>
              <button
                className={clsx(styles['modal-btn'], styles['modal-btn--ghost'])}
                onClick={() => setConfirmDeleteId(null)}
                disabled={isSubmitting}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AgentsPage
export { AgentsPage }
