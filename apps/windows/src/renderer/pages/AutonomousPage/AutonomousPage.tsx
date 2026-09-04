/**
 * 自主进化仪表板页面
 *
 * 展示 Agent 的自主进化状态，包括：
 * - 满意度评分
 * - 待审批目标
 * - 能力追踪（P1）
 * - 反思记录（P1）
 * - 满意度趋势图（P2）
 * - Prompt 变体统计（P2）
 */

import React, { useState, useEffect } from 'react'
import { autonomousApi, type AutonomousGoal, type AutonomousStatus } from '../../preload/api/autonomous-api'
import { CapabilityRadar } from '../../components/CapabilityRadar/CapabilityRadar'
import { CapabilityProgressBar } from '../../components/CapabilityProgressBar/CapabilityProgressBar'
import { ReflectionCard, type Reflection } from '../../components/ReflectionCard/ReflectionCard'
import { SatisfactionChart, type SatisfactionDataPoint } from '../../components/SatisfactionChart/SatisfactionChart'
import { PromptVariantStats, type PromptFragmentStats } from '../../components/PromptVariantStats/PromptVariantStats'
import './AutonomousPage.css'

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
  const [activeTab, setActiveTab] = useState<'overview' | 'capabilities' | 'reflections' | 'prompt'>('overview')

  // 加载数据
  useEffect(() => {
    loadData()
    // 每 30 秒刷新一次
    const timer = setInterval(loadData, 30000)
    return () => clearInterval(timer)
  }, [])

  async function loadData() {
    try {
      const [statusData, goalsData, capabilitiesData, reflectionsData, historyData] = await Promise.all([
        autonomousApi.getStatus(),
        autonomousApi.getPendingGoals(),
        autonomousApi.getCapabilities().catch(() => ({})),
        autonomousApi.getReflections(5).catch(() => []),
        autonomousApi.getSatisfactionHistory('7d').catch(() => ({ dataPoints: [] })),
      ])
      setStatus(statusData)
      setGoals(goalsData)
      setCapabilities(capabilitiesData)
      setReflections(reflectionsData)
      setSatisfactionHistory(historyData.dataPoints || [])
    } catch (error) {
      console.error('加载自主进化数据失败:', error)
    } finally {
      setLoading(false)
    }
  }

  async function handleApprove(goalId: string) {
    try {
      await autonomousApi.approveGoal(goalId)
      await loadData()
    } catch (error) {
      console.error('批准目标失败:', error)
    }
  }

  async function handleReject(goalId: string) {
    try {
      await autonomousApi.rejectGoal(goalId)
      await loadData()
    } catch (error) {
      console.error('拒绝目标失败:', error)
    }
  }

  if (loading) {
    return (
      <div className="autonomous-page loading">
        <div className="spinner">加载中...</div>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="autonomous-page error">
        <p>无法加载自主进化数据</p>
      </div>
    )
  }

  return (
    <div className="autonomous-page">
      {/* 页面标题 */}
      <div className="page-header">
        <h1>🧠 自主进化仪表板</h1>
        <span className={`status-badge ${status.enabled ? 'enabled' : 'disabled'}`}>
          {status.enabled ? '✓ 已启用' : '✗ 未启用'}
        </span>
      </div>

      {/* 满意度概览 */}
      <section className="section satisfaction-section">
        <h2>📊 满意度评分</h2>
        <div className="satisfaction-card">
          <div className="satisfaction-overall">
            <div className="satisfaction-score">{(status.satisfaction.overall * 100).toFixed(0)}%</div>
            <div className={`satisfaction-trend ${status.satisfaction.trend}`}>
              {status.satisfaction.trend === 'improving' && '↑ 提升中'}
              {status.satisfaction.trend === 'declining' && '↓ 下降'}
              {status.satisfaction.trend === 'stable' && '→ 稳定'}
            </div>
          </div>
          <div className="satisfaction-breakdown">
            <div className="breakdown-item">
              <span className="label">任务完成</span>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${status.satisfaction.breakdown.taskCompletion * 100}%` }}
                />
              </div>
              <span className="value">{(status.satisfaction.breakdown.taskCompletion * 100).toFixed(0)}%</span>
            </div>
            <div className="breakdown-item">
              <span className="label">用户反馈</span>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${status.satisfaction.breakdown.userFeedback * 100}%` }}
                />
              </div>
              <span className="value">{(status.satisfaction.breakdown.userFeedback * 100).toFixed(0)}%</span>
            </div>
            <div className="breakdown-item">
              <span className="label">效率</span>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${status.satisfaction.breakdown.efficiency * 100}%` }}
                />
              </div>
              <span className="value">{(status.satisfaction.breakdown.efficiency * 100).toFixed(0)}%</span>
            </div>
            <div className="breakdown-item">
              <span className="label">知识增长</span>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${status.satisfaction.breakdown.knowledgeGrowth * 100}%` }}
                />
              </div>
              <span className="value">{(status.satisfaction.breakdown.knowledgeGrowth * 100).toFixed(0)}%</span>
            </div>
          </div>
        </div>
      </section>

      {/* 待审批目标 */}
      <section className="section goals-section">
        <h2>🎯 待审批目标 ({goals.length})</h2>
        {goals.length === 0 ? (
          <p className="empty-state">暂无待审批目标</p>
        ) : (
          <div className="goals-list">
            {goals.map((goal) => (
              <GoalCard key={goal.id} goal={goal} onApprove={handleApprove} onReject={handleReject} />
            ))}
          </div>
        )}
      </section>
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

  const priorityStars = '⭐'.repeat(Math.ceil(goal.priority * 5))

  return (
    <div className="goal-card">
      <div className="goal-header">
        <span className={`goal-type-badge ${goal.type}`}>{typeLabels[goal.type] || goal.type}</span>
        <span className="goal-priority">{priorityStars}</span>
      </div>
      <h3 className="goal-title">{goal.description}</h3>
      <div className="goal-details">
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
      <div className="goal-actions">
        <button className="btn btn-primary" onClick={() => onApprove(goal.id)}>
          批准并执行
        </button>
        <button className="btn btn-secondary" onClick={() => onReject(goal.id)}>
          拒绝
        </button>
      </div>
    </div>
  )
}
