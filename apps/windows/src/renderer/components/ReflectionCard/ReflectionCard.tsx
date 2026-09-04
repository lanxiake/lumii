/**
 * 反思卡片组件
 *
 * 展示 Agent 的自我反思记录，包括：
 * - 触发原因
 * - 问题诊断
 * - 改进建议
 * - 生成的目标
 */

import React from 'react'
import './ReflectionCard.css'

/**
 * 反思记录
 */
export interface Reflection {
  id: string
  triggerReason: string
  diagnosis: {
    primaryIssue: string
    affectedDimensions: string[]
    rootCause: string
  }
  recommendations: Array<{
    type: string
    description: string
    targetDimensions: string[]
    feasibility: number
    impact: number
  }>
  suggestedGoals: Array<{
    type: string
    description: string
    priority: number
  }>
  createdAt: string
}

/**
 * 反思卡片属性
 */
interface ReflectionCardProps {
  reflection: Reflection
}

/**
 * 能力维度中文标签
 */
const DIMENSION_LABELS: Record<string, string> = {
  code_generation: '代码生成',
  document_analysis: '文档分析',
  web_search: '网络搜索',
  data_processing: '数据处理',
  api_integration: 'API集成',
  creative_writing: '创意写作',
  logical_reasoning: '逻辑推理',
  multi_step_planning: '多步规划',
}

/**
 * 目标类型中文标签
 */
const GOAL_TYPE_LABELS: Record<string, string> = {
  learning: '学习目标',
  'proactive-message': '主动消息',
  'capability-improvement': '能力提升',
  'skill-enhancement': '技能增强',
  'memory-optimization': '记忆优化',
}

/**
 * 反思卡片组件
 */
export function ReflectionCard({ reflection }: ReflectionCardProps) {
  const [expanded, setExpanded] = React.useState(false)

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="reflection-card">
      {/* 卡片头部 */}
      <div className="reflection-header">
        <div className="header-left">
          <span className="reflection-icon">💭</span>
          <div className="header-info">
            <h3 className="reflection-title">反思记录</h3>
            <span className="reflection-date">{formatDate(reflection.createdAt)}</span>
          </div>
        </div>
        <button className="expand-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : '展开详情'}
        </button>
      </div>

      {/* 卡片主体 */}
      <div className="reflection-body">
        {/* 触发原因 */}
        <div className="reflection-section">
          <span className="section-label">触发原因:</span>
          <span className="section-value">{getTriggerReasonLabel(reflection.triggerReason)}</span>
        </div>

        {/* 问题诊断 */}
        <div className="reflection-section diagnosis">
          <h4 className="section-title">🔍 问题诊断</h4>
          <p className="primary-issue">{reflection.diagnosis.primaryIssue}</p>
          {reflection.diagnosis.affectedDimensions.length > 0 && (
            <div className="affected-dimensions">
              <span className="label">影响维度:</span>
              {reflection.diagnosis.affectedDimensions.map((dim) => (
                <span key={dim} className="dimension-tag">
                  {DIMENSION_LABELS[dim] || dim}
                </span>
              ))}
            </div>
          )}
          {expanded && reflection.diagnosis.rootCause && (
            <div className="root-cause">
              <span className="label">根本原因:</span>
              <p>{reflection.diagnosis.rootCause}</p>
            </div>
          )}
        </div>

        {/* 改进建议 */}
        <div className="reflection-section recommendations">
          <h4 className="section-title">
            💡 改进建议 ({reflection.recommendations.length})
          </h4>
          <div className="recommendations-list">
            {reflection.recommendations.slice(0, expanded ? undefined : 3).map((rec, index) => (
              <div key={index} className="recommendation-item">
                <div className="rec-header">
                  <span className="rec-number">{index + 1}</span>
                  <p className="rec-description">{rec.description}</p>
                </div>
                {expanded && (
                  <div className="rec-footer">
                    <div className="rec-metrics">
                      <span className="metric">
                        <span className="metric-label">可行性:</span>
                        <span className="metric-value">{(rec.feasibility * 100).toFixed(0)}%</span>
                      </span>
                      <span className="metric">
                        <span className="metric-label">预期影响:</span>
                        <span className="metric-value">{(rec.impact * 100).toFixed(0)}%</span>
                      </span>
                    </div>
                    {rec.targetDimensions.length > 0 && (
                      <div className="rec-dimensions">
                        {rec.targetDimensions.map((dim) => (
                          <span key={dim} className="dimension-tag small">
                            {DIMENSION_LABELS[dim] || dim}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {!expanded && reflection.recommendations.length > 3 && (
            <button className="show-more-btn" onClick={() => setExpanded(true)}>
              还有 {reflection.recommendations.length - 3} 条建议...
            </button>
          )}
        </div>

        {/* 建议目标 */}
        {reflection.suggestedGoals.length > 0 && (
          <div className="reflection-section suggested-goals">
            <h4 className="section-title">
              🎯 建议目标 ({reflection.suggestedGoals.length})
            </h4>
            <ul className="goals-list">
              {reflection.suggestedGoals.map((goal, index) => (
                <li key={index} className="goal-item">
                  <span className="goal-type">[{GOAL_TYPE_LABELS[goal.type] || goal.type}]</span>
                  <span className="goal-description">{goal.description}</span>
                  <span className="goal-priority">
                    {'⭐'.repeat(Math.ceil(goal.priority * 5))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 获取触发原因标签
 */
function getTriggerReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    'low-satisfaction': '满意度低',
    scheduled: '定时反思',
    'user-request': '用户请求',
    'capability-gap': '能力缺口',
  }
  return labels[reason] || reason
}
