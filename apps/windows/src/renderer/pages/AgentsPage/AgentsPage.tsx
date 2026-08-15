/**
 * AgentsPage - Agent 管理页面
 *
 * 支持查看系统 Agent、创建/编辑/删除用户 Agent
 * 包含技能和工具配置（对非技术用户友好的白话描述）
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Search, Globe, FileText, FilePen, Terminal, CheckSquare, GitBranch, Clock, Zap, Scale, Rocket, Sparkles, Network, LayoutGrid, List, RefreshCw, Check, X, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { useAgents } from '../../hooks/business/useAgents/useAgents'
import { updateAgent, deleteAgent, type ModelTier } from '../../services/agent-service'
import { MapView } from './views/MapView'
import { GridView } from './views/GridView'
import { FeedView } from './views/FeedView'
import { getStoredView, VIEW_STORAGE_KEY, type AgentView, type Agent as ViewAgent } from './views/types'
import type { ViewType } from '../../components/layout/Sidebar/Sidebar'
import { GenerateTeamWizard } from './components/GenerateTeamWizard/GenerateTeamWizard'
import { OptimizeTeamWizard } from './components/OptimizeTeamWizard/OptimizeTeamWizard'
import { EmptyStateGuide } from './components/EmptyStateGuide/EmptyStateGuide'
import styles from './AgentsPage.module.css'
import type { AgentRuntimeState } from './views/types'

// ── 工具能力配置（白话描述，非技术用户可理解）──────────────────────────
// 工具名称与 bridge.ts 内 ALL_BUILT_IN_TOOL_CONFIGS 保持一致
interface CapabilityOption {
  id: string
  label: string
  description: string
  toolNames: string[]
  icon?: React.ReactNode
}

const CAPABILITY_OPTIONS: CapabilityOption[] = [
  {
    id: 'web_search',
    label: '联网搜索',
    description: '可以搜索互联网获取最新信息',
    toolNames: ['web_search'],
    icon: <Search size={14} />,
  },
  {
    id: 'web_fetch',
    label: '访问网页',
    description: '可以打开和阅读网页内容',
    toolNames: ['web_fetch'],
    icon: <Globe size={14} />,
  },
  {
    id: 'file_read',
    label: '读取文件',
    description: '可以读取设备上的文件和目录',
    toolNames: ['file_read', 'glob', 'grep'],
    icon: <FileText size={14} />,
  },
  {
    id: 'file_write',
    label: '修改文件',
    description: '可以创建和编辑设备上的文件',
    toolNames: ['file_write', 'file_edit'],
    icon: <FilePen size={14} />,
  },
  {
    id: 'exec',
    label: '执行命令',
    description: '可以在设备上运行程序或命令',
    toolNames: ['bash'],
    icon: <Terminal size={14} />,
  },
  {
    id: 'task_tracking',
    label: '任务追踪',
    description: '会话内临时任务清单，追踪多步骤进度；会话结束后自动清空',
    toolNames: ['todo_write'],
    icon: <CheckSquare size={14} />,
  },
  {
    id: 'agent_delegation',
    label: '协调子 Agent',
    description: '可以委派其他 Agent 并行处理子任务',
    toolNames: ['spawn_agent', 'send_message'],
    icon: <GitBranch size={14} />,
  },
  {
    id: 'scheduling',
    label: '定时任务',
    description: '可以创建定时提醒和计划任务',
    toolNames: ['cron_create', 'cron_list', 'cron_delete'],
    icon: <Clock size={14} />,
  },
]

function capabilitiesToSkillBlacklist(enabledIds: Set<string>): string[] {
  const blacklist: string[] = []
  for (const cap of CAPABILITY_OPTIONS) {
    if (!enabledIds.has(cap.id)) {
      blacklist.push(...cap.toolNames)
    }
  }
  return blacklist
}

function skillBlacklistToCapabilityIds(blacklist: string[] | undefined): Set<string> {
  if (!blacklist || blacklist.length === 0) {
    return new Set(CAPABILITY_OPTIONS.map((c) => c.id))
  }
  const blackSet = new Set(blacklist)
  const enabled = new Set<string>()
  for (const cap of CAPABILITY_OPTIONS) {
    // 只要黑名单中不包含该能力的任意工具，则视为已启用
    if (!cap.toolNames.every((t) => blackSet.has(t))) {
      enabled.add(cap.id)
    }
  }
  return enabled
}

// ── 模型级别配置 ──────────────────────────────────────────────────────────
interface ModelTierOption {
  value: ModelTier
  label: string
  description: string
}

const MODEL_TIER_OPTIONS: ModelTierOption[] = [
  {
    value: 'basic',
    label: '基础',
    description: '速度快、成本低，适合简单任务',
  },
  {
    value: 'balanced',
    label: '均衡',
    description: '速度与能力兼顾，适合大多数任务',
  },
  {
    value: 'performance',
    label: '性能',
    description: '最强推理能力，适合复杂任务',
  },
]

// ── 用户技能类型 ────────────────────────────────────────────────────────
interface UserSkill {
  id: string
  name: string
  description?: string
  status?: string
}

// ── 表单数据类型 ─────────────────────────────────────────────────────────
interface AgentFormData {
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

function defaultCapabilities(): Set<string> {
  return new Set(CAPABILITY_OPTIONS.map((c) => c.id))
}

const DEFAULT_MODEL_TIER: ModelTier = 'basic'

// ── 能力开关组件 ─────────────────────────────────────────────────────────
const CapabilityToggle: React.FC<{
  option: CapabilityOption
  enabled: boolean
  onChange: (id: string, enabled: boolean) => void
}> = ({ option, enabled, onChange }) => (
  <div
    className={clsx(styles['capability-item'], enabled && styles['capability-item--on'])}
    onClick={() => onChange(option.id, !enabled)}
    role="checkbox"
    aria-checked={enabled}
    tabIndex={0}
    onKeyDown={(e) => e.key === ' ' && onChange(option.id, !enabled)}
  >
    <div className={styles['capability-info']}>
      <span className={styles['capability-label']}>{option.icon && <span style={{ marginRight: 4, display: 'inline-flex', verticalAlign: 'middle' }}>{option.icon}</span>}{option.label}</span>
      <span className={styles['capability-desc']}>{option.description}</span>
    </div>
    <div className={clsx(styles['capability-switch'], enabled && styles['capability-switch--on'])} />
  </div>
)

// ── 主页面 ───────────────────────────────────────────────────────────────
interface AgentsPageProps {
  onViewChange?: (view: ViewType) => void
  /** Hub 嵌入时收紧布局，弱化页头标题区 */
  embedded?: boolean
}

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
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>名称 *</label>
                <input
                  type="text"
                  className={styles['form-input']}
                  value={editingAgent.data.name}
                  onChange={(e) =>
                    setEditingAgent((prev) =>
                      prev ? { ...prev, data: { ...prev.data, name: e.target.value } } : null,
                    )
                  }
                  placeholder="Agent 名称"
                />
              </div>
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>描述（可选）</label>
                <input
                  type="text"
                  className={styles['form-input']}
                  value={editingAgent.data.description}
                  onChange={(e) =>
                    setEditingAgent((prev) =>
                      prev ? { ...prev, data: { ...prev.data, description: e.target.value } } : null,
                    )
                  }
                  placeholder="描述这个 Agent 的专长"
                />
              </div>
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>系统提示词</label>
                <textarea
                  className={styles['form-textarea']}
                  value={editingAgent.data.systemPrompt}
                  onChange={(e) =>
                    setEditingAgent((prev) =>
                      prev ? { ...prev, data: { ...prev.data, systemPrompt: e.target.value } } : null,
                    )
                  }
                  placeholder="描述这个 Agent 的角色、能力和行为方式..."
                  rows={5}
                />
                <div className={styles['form-hint']}>
                  系统提示词定义了 Agent 的专业角色。协调者在分配任务时会根据名称、描述和提示词做决策。
                </div>
              </div>

              {/* ─── Pre-LLM Router 路由信号（v2） ─── */}
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>
                  🔀 何时使用 (whenToUse)
                  <span className={styles['form-hint-inline']}>填写后可显著提升路由准确率</span>
                </label>
                <textarea
                  className={styles['form-textarea']}
                  value={editingAgent.data.whenToUse}
                  onChange={(e) =>
                    setEditingAgent((prev) =>
                      prev ? { ...prev, data: { ...prev.data, whenToUse: e.target.value } } : null,
                    )
                  }
                  placeholder='用户视角描述。例："用户想要写代码、调试或重构时"'
                  rows={2}
                />
              </div>

              <div className={styles['form-field']}>
                <label className={styles['form-label']}>触发例子 (triggerExamples)</label>
                <textarea
                  className={styles['form-textarea']}
                  value={editingAgent.data.triggerExamples}
                  onChange={(e) =>
                    setEditingAgent((prev) =>
                      prev ? { ...prev, data: { ...prev.data, triggerExamples: e.target.value } } : null,
                    )
                  }
                  placeholder={'用户可能说的原话，每行一句。例如：\n帮我写个函数\n这段代码有 bug'}
                  rows={3}
                />
                <div className={styles['form-hint']}>每行一个例子，建议 3-10 条。</div>
              </div>

              <div className={styles['form-field']}>
                <label className={styles['form-label']}>绑定技能 (bundledSkills)</label>
                <textarea
                  className={styles['form-textarea']}
                  value={editingAgent.data.bundledSkills}
                  onChange={(e) =>
                    setEditingAgent((prev) =>
                      prev ? { ...prev, data: { ...prev.data, bundledSkills: e.target.value } } : null,
                    )
                  }
                  placeholder={'技能 ID 列表，每行一个。例如：\ncode-review\ntranslate'}
                  rows={3}
                />
                <div className={styles['form-hint']}>
                  Agent 启动时自动激活这些技能，无需再 skill_search。
                </div>
              </div>

              <div className={styles['form-field']}>
                <label className={styles['form-label']}>分类 (category)</label>
                <input
                  type="text"
                  className={styles['form-input']}
                  value={editingAgent.data.category}
                  onChange={(e) =>
                    setEditingAgent((prev) =>
                      prev ? { ...prev, data: { ...prev.data, category: e.target.value } } : null,
                    )
                  }
                  placeholder="例：coding / writing / learning / life / general"
                />
              </div>
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>
                  模型级别
                  <span className={styles['form-hint-inline']}>决定子任务使用的 AI 模型能力</span>
                </label>
                <select
                  className={styles['form-select']}
                  value={editingAgent.data.modelTier}
                  onChange={(e) =>
                    setEditingAgent((prev) =>
                      prev ? { ...prev, data: { ...prev.data, modelTier: e.target.value as ModelTier } } : null,
                    )
                  }
                >
                  {MODEL_TIER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} — {opt.description}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>
                  专属技能
                  <span className={styles['form-hint-inline']}>为 Agent 配备自定义技能</span>
                </label>
                {/* 检测此客户端本地缺少的技能并提示 */}
                {(() => {
                  const localSkillNames = new Set(userSkills.map((s) => s.name))
                  const missing = editingAgent.data.selectedSkills.filter((name) => !localSkillNames.has(name))
                  if (missing.length === 0) return null
                  return (
                    <div className={styles['skill-missing-warning']}>
                      <span className={styles['skill-missing-title']}>
                        ⚠ 本机缺少以下技能，Agent 在此设备上将无法使用它们
                      </span>
                      <div className={styles['skill-missing-list']}>
                        {missing.map((name) => (
                          <span key={name} className={styles['skill-missing-item']}>· {name}</span>
                        ))}
                      </div>
                      <div className={styles['skill-missing-actions']}>
                        <span className={styles['skill-missing-hint']}>
                          前往技能商店搜索并安装，或从原始设备导出后导入。
                        </span>
                        <button
                          type="button"
                          className={styles['skill-missing-btn']}
                          onClick={() => {
                            setEditingAgent(null)
                            window.dispatchEvent(
                              new CustomEvent('mtbot:open-skill-store', {
                                detail: { query: missing[0] },
                              }),
                            )
                            onViewChange?.('skills')
                          }}
                        >
                          🏪 去商店下载
                        </button>
                      </div>
                    </div>
                  )
                })()}
                {userSkills.length === 0 ? (
                  <div className={styles['skill-empty-hint']}>暂无自定义技能，可在技能页面创建</div>
                ) : (
                  <div className={styles['skill-list']}>
                    {userSkills.map((skill) => {
                      const checked = editingAgent.data.selectedSkills.includes(skill.name)
                      return (
                        <label
                          key={skill.id}
                          className={clsx(styles['skill-item'], checked && styles['skill-item--checked'])}
                        >
                          <input
                            type="checkbox"
                            className={styles['skill-checkbox']}
                            checked={checked}
                            onChange={() =>
                              setEditingAgent((prev) => {
                                if (!prev) return prev
                                const next = checked
                                  ? prev.data.selectedSkills.filter((s) => s !== skill.name)
                                  : [...prev.data.selectedSkills, skill.name]
                                return { ...prev, data: { ...prev.data, selectedSkills: next } }
                              })
                            }
                          />
                          <div className={styles['skill-info']}>
                            <span className={styles['skill-name']}>{skill.name}</span>
                            {skill.description && (
                              <span className={styles['skill-desc']}>{skill.description}</span>
                            )}
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>
                  可用能力
                  <span className={styles['form-hint-inline']}>开启后 Agent 才能使用该能力</span>
                </label>
                <div className={styles['capability-list']}>
                  {CAPABILITY_OPTIONS.map((cap) => (
                    <CapabilityToggle
                      key={cap.id}
                      option={cap}
                      enabled={editingAgent.data.enabledCapabilities.has(cap.id)}
                      onChange={handleEditCapabilityChange}
                    />
                  ))}
                </div>
              </div>
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
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>名称 *</label>
                <input
                  type="text"
                  className={styles['form-input']}
                  value={createForm.name}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="例如：代码审查专家"
                  autoFocus
                />
              </div>
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>
                  描述 <span className={styles['form-required']}>*</span>
                </label>
                <input
                  type="text"
                  className={styles['form-input']}
                  value={createForm.description}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="描述这个 Agent 的专长，协调者会据此选择 Agent"
                />
                <div className={styles['form-hint']}>
                  协调者 Agent 会根据名称和描述来决定何时调用此 Agent
                </div>
              </div>
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>
                  系统提示词 <span className={styles['form-required']}>*</span>
                </label>
                <textarea
                  className={styles['form-textarea']}
                  value={createForm.systemPrompt}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, systemPrompt: e.target.value }))}
                  placeholder="例如：你是一个严格的代码审查专家，专注于代码质量、安全漏洞和性能问题，提供清晰的改进建议..."
                  rows={4}
                />
              </div>

              {/* ─── Pre-LLM Router 路由信号（v2） ─── */}
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>
                  🔀 何时使用 (whenToUse)
                  <span className={styles['form-hint-inline']}>填写后可显著提升路由准确率</span>
                </label>
                <textarea
                  className={styles['form-textarea']}
                  value={createForm.whenToUse}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, whenToUse: e.target.value }))}
                  placeholder='例："用户想要写代码、调试或重构时"'
                  rows={2}
                />
              </div>

              <div className={styles['form-field']}>
                <label className={styles['form-label']}>触发例子 (triggerExamples)</label>
                <textarea
                  className={styles['form-textarea']}
                  value={createForm.triggerExamples}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, triggerExamples: e.target.value }))}
                  placeholder={'每行一个用户可能说的原话，例如：\n帮我写个函数\n这段代码有 bug'}
                  rows={3}
                />
              </div>

              <div className={styles['form-field']}>
                <label className={styles['form-label']}>绑定技能 (bundledSkills)</label>
                <textarea
                  className={styles['form-textarea']}
                  value={createForm.bundledSkills}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, bundledSkills: e.target.value }))}
                  placeholder={'技能 ID 列表，每行一个。例如：\ncode-review\ntranslate'}
                  rows={3}
                />
                <div className={styles['form-hint']}>
                  Agent 启动时自动激活这些技能（"Agent = 能力包"模式）
                </div>
              </div>

              <div className={styles['form-field']}>
                <label className={styles['form-label']}>分类 (category)</label>
                <input
                  type="text"
                  className={styles['form-input']}
                  value={createForm.category}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, category: e.target.value }))}
                  placeholder="例：coding / writing / learning / life / general"
                />
              </div>
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>
                  模型级别
                  <span className={styles['form-hint-inline']}>决定子任务使用的 AI 模型能力</span>
                </label>
                <select
                  className={styles['form-select']}
                  value={createForm.modelTier}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, modelTier: e.target.value as ModelTier }))}
                >
                  {MODEL_TIER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} — {opt.description}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>
                  专属技能
                  <span className={styles['form-hint-inline']}>为 Agent 配备自定义技能</span>
                </label>
                {userSkills.length === 0 ? (
                  <div className={styles['skill-empty-hint']}>暂无自定义技能，可在技能页面创建</div>
                ) : (
                  <div className={styles['skill-list']}>
                    {userSkills.map((skill) => {
                      const checked = createForm.selectedSkills.includes(skill.name)
                      return (
                        <label
                          key={skill.id}
                          className={clsx(styles['skill-item'], checked && styles['skill-item--checked'])}
                        >
                          <input
                            type="checkbox"
                            className={styles['skill-checkbox']}
                            checked={checked}
                            onChange={() =>
                              setCreateForm((prev) => {
                                const next = checked
                                  ? prev.selectedSkills.filter((s) => s !== skill.name)
                                  : [...prev.selectedSkills, skill.name]
                                return { ...prev, selectedSkills: next }
                              })
                            }
                          />
                          <div className={styles['skill-info']}>
                            <span className={styles['skill-name']}>{skill.name}</span>
                            {skill.description && (
                              <span className={styles['skill-desc']}>{skill.description}</span>
                            )}
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className={styles['form-field']}>
                <label className={styles['form-label']}>
                  可用能力
                  <span className={styles['form-hint-inline']}>选择这个 Agent 可以使用哪些功能</span>
                </label>
                <div className={styles['capability-list']}>
                  {CAPABILITY_OPTIONS.map((cap) => (
                    <CapabilityToggle
                      key={cap.id}
                      option={cap}
                      enabled={createForm.enabledCapabilities.has(cap.id)}
                      onChange={handleCreateCapabilityChange}
                    />
                  ))}
                </div>
              </div>
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
