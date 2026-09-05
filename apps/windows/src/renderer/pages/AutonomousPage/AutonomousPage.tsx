/**
 * 自主进化仪表板页面 - 符合系统规范
 * - 使用 Module CSS + CSS Variables 支持主题切换
 * - 固定高度布局，无整页滚动
 * - 使用 SVG 图标代替 emoji
 * - 提供开关控制自主进化功能
 */

import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/Card/Card'
import { CapabilityRadar } from '../../components/CapabilityRadar/CapabilityRadar'
import { CapabilityProgressBar } from '../../components/CapabilityProgressBar/CapabilityProgressBar'
import { ReflectionCard, type Reflection } from '../../components/ReflectionCard/ReflectionCard'
import { SatisfactionChart, type SatisfactionDataPoint } from '../../components/SatisfactionChart/SatisfactionChart'
import { PromptVariantStats, type PromptFragmentStats } from '../../components/PromptVariantStats/PromptVariantStats'
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

  useEffect(() => {
    loadData()
    const timer = setInterval(loadData, 30000)
    return () => clearInterval(timer)
  }, [])

  async function loadData() {
    try {
      const [statusData, goalsData, capabilitiesData, reflectionsData, historyData, promptData] = await Promise.all([
        api.getStatus(),
        api.getPendingGoals(),
        api.getCapabilities().catch(() => ({})),
        api.getReflections(5).catch(() => []),
        api.getSatisfactionHistory('7d').catch(() => ({ dataPoints: [] })),
        api.getPromptStats().catch(() => []),
      ])
      setStatus(statusData)
      setGoals(goalsData)
      setCapabilities(capabilitiesData)
      setReflections(reflectionsData)
      setSatisfactionHistory(historyData.dataPoints || [])
      setPromptStats(Array.isArray(promptData) ? (promptData as PromptFragmentStats[]) : [])
      // 从后端读取真实状态，默认为 true
      setAutonomousEnabled(statusData.enabled !== false)
    } catch (error) {
      console.error('[AutonomousPage] 加载数据失败:', error)
    } finally {
      setLoading(false)
    }
  }

  async function handleApprove(goalId: string) {
    try {
      await api.approveGoal(goalId)
      await loadData()
    } catch (error) {
      console.error('[AutonomousPage] 批准目标失败:', error)
    }
  }

  async function handleReject(goalId: string) {
    try {
      await api.rejectGoal(goalId)
      await loadData()
    } catch (error) {
      console.error('[AutonomousPage] 拒绝目标失败:', error)
    }
  }

  function handleToggleAutonomous(enabled: boolean) {
    setAutonomousEnabled(enabled)
    // 调用后端 API 更新设置
    api.setEnabled(enabled).then(() => {
      console.log('[AutonomousPage] 自主进化开关已更新:', enabled)
    }).catch((error) => {
      console.error('[AutonomousPage] 更新自主进化开关失败:', error)
      // 回滚到之前的状态
      setAutonomousEnabled(!enabled)
    })
  }

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
      {/* 页头 */}
      <div className={styles.header}>
        <h1 className={styles.title}>自主进化</h1>
      </div>

      {/* 设置行 - 自主进化开关 */}
      <div className={styles.settingsRow}>
        <div className={styles.settingsLabel}>
          <div className={styles.settingsTitle}>启用自主进化</div>
          <div className={styles.settingsDesc}>允许 Agent 自主学习、优化能力并提出改进建议</div>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={autonomousEnabled}
            onChange={(e) => handleToggleAutonomous(e.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
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
          <>
            <Card title="满意度评分">
              <div className={styles.satisfactionOverview}>
                <div className={styles.satisfactionScore}>{(status.satisfaction.overall * 100).toFixed(0)}%</div>
                <div className={`${styles.satisfactionTrend} ${styles[status.satisfaction.trend]}`}>
                  {status.satisfaction.trend === 'improving' && '↑ 提升中'}
                  {status.satisfaction.trend === 'declining' && '↓ 下降'}
                  {status.satisfaction.trend === 'stable' && '→ 稳定'}
                </div>
              </div>
              <div className={styles.satisfactionBreakdown}>
                {Object.entries({
                  任务完成: status.satisfaction.breakdown.taskCompletion,
                  用户反馈: status.satisfaction.breakdown.userFeedback,
                  效率: status.satisfaction.breakdown.efficiency,
                  知识增长: status.satisfaction.breakdown.knowledgeGrowth,
                }).map(([label, value]) => (
                  <div key={label} className={styles.breakdownItem}>
                    <span className={styles.breakdownLabel}>{label}</span>
                    <div className={styles.progressBar}>
                      <div className={styles.progressFill} style={{ width: `${value * 100}%` }} />
                    </div>
                    <span className={styles.breakdownValue}>{(value * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </Card>

            {satisfactionHistory.length > 0 && (
              <Card title="满意度趋势">
                <SatisfactionChart history={satisfactionHistory} window="7d" />
              </Card>
            )}

            <Card title={`待审批目标 (${goals.length})`}>
              {goals.length === 0 ? (
                <div className={styles.empty}>
                  <div className={styles.emptyIcon}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor">
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
          </>
        )}

        {activeTab === 'capabilities' && (
          <>
            {Object.keys(capabilities).length > 0 ? (
              <>
                <Card title="能力雷达图">
                  <CapabilityRadar capabilities={capabilities} />
                </Card>
                <Card title="能力详细进度">
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
              </>
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
            )}
          </>
        )}

        {activeTab === 'reflections' && (
          <>
            {reflections.length > 0 ? (
              <div className={styles.reflectionsList}>
                {reflections.map((reflection) => (
                  <ReflectionCard key={reflection.id} reflection={reflection} />
                ))}
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
            )}
          </>
        )}

        {activeTab === 'prompt' && (
          <Card title="Prompt 变体统计">
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
        <span className={styles.goalPriority}>{priorityStars}</span>
      </div>
      <h3 className={styles.goalTitle}>{goal.description}</h3>
      <div className={styles.goalDetails}>
        <p>
          <strong>触发原因:</strong> {goal.triggerReason}
        </p>
        {goal.userValueScore !== undefined && (
          <p>
            <strong>用户价值:</strong> {(goal.userValueScore * 100).toFixed(0)}%
          </p>
        )}
        {goal.feasibility !== undefined && (
          <p>
            <strong>可行性:</strong> {(goal.feasibility * 100).toFixed(0)}%
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
