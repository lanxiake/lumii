/**
 * 自主进化仪表板页面
 * - 标题行合并启用开关
 * - 概览：三列卡片（评分 / 趋势 / 待审批）
 * - 能力：左雷达 + 右维度列表
 * - 反思：左列表 + 右详情
 */

import React, { useState, useEffect, useMemo } from 'react'
import { Card } from '../../components/ui/Card/Card'
import { Tooltip } from '../../components/ui/Tooltip/Tooltip'
import { CapabilityRadar } from '../../components/CapabilityRadar/CapabilityRadar'
import { CapabilityProgressBar } from '../../components/CapabilityProgressBar/CapabilityProgressBar'
import { ReflectionCard, type Reflection } from '../../components/ReflectionCard/ReflectionCard'
import { SatisfactionChart, type SatisfactionDataPoint } from '../../components/SatisfactionChart/SatisfactionChart'
import { PromptVariantStats, type PromptFragmentStats } from '../../components/PromptVariantStats/PromptVariantStats'
import { LabeledMetric, MetricTip, TitledHeader } from './MetricTip'
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
  priority: number
  userValueScore?: number
  feasibility?: number
}

const api = window.electronAPI?.autonomous || {
  getStatus: () => Promise.reject(new Error('API not available')),
  getPendingGoals: () => Promise.reject(new Error('API not available')),
  approveGoal: () => Promise.reject(new Error('API not available')),
  rejectGoal: () => Promise.reject(new Error('API not available')),
  getCapabilities: () => Promise.reject(new Error('API not available')),
  getReflections: () => Promise.reject(new Error('API not available')),
  getSatisfactionHistory: () => Promise.reject(new Error('API not available')),
  getPromptStats: () => Promise.reject(new Error('API not available')),
  setEnabled: () => Promise.reject(new Error('API not available')),
}

type TabType = 'overview' | 'capabilities' | 'reflections' | 'prompt'

const TRIGGER_LABELS: Record<string, string> = {
  'low-satisfaction': '满意度低',
  scheduled: '定时反思',
  'user-request': '用户请求',
  'capability-gap': '能力缺口',
}

/**
 * 自主进化仪表板
 */
export function AutonomousPage() {
  const [status, setStatus] = useState<AutonomousStatus | null>(null)
  const [goals, setGoals] = useState<AutonomousGoal[]>([])
  const [capabilities, setCapabilities] = useState<Record<string, any>>({})
  const [reflections, setReflections] = useState<Reflection[]>([])
  const [satisfactionHistory, setSatisfactionHistory] = useState<SatisfactionDataPoint[]>([])
  const [promptStats, setPromptStats] = useState<PromptFragmentStats[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabType>('overview')
  const [autonomousEnabled, setAutonomousEnabled] = useState(true)
  const [selectedReflectionId, setSelectedReflectionId] = useState<string | null>(null)

  useEffect(() => {
    loadData()
    const timer = setInterval(loadData, 30000)
    return () => clearInterval(timer)
  }, [])

  /** 加载自主进化相关数据 */
  async function loadData() {
    try {
      const [statusData, goalsData, capabilitiesData, reflectionsData, historyData, promptData] = await Promise.all([
        api.getStatus(),
        api.getPendingGoals(),
        api.getCapabilities().catch(() => ({})),
        api.getReflections(20).catch(() => []),
        api.getSatisfactionHistory('7d').catch(() => ({ dataPoints: [] })),
        api.getPromptStats().catch(() => []),
      ])
      setStatus(statusData)
      setGoals(goalsData)
      setCapabilities(capabilitiesData)
      setReflections(reflectionsData)
      setSatisfactionHistory(historyData.dataPoints || [])
      setPromptStats(Array.isArray(promptData) ? (promptData as PromptFragmentStats[]) : [])
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
    <div className={styles.page}>
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
              header={<TitledHeader title={`待审批目标 (${goals.length})`} tip={TIP_PENDING_GOALS} />}
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
                  暂无待审批目标
                </div>
              ) : (
                <div className={styles.goalsList}>
                  {goals.map((goal) => (
                    <GoalCard key={goal.id} goal={goal} onApprove={handleApprove} onReject={handleReject} />
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
                  {Object.entries(capabilities).map(([dimension, state]: [string, any]) => (
                    <CapabilityProgressBar
                      key={dimension}
                      dimension={dimension}
                      level={state.level}
                      confidence={state.confidence}
                      testCount={state.testCount}
                      trend={state.trend || 'stable'}
                    />
                  ))}
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
      </div>
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

/**
 * 目标卡片组件
 */
interface GoalCardProps {
  goal: AutonomousGoal
  onApprove: (goalId: string) => void
  onReject: (goalId: string) => void
}

function GoalCard({ goal, onApprove, onReject }: GoalCardProps) {
  const typeLabels: Record<string, string> = {
    learning: '学习目标',
    'proactive-message': '主动消息',
    'capability-improvement': '能力提升',
    'skill-enhancement': '技能增强',
    'memory-optimization': '记忆优化',
  }

  const typeClass = goal.type.replace(/-/g, '')
  const priorityStars = '★'.repeat(Math.ceil(goal.priority * 5))

  return (
    <div className={styles.goalCard}>
      <div className={styles.goalHeader}>
        <span className={`${styles.goalType} ${styles[typeClass]}`}>{typeLabels[goal.type] || goal.type}</span>
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
      <div className={styles.goalActions}>
        <button className={styles.btnPrimary} onClick={() => onApprove(goal.id)}>
          批准并执行
        </button>
        <button className={styles.btnSecondary} onClick={() => onReject(goal.id)}>
          拒绝
        </button>
      </div>
    </div>
  )
}
