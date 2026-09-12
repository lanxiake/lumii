/**
 * 自主进化仪表板页面
 * - 标题行合并启用开关
 * - 概览：三列卡片（评分 / 趋势 / 待审批）
 * - 能力：左雷达 + 右维度列表
 * - 反思：左列表 + 右详情
 */

import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Card } from '../../components/ui/Card/Card'
import { Tooltip } from '../../components/ui/Tooltip/Tooltip'
import { Modal } from '../../components/ui/Modal/Modal'
import { CapabilityRadar } from '../../components/CapabilityRadar/CapabilityRadar'
import { CapabilityProgressBar } from '../../components/CapabilityProgressBar/CapabilityProgressBar'
import { ReflectionCard, type Reflection } from '../../components/ReflectionCard/ReflectionCard'
import { SatisfactionChart, type SatisfactionDataPoint } from '../../components/SatisfactionChart/SatisfactionChart'
import { PromptVariantStats, type PromptFragmentStats } from '../../components/PromptVariantStats/PromptVariantStats'
import { LabeledMetric, MetricTip, TitledHeader } from './MetricTip'
import { MoodAvatar } from './MoodAvatar'
import {
  TIP_BREAKDOWN,
  TIP_CAPABILITY_DIMENSIONS,
  TIP_CAPABILITY_RADAR,
  TIP_ENABLED,
  TIP_GOAL,
  TIP_PENDING_GOALS,
  TIP_PROMPT_STATS,
  TIP_REFLECTION,
  TIP_REFLECTION_LIST,
  TIP_SATISFACTION_CHART,
  TIP_SATISFACTION_OVERALL,
  TIP_SATISFACTION_TREND,
  TIP_SETTINGS,
  TIP_INNER_MOOD,
  TIP_INNER_CONCERNS,
  TIP_INNER_DIARY,
} from './autonomousTooltips'
import styles from './AutonomousPage.module.css'

type AutonomousStatus = {
  enabled: boolean
  satisfaction: {
    overall: number
    trend: 'improving' | 'stable' | 'declining'
    breakdown: {
      taskCompletion: number
      userFeedback: number
      efficiency: number
      knowledgeGrowth: number
    }
  }
}

type AutonomousGoal = {
  id: string
  type: string
  description: string
  triggerReason: string
  status?: string
  priority: number
  userValueScore?: number
  feasibility?: number
  createdAt?: string
  reflectionId?: string | null
}

type PlannedGoal = AutonomousGoal & {
  scheduledFor?: string | null
}

type CapabilityTest = {
  id: string
  dimension: string
  taskSummary: string
  difficulty: number
  result: 'success' | 'partial' | 'failure'
  levelBefore: number | null
  levelAfter: number | null
  createdAt: string
}

type AutonomousSettings = {
  enabled: boolean
  tickIntervalMinutes: number
  quietHours: [number, number]
  maxOutreachPerDay: number
  minOutreachIntervalMinutes: number
  outreachChannels: string[]
  maxTokensPerDay: number
  maxGoalsPerDay: number
  approvalMode: 'always' | 'risky-only' | 'never'
  reflectionGoalPriorityThreshold: number
}

type MoodState = {
  energy: number
  valence: number
  arousal: number
  updatedAt: number
}

type Concern = {
  id: string
  description: string
  origin: string
  arousalWeight: number
  raisedCount: number
  nextRaiseAfter: number
  status: 'open' | 'resolved' | 'dropped'
}

type DiaryEntry = {
  id: string
  text: string
  timestamp: number
}

type DiaryPage = {
  items: DiaryEntry[]
  hasMore: boolean
  nextBefore: { timestamp: number; id: string } | null
}

const DIARY_PAGE_SIZE = 8

const api = window.electronAPI?.autonomous || {
  getStatus: () => Promise.reject(new Error('API not available')),
  getPendingGoals: () => Promise.reject(new Error('API not available')),
  getGoals: () => Promise.reject(new Error('API not available')),
  getPlannedGoals: () => Promise.reject(new Error('API not available')),
  deleteGoal: () => Promise.reject(new Error('API not available')),
  replan: () => Promise.reject(new Error('API not available')),
  approveGoal: () => Promise.reject(new Error('API not available')),
  rejectGoal: () => Promise.reject(new Error('API not available')),
  getCapabilities: () => Promise.reject(new Error('API not available')),
  getCapabilityTests: () => Promise.reject(new Error('API not available')),
  getReflections: () => Promise.reject(new Error('API not available')),
  getSatisfactionHistory: () => Promise.reject(new Error('API not available')),
  getPromptStats: () => Promise.reject(new Error('API not available')),
  setEnabled: () => Promise.reject(new Error('API not available')),
  getSettings: () => Promise.reject(new Error('API not available')),
  updateSettings: () => Promise.reject(new Error('API not available')),
  getMood: () => Promise.reject(new Error('API not available')),
  getConcerns: () => Promise.reject(new Error('API not available')),
  getDiary: () => Promise.reject(new Error('API not available')),
}

type TabType = 'overview' | 'capabilities' | 'planned' | 'reflections' | 'prompt' | 'settings' | 'inner'

const TRIGGER_LABELS: Record<string, string> = {
  'low-satisfaction': '满意度低',
  scheduled: '定时反思',
  'user-request': '用户请求',
  'capability-gap': '能力缺口',
}

const GOAL_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  executing: '执行中',
  completed: '已完成',
  failed: '失败',
}

/**
 * 自主进化仪表板
 *
 * embedded=true 时作为设置页「自主进化（实验）」分类嵌入展示：
 * 去掉居中最大宽度，撑满设置内容区；其余逻辑与独立页完全一致。
 */
export function AutonomousPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [status, setStatus] = useState<AutonomousStatus | null>(null)
  const [goals, setGoals] = useState<AutonomousGoal[]>([])
  const [plannedGoals, setPlannedGoals] = useState<PlannedGoal[]>([])
  const [replanning, setReplanning] = useState(false)
  const [capabilities, setCapabilities] = useState<Record<string, any>>({})
  const [reflections, setReflections] = useState<Reflection[]>([])
  const [satisfactionHistory, setSatisfactionHistory] = useState<SatisfactionDataPoint[]>([])
  const [promptStats, setPromptStats] = useState<PromptFragmentStats[]>([])
  const [settings, setSettings] = useState<AutonomousSettings | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [mood, setMood] = useState<MoodState | null>(null)
  const [concerns, setConcerns] = useState<Concern[]>([])
  const [diary, setDiary] = useState<DiaryEntry[]>([])
  const [diaryHasMore, setDiaryHasMore] = useState(false)
  const [diaryCursor, setDiaryCursor] = useState<{ timestamp: number; id: string } | null>(null)
  const [diaryLoadingMore, setDiaryLoadingMore] = useState(false)
  const [selectedDiary, setSelectedDiary] = useState<DiaryEntry | null>(null)
  const diaryInitializedRef = useRef(false)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabType>('overview')
  const [autonomousEnabled, setAutonomousEnabled] = useState(true)
  const [selectedReflectionId, setSelectedReflectionId] = useState<string | null>(null)
  const [capabilityTests, setCapabilityTests] = useState<CapabilityTest[]>([])
  const [expandedDimension, setExpandedDimension] = useState<string | null>(null)

  useEffect(() => {
    loadData()
    const timer = setInterval(loadData, 30000)
    return () => clearInterval(timer)
  }, [])

  /** 加载自主进化相关数据 */
  async function loadData() {
    try {
      const [statusData, goalsData, plannedGoalsData, capabilitiesData, capabilityTestsData, reflectionsData, historyData, promptData, settingsData, moodData, concernsData, diaryData] = await Promise.all([
        api.getStatus(),
        api.getGoals(20),
        api.getPlannedGoals(50).catch(() => []),
        api.getCapabilities().catch(() => ({})),
        api.getCapabilityTests().catch(() => []),
        api.getReflections(20).catch(() => []),
        api.getSatisfactionHistory('7d').catch(() => ({ dataPoints: [] })),
        api.getPromptStats().catch(() => []),
        api.getSettings().catch(() => null),
        api.getMood().catch(() => null),
        api.getConcerns().catch(() => []),
        api.getDiary(DIARY_PAGE_SIZE).catch(() => ({ items: [], hasMore: false, nextBefore: null })),
      ])
      setStatus(statusData)
      setGoals(goalsData)
      setPlannedGoals(Array.isArray(plannedGoalsData) ? (plannedGoalsData as PlannedGoal[]) : [])
      setCapabilities(capabilitiesData)
      setCapabilityTests(Array.isArray(capabilityTestsData) ? (capabilityTestsData as CapabilityTest[]) : [])
      setReflections(reflectionsData)
      setSatisfactionHistory(historyData.dataPoints || [])
      setPromptStats(Array.isArray(promptData) ? (promptData as PromptFragmentStats[]) : [])
      setSettings(settingsData)
      setMood(moodData)
      setConcerns(Array.isArray(concernsData) ? (concernsData as Concern[]) : [])
      const diaryPage = diaryData as DiaryPage
      const incoming = diaryPage.items ?? []
      if (!diaryInitializedRef.current) {
        diaryInitializedRef.current = true
        setDiary(incoming)
        setDiaryHasMore(diaryPage.hasMore ?? false)
        setDiaryCursor(diaryPage.nextBefore ?? null)
      } else {
        // 周期刷新：只把最新写出的条目前插，保持已加载的「更早」分页与游标不变
        setDiary((prev) => {
          const existing = new Set(prev.map((d) => d.id))
          const fresh = incoming.filter((d) => !existing.has(d.id))
          return fresh.length > 0 ? [...fresh, ...prev] : prev
        })
      }
      setAutonomousEnabled(statusData.enabled !== false)
      setSelectedReflectionId((prev) => {
        if (prev && reflectionsData.some((r: Reflection) => r.id === prev)) return prev
        return reflectionsData[0]?.id ?? null
      })
    } catch (error) {
      console.error('[AutonomousPage] 加载数据失败:', error)
    } finally {
      setLoading(false)
    }
  }

  /** 加载更早的日记（游标分页） */
  async function loadMoreDiary() {
    if (!diaryCursor || diaryLoadingMore) return
    setDiaryLoadingMore(true)
    try {
      const page = await api.getDiary(DIARY_PAGE_SIZE, diaryCursor)
      setDiary((prev) => [...prev, ...(page.items ?? [])])
      setDiaryHasMore(page.hasMore ?? false)
      setDiaryCursor(page.nextBefore ?? null)
    } catch (error) {
      console.error('[AutonomousPage] 加载更多日记失败:', error)
    } finally {
      setDiaryLoadingMore(false)
    }
  }

  /** 批准目标 */
  async function handleApprove(goalId: string) {
    try {
      await api.approveGoal(goalId)
      await loadData()
    } catch (error) {
      console.error('[AutonomousPage] 批准目标失败:', error)
    }
  }

  /** 拒绝目标 */
  async function handleReject(goalId: string) {
    try {
      await api.rejectGoal(goalId)
      await loadData()
    } catch (error) {
      console.error('[AutonomousPage] 拒绝目标失败:', error)
    }
  }

  /** 删除规划目标（硬删，供「规划任务」tab） */
  async function handleDeletePlannedGoal(goalId: string) {
    try {
      await api.deleteGoal(goalId)
      setPlannedGoals((prev) => prev.filter((g) => g.id !== goalId))
    } catch (error) {
      console.error('[AutonomousPage] 删除规划目标失败:', error)
    }
  }

  /** 重置规划：让 Agent 重新规划未来 24h 任务 */
  async function handleReplan() {
    if (replanning) return
    setReplanning(true)
    try {
      await api.replan()
      await loadData()
    } catch (error) {
      console.error('[AutonomousPage] 重新规划失败:', error)
    } finally {
      setReplanning(false)
    }
  }

  /** 点击已处理的目标 → 跳转到关联反思 */
  function handleGoalJump(goal: AutonomousGoal) {
    if (!goal.reflectionId) return
    setActiveTab('reflections')
    setSelectedReflectionId(goal.reflectionId)
  }

  /** 切换自主进化开关 */
  function handleToggleAutonomous(enabled: boolean) {
    setAutonomousEnabled(enabled)
    api.setEnabled(enabled).then(() => {
      console.log('[AutonomousPage] 自主进化开关已更新:', enabled)
    }).catch((error) => {
      console.error('[AutonomousPage] 更新自主进化开关失败:', error)
      setAutonomousEnabled(!enabled)
    })
  }

  /** 保存设置（部分覆盖，非法值由后端回落默认） */
  async function handleSaveSettings() {
    if (!settings) return
    setSettingsSaving(true)
    setSettingsSaved(false)
    try {
      const updated = await api.updateSettings(settings)
      setSettings(updated)
      setSettingsSaved(true)
      setTimeout(() => setSettingsSaved(false), 2000)
    } catch (error) {
      console.error('[AutonomousPage] 保存设置失败:', error)
    } finally {
      setSettingsSaving(false)
    }
  }

  /** 局部更新设置草稿（不可变） */
  function patchSettings(patch: Partial<AutonomousSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  const selectedReflection = useMemo(
    () => reflections.find((r) => r.id === selectedReflectionId) ?? null,
    [reflections, selectedReflectionId],
  )

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>
          <div className={styles.spinner}>⏳</div>
          <span>加载中...</span>
        </div>
      </div>
    )
  }

  if (!status) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>无法加载自主进化数据</div>
      </div>
    )
  }

  return (
    <div className={`${styles.page} ${embedded ? styles.pageEmbedded : ''}`}>
      {/* 页头：标题 + 启用开关同行 */}
      <div className={styles.header}>
        <h1 className={styles.title}>自主进化</h1>
        <div className={styles.headerActions}>
          <Tooltip content={TIP_ENABLED} placement="bottom">
            <span className={styles.toggleLabel}>{autonomousEnabled ? '已启用' : '已禁用'}</span>
          </Tooltip>
          <MetricTip content={TIP_ENABLED} label="自主进化开关" placement="bottom" />
          <label className="toggle-switch" aria-label="启用或禁用自主进化">
            <input
              type="checkbox"
              checked={autonomousEnabled}
              onChange={(e) => handleToggleAutonomous(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {/* 标签页导航 */}
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'overview' ? styles.active : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          <svg className={styles.tabIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          概览
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'capabilities' ? styles.active : ''}`}
          onClick={() => setActiveTab('capabilities')}
        >
          <svg className={styles.tabIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          能力
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'planned' ? styles.active : ''}`}
          onClick={() => setActiveTab('planned')}
        >
          <svg className={styles.tabIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <rect x="3" y="4" width="18" height="18" rx="2" strokeWidth="2"/>
            <path d="M16 2v4M8 2v4M3 10h18" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          规划任务
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'reflections' ? styles.active : ''}`}
          onClick={() => setActiveTab('reflections')}
        >
          <svg className={styles.tabIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          反思
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'prompt' ? styles.active : ''}`}
          onClick={() => setActiveTab('prompt')}
        >
          <svg className={styles.tabIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="3" strokeWidth="2"/>
            <path d="M12 1v6m0 6v6M1 12h6m6 0h6" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Prompt
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'inner' ? styles.active : ''}`}
          onClick={() => setActiveTab('inner')}
        >
          <svg className={styles.tabIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          内心
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'settings' ? styles.active : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          <svg className={styles.tabIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="3" strokeWidth="2"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          设置
        </button>
      </div>

      {/* 标签页内容 */}
      <div className={styles.content}>
        {activeTab === 'overview' && (
          <div className={styles.overviewGrid}>
            <Card
              header={<TitledHeader title="满意度评分" tip={TIP_SATISFACTION_OVERALL} />}
              className={styles.overviewScore}
              bodyClassName={styles.cardBodyFill}
            >
              <div className={styles.satisfactionCompact}>
                <Tooltip content={TIP_SATISFACTION_OVERALL} placement="bottom">
                  <div className={styles.satisfactionScore}>{(status.satisfaction.overall * 100).toFixed(0)}%</div>
                </Tooltip>
                <Tooltip content={TIP_SATISFACTION_TREND} placement="bottom">
                  <div className={`${styles.satisfactionTrend} ${styles[status.satisfaction.trend]}`}>
                    {status.satisfaction.trend === 'improving' && '↑ 提升中'}
                    {status.satisfaction.trend === 'declining' && '↓ 下降'}
                    {status.satisfaction.trend === 'stable' && '→ 稳定'}
                  </div>
                </Tooltip>
              </div>
              <div className={styles.satisfactionBreakdown}>
                {(
                  [
                    ['任务完成', status.satisfaction.breakdown.taskCompletion],
                    ['用户反馈', status.satisfaction.breakdown.userFeedback],
                    ['效率', status.satisfaction.breakdown.efficiency],
                    ['知识增长', status.satisfaction.breakdown.knowledgeGrowth],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className={styles.breakdownItem}>
                    <LabeledMetric
                      label={label}
                      tip={TIP_BREAKDOWN[label]}
                      className={styles.breakdownLabel}
                    />
                    <div className={styles.progressBar} title={TIP_BREAKDOWN[label]}>
                      <div className={styles.progressFill} style={{ width: `${value * 100}%` }} />
                    </div>
                    <span className={styles.breakdownValue}>{(value * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card
              header={<TitledHeader title="满意度趋势 · 7 天" tip={TIP_SATISFACTION_CHART} />}
              className={styles.overviewTrend}
              bodyClassName={styles.cardBodyFill}
            >
              <div className={styles.chartFill}>
                <SatisfactionChart history={satisfactionHistory} window="7d" fillHeight />
              </div>
            </Card>

            <Card
              header={<TitledHeader title={`最近目标 (${goals.length})`} tip={TIP_PENDING_GOALS} />}
              className={styles.overviewGoals}
              bodyClassName={styles.cardBodyFill}
            >
              {goals.length === 0 ? (
                <div className={styles.emptyCompact}>
                  <div className={styles.emptyIcon}>
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <circle cx="12" cy="12" r="10" strokeWidth="2"/>
                      <path d="M12 6v6l4 2" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                  </div>
                  暂无目标
                </div>
              ) : (
                <div className={styles.goalsList}>
                  {goals.map((goal) => (
                    <GoalCard key={goal.id} goal={goal} onApprove={handleApprove} onReject={handleReject} onJump={handleGoalJump} />
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {activeTab === 'capabilities' && (
          Object.keys(capabilities).length > 0 ? (
            <div className={styles.capabilitiesGrid}>
              <Card
                header={<TitledHeader title="能力雷达" tip={TIP_CAPABILITY_RADAR} />}
                className={styles.radarCol}
                bodyClassName={styles.cardBodyFill}
              >
                <CapabilityRadar capabilities={capabilities} size={280} />
              </Card>
              <Card
                header={<TitledHeader title="进化维度" tip={TIP_CAPABILITY_DIMENSIONS} />}
                className={styles.dimensionsCol}
                bodyClassName={styles.cardBodyFill}
              >
                <div className={styles.capabilitiesList}>
                  {Object.entries(capabilities).map(([dimension, state]: [string, any]) => {
                    const expanded = expandedDimension === dimension
                    const tests = capabilityTests.filter((t) => t.dimension === dimension)
                    return (
                      <div key={dimension} className={styles.dimensionItem}>
                        <div
                          className={styles.dimensionHeader}
                          onClick={() => setExpandedDimension(expanded ? null : dimension)}
                        >
                          <CapabilityProgressBar
                            dimension={dimension}
                            level={state.level}
                            confidence={state.confidence}
                            testCount={state.testCount}
                            trend={state.trend || 'stable'}
                          />
                        </div>
                        {expanded && (
                          <div className={styles.capabilityTests}>
                            {tests.length === 0 ? (
                              <div className={styles.capabilityTestsEmpty}>暂无测试记录</div>
                            ) : (
                              tests.map((test) => <CapabilityTestRow key={test.id} test={test} />)
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </Card>
            </div>
          ) : (
            <Card title="能力数据">
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M2 17l10 5 10-5M2 12l10 5 10-5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                暂无能力数据
              </div>
            </Card>
          )
        )}

        {activeTab === 'planned' && (
          <Card
            header={
              <div className={styles.plannedHeader}>
                <TitledHeader title={`规划任务 (${plannedGoals.length})`} tip={TIP_PENDING_GOALS} />
                <Tooltip content="清除今日规划并让 Agent 重新排期未来 24 小时" placement="bottom">
                  <button
                    className={styles.btnSecondary}
                    disabled={replanning}
                    onClick={handleReplan}
                  >
                    {replanning ? '规划中…' : '重置规划'}
                  </button>
                </Tooltip>
              </div>
            }
            bodyClassName={styles.cardBodyFill}
          >
            {plannedGoals.length === 0 ? (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <rect x="3" y="4" width="18" height="18" rx="2" strokeWidth="2"/>
                    <path d="M16 2v4M8 2v4M3 10h18" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                暂无规划任务。启动或心跳会为未来 24 小时主动排期。
              </div>
            ) : (
              <div className={styles.plannedList}>
                {plannedGoals.map((goal) => (
                  <PlannedGoalCard key={goal.id} goal={goal} onDelete={handleDeletePlannedGoal} />
                ))}
              </div>
            )}
          </Card>
        )}

        {activeTab === 'reflections' && (
          reflections.length > 0 ? (
            <div className={styles.reflectionsGrid}>
              <Card
                header={<TitledHeader title="最近反思" tip={TIP_REFLECTION_LIST} />}
                className={styles.reflectionListCol}
                bodyClassName={styles.cardBodyFill}
              >
                <div className={styles.reflectionNav}>
                  {reflections.map((reflection) => (
                    <button
                      key={reflection.id}
                      type="button"
                      className={`${styles.reflectionNavItem} ${selectedReflectionId === reflection.id ? styles.reflectionNavActive : ''}`}
                      onClick={() => setSelectedReflectionId(reflection.id)}
                    >
                      <div className={styles.reflectionNavTitle}>
                        {reflection.diagnosis.primaryIssue || TRIGGER_LABELS[reflection.triggerReason] || '反思记录'}
                      </div>
                      <div className={styles.reflectionNavMeta}>
                        {formatReflectionTime(reflection.createdAt)}
                        {' · '}
                        {TRIGGER_LABELS[reflection.triggerReason] || reflection.triggerReason}
                      </div>
                    </button>
                  ))}
                </div>
              </Card>
              <Card
                header={<TitledHeader title="详情" tip={TIP_REFLECTION.detail} />}
                className={styles.reflectionDetailCol}
                bodyClassName={styles.cardBodyFill}
              >
                {selectedReflection ? (
                  <ReflectionCard reflection={selectedReflection} variant="detail" />
                ) : (
                  <div className={styles.emptyCompact}>请选择一条反思</div>
                )}
              </Card>
            </div>
          ) : (
            <Card title="反思记录">
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeWidth="2"/>
                  </svg>
                </div>
                暂无反思记录
              </div>
            </Card>
          )
        )}

        {activeTab === 'prompt' && (
          <Card
            header={<TitledHeader title="Prompt 变体统计" tip={TIP_PROMPT_STATS} />}
          >
            {promptStats.length > 0 ? (
              <PromptVariantStats stats={promptStats} />
            ) : (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <circle cx="12" cy="12" r="10" strokeWidth="2"/>
                    <path d="M12 16v-4M12 8h.01" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                暂无 Prompt 变体数据（功能开发中）
              </div>
            )}
          </Card>
        )}

        {activeTab === 'settings' && (
          <Card
            header={<TitledHeader title="自主进化参数" tip={TIP_SETTINGS} />}
          >
            {settings ? (
              <div className={styles.settingsForm}>
                <div className={styles.settingRow}>
                  <label className={styles.settingLabel} htmlFor="tickInterval">
                    心跳频率（分钟）
                  </label>
                  <input
                    id="tickInterval"
                    type="number"
                    className={styles.settingInput}
                    min={5}
                    max={60}
                    value={settings.tickIntervalMinutes}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n)) patchSettings({ tickIntervalMinutes: n })
                    }}
                  />
                  <span className={styles.settingHint}>5–60，默认 10</span>
                </div>

                <div className={styles.settingRow}>
                  <label className={styles.settingLabel}>静默时段（起–止小时）</label>
                  <div className={styles.settingPair}>
                    <input
                      type="number"
                      className={styles.settingInput}
                      min={0}
                      max={23}
                      value={settings.quietHours[0]}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        if (Number.isFinite(n)) patchSettings({ quietHours: [n, settings.quietHours[1]] })
                      }}
                    />
                    <span className={styles.settingDash}>–</span>
                    <input
                      type="number"
                      className={styles.settingInput}
                      min={0}
                      max={23}
                      value={settings.quietHours[1]}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        if (Number.isFinite(n)) patchSettings({ quietHours: [settings.quietHours[0], n] })
                      }}
                    />
                  </div>
                  <span className={styles.settingHint}>静默时段内写日记、定时反思</span>
                </div>

                <div className={styles.settingRow}>
                  <label className={styles.settingLabel} htmlFor="maxOutreach">
                    每日主动消息配额
                  </label>
                  <input
                    id="maxOutreach"
                    type="number"
                    className={styles.settingInput}
                    min={0}
                    max={50}
                    value={settings.maxOutreachPerDay}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n)) patchSettings({ maxOutreachPerDay: n })
                    }}
                  />
                  <span className={styles.settingHint}>0–50，默认 20</span>
                </div>

                <div className={styles.settingRow}>
                  <label className={styles.settingLabel} htmlFor="minInterval">
                    主动消息最小间隔（分钟）
                  </label>
                  <input
                    id="minInterval"
                    type="number"
                    className={styles.settingInput}
                    min={0}
                    max={1440}
                    value={settings.minOutreachIntervalMinutes}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n)) patchSettings({ minOutreachIntervalMinutes: n })
                    }}
                  />
                  <span className={styles.settingHint}>0–1440，默认 60</span>
                </div>

                <div className={styles.settingRow}>
                  <label className={styles.settingLabel} htmlFor="maxGoals">
                    每日目标上限
                  </label>
                  <input
                    id="maxGoals"
                    type="number"
                    className={styles.settingInput}
                    min={1}
                    max={20}
                    value={settings.maxGoalsPerDay}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n)) patchSettings({ maxGoalsPerDay: n })
                    }}
                  />
                  <span className={styles.settingHint}>1–20，默认 7</span>
                </div>

                <div className={styles.settingRow}>
                  <label className={styles.settingLabel} htmlFor="maxTokens">
                    每日 Token 上限
                  </label>
                  <input
                    id="maxTokens"
                    type="number"
                    className={styles.settingInput}
                    min={0}
                    max={1000000}
                    step={1000}
                    value={settings.maxTokensPerDay}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n)) patchSettings({ maxTokensPerDay: n })
                    }}
                  />
                  <span className={styles.settingHint}>默认 100000</span>
                </div>

                <div className={styles.settingRow}>
                  <label className={styles.settingLabel} htmlFor="approvalMode">
                    审批模式
                  </label>
                  <select
                    id="approvalMode"
                    className={styles.settingInput}
                    value={settings.approvalMode}
                    onChange={(e) => patchSettings({ approvalMode: e.target.value as AutonomousSettings['approvalMode'] })}
                  >
                    <option value="always">总是审批</option>
                    <option value="risky-only">仅高风险审批</option>
                    <option value="never">从不审批</option>
                  </select>
                  <span className={styles.settingHint}>新目标的审批策略</span>
                </div>

                <div className={styles.settingRow}>
                  <label className={styles.settingLabel} htmlFor="reflectionGoalPriorityThreshold">
                    反思建议进入目标阈值
                  </label>
                  <input
                    id="reflectionGoalPriorityThreshold"
                    type="range"
                    className={styles.settingInput}
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.reflectionGoalPriorityThreshold}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n)) patchSettings({ reflectionGoalPriorityThreshold: n })
                    }}
                  />
                  <span className={styles.settingHint}>
                    {(settings.reflectionGoalPriorityThreshold * 100).toFixed(0)}%
                    — 反思建议目标优先级达到该值才进入最近目标
                  </span>
                </div>

                <div className={styles.settingsActions}>
                  <button
                    className={styles.btnPrimary}
                    disabled={settingsSaving}
                    onClick={handleSaveSettings}
                  >
                    {settingsSaving ? '保存中…' : '保存设置'}
                  </button>
                  {settingsSaved && <span className={styles.settingsSaved}>已保存</span>}
                </div>
              </div>
            ) : (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <circle cx="12" cy="12" r="10" strokeWidth="2"/>
                    <path d="M12 16v-4M12 8h.01" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                无法加载设置
              </div>
            )}
          </Card>
        )}

        {activeTab === 'inner' && (
          <div className={styles.innerGrid}>
            <Card header={<TitledHeader title="现在的心情" tip={TIP_INNER_MOOD} />}>
              {mood ? (
                <div className={styles.moodSummary}>
                  <MoodAvatar mood={mood} size={96} />
                  <div className={styles.moodText}>{describeMood(mood)}</div>
                </div>
              ) : (
                <div className={styles.emptyCompact}>暂无情绪数据</div>
              )}
            </Card>

            <Card
              header={<TitledHeader title="还在惦记" tip={TIP_INNER_CONCERNS} />}
              className={styles.concernsCard}
              bodyClassName={styles.cardBodyFill}
            >
              {concerns.length > 0 ? (
                <div className={styles.concernsList}>
                  {sortConcerns(concerns).map((c) => (
                    <div key={c.id} className={`${styles.concernItem} ${styles[`concern_${c.status}`]}`}>
                      <div className={styles.concernHeader}>
                        <span className={styles.concernDesc}>{c.description}</span>
                        <span className={`${styles.concernStatus} ${styles[`concernStatus_${c.status}`]}`}>
                          {CONCERN_STATUS_LABELS[c.status]}
                        </span>
                      </div>
                      <div className={styles.concernMeta}>
                        {c.origin && <span>来源 {c.origin}</span>}
                        <span>提起 {c.raisedCount} 次</span>
                        {c.status === 'open' && c.nextRaiseAfter > Date.now() && (
                          <span>下次 {formatDiaryTime(c.nextRaiseAfter)} 可提起</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyCompact}>暂时没有放不下的事</div>
              )}
            </Card>

            <Card
              header={<TitledHeader title="日记" tip={TIP_INNER_DIARY} />}
              className={styles.diaryCard}
              bodyClassName={styles.cardBodyFill}
            >
              {diary.length > 0 ? (
                <div className={styles.diaryList}>
                  {diary.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={styles.diaryItem}
                      title={d.text}
                      onClick={() => setSelectedDiary(d)}
                    >
                      <div className={styles.diaryMeta}>{formatDiaryTime(d.timestamp)}</div>
                      <div className={styles.diaryText}>{d.text}</div>
                    </button>
                  ))}
                  {diaryHasMore && (
                    <button
                      type="button"
                      className={styles.diaryLoadMore}
                      disabled={diaryLoadingMore}
                      onClick={loadMoreDiary}
                    >
                      {diaryLoadingMore ? '加载中…' : '加载更早的日记'}
                    </button>
                  )}
                </div>
              ) : (
                <div className={styles.emptyCompact}>还没有日记。夜深时它会写点什么。</div>
              )}
            </Card>
          </div>
        )}
      </div>

      <Modal
        open={selectedDiary !== null}
        title={selectedDiary ? formatDiaryTime(selectedDiary.timestamp) : '日记详情'}
        onClose={() => setSelectedDiary(null)}
        width={560}
        layer={embedded ? 'aboveHub' : undefined}
      >
        {selectedDiary && <div className={styles.diaryDetail}>{selectedDiary.text}</div>}
      </Modal>
    </div>
  )
}

/**
 * 格式化反思列表时间
 */
function formatReflectionTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 日记/独白时间（毫秒时间戳 → 可读） */
function formatDiaryTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 情绪三维 → 简短文字描述（不显示数值，避免表演情绪） */
function describeMood(mood: MoodState): string {
  const parts: string[] = []
  if (mood.energy > 0.7) parts.push('精力充沛')
  else if (mood.energy < 0.3) parts.push('有点累')
  if (mood.valence > 0.3) parts.push('心情不错')
  else if (mood.valence < -0.3) parts.push('有点低落')
  if (mood.arousal > 0.6) parts.push('兴致很高')
  if (parts.length === 0) parts.push('平静')
  return parts.join('，')
}

/** 牵挂状态中文标签 */
const CONCERN_STATUS_LABELS: Record<Concern['status'], string> = {
  open: '还在惦记',
  resolved: '已解决',
  dropped: '已放下',
}

/** 牵挂排序：进行中的在前，已放下/已解决的在后 */
const CONCERN_STATUS_ORDER: Record<Concern['status'], number> = {
  open: 0,
  resolved: 1,
  dropped: 2,
}

function sortConcerns(list: Concern[]): Concern[] {
  return [...list].sort(
    (a, b) => CONCERN_STATUS_ORDER[a.status] - CONCERN_STATUS_ORDER[b.status],
  )
}

/** 能力测试结果中文标签 */
const TEST_RESULT_LABELS: Record<string, string> = {
  success: '成功',
  partial: '部分',
  failure: '失败',
}

/** 格式化能力测试时间（ISO 字符串 → 可读） */
function formatTestTime(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 单条能力测试记录 */
function CapabilityTestRow({ test }: { test: CapabilityTest }) {
  const delta =
    test.levelAfter != null && test.levelBefore != null ? test.levelAfter - test.levelBefore : null
  const resultClass = {
    success: styles.capabilityTestResultSuccess,
    partial: styles.capabilityTestResultPartial,
    failure: styles.capabilityTestResultFailure,
  }[test.result]

  return (
    <div className={styles.capabilityTestRow}>
      <div className={styles.capabilityTestSummary}>{test.taskSummary}</div>
      <div className={styles.capabilityTestMeta}>
        <span className={`${styles.capabilityTestResult} ${resultClass}`}>
          {TEST_RESULT_LABELS[test.result]}
        </span>
        <span>难度 {(test.difficulty * 100).toFixed(0)}%</span>
        {delta != null && (
          <span className={delta >= 0 ? styles.levelUp : styles.levelDown}>
            水平 {delta >= 0 ? '+' : ''}
            {(delta * 100).toFixed(1)}%
          </span>
        )}
        <span>{formatTestTime(test.createdAt)}</span>
      </div>
    </div>
  )
}

/**
 * 目标卡片组件
 */
interface GoalCardProps {
  goal: AutonomousGoal
  onApprove: (goalId: string) => void
  onReject: (goalId: string) => void
  onJump: (goal: AutonomousGoal) => void
}

function GoalCard({ goal, onApprove, onReject, onJump }: GoalCardProps) {
  const typeLabels: Record<string, string> = {
    learning: '学习目标',
    'proactive-message': '主动消息',
    'capability-improvement': '能力提升',
    'skill-enhancement': '技能增强',
    'memory-optimization': '记忆优化',
    'system-maintenance': '系统维护',
  }

  const typeClass = goal.type.replace(/-/g, '')
  const priorityStars = '★'.repeat(Math.ceil(goal.priority * 5))
  const isPending = !goal.status || goal.status === 'pending'
  const jumpable = !isPending && !!goal.reflectionId

  return (
    <div
      className={`${styles.goalCard}${jumpable ? ` ${styles.goalCardClickable}` : ''}`}
      onClick={() => jumpable && onJump(goal)}
    >
      <div className={styles.goalHeader}>
        <span className={`${styles.goalType} ${styles[typeClass]}`}>{typeLabels[goal.type] || goal.type}</span>
        {goal.status && (
          <span className={`${styles.goalStatus} ${styles[`goalStatus_${goal.status}`] || ''}`}>
            {GOAL_STATUS_LABELS[goal.status] || goal.status}
          </span>
        )}
        <Tooltip content={TIP_GOAL.priority} placement="left">
          <span className={styles.goalPriority}>{priorityStars}</span>
        </Tooltip>
      </div>
      <h3 className={styles.goalTitle}>{goal.description}</h3>
      <div className={styles.goalDetails}>
        <p>
          <Tooltip content={TIP_GOAL.triggerReason} placement="top">
            <strong>触发原因:</strong>
          </Tooltip>{' '}
          {goal.triggerReason}
        </p>
        {goal.userValueScore !== undefined && (
          <p>
            <Tooltip content={TIP_GOAL.userValue} placement="top">
              <strong>用户价值:</strong>
            </Tooltip>{' '}
            {(goal.userValueScore * 100).toFixed(0)}%
          </p>
        )}
        {goal.feasibility !== undefined && (
          <p>
            <Tooltip content={TIP_GOAL.feasibility} placement="top">
              <strong>可行性:</strong>
            </Tooltip>{' '}
            {(goal.feasibility * 100).toFixed(0)}%
          </p>
        )}
      </div>
      {isPending ? (
        <div className={styles.goalActions}>
          <button className={styles.btnPrimary} onClick={() => onApprove(goal.id)}>
            批准并执行
          </button>
          <button className={styles.btnSecondary} onClick={() => onReject(goal.id)}>
            拒绝
          </button>
        </div>
      ) : jumpable ? (
        <div className={styles.goalJumpHint}>查看关联反思 →</div>
      ) : null}
    </div>
  )
}

/**
 * 规划任务卡片：紧凑单行（类型 + 描述 + 计划时间 + 删除），不展示审批/状态。
 */
function PlannedGoalCard({ goal, onDelete }: { goal: PlannedGoal; onDelete: (goalId: string) => void }) {
  const typeLabels: Record<string, string> = {
    learning: '学习',
    'proactive-message': '主动消息',
    'capability-improvement': '能力提升',
    'skill-enhancement': '技能增强',
    'memory-optimization': '记忆优化',
    'system-maintenance': '系统维护',
  }
  const typeClass = goal.type.replace(/-/g, '')
  const scheduledLabel = goal.scheduledFor
    ? formatReflectionTime(goal.scheduledFor)
    : '尽快'

  return (
    <div className={styles.plannedGoalRow}>
      <span className={`${styles.goalType} ${styles[typeClass]}`}>{typeLabels[goal.type] || goal.type}</span>
      <span className={styles.plannedGoalDesc}>{goal.description}</span>
      <span className={styles.plannedGoalTime}>{scheduledLabel}</span>
      <button
        type="button"
        className={styles.plannedGoalDelete}
        onClick={() => onDelete(goal.id)}
        title="删除该规划任务"
      >
        删除
      </button>
    </div>
  )
}
