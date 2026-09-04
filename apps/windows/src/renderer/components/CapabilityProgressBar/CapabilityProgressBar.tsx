/**
 * 能力进度条组件
 *
 * 展示单个能力维度的进度，包括：
 * - 能力水平（实心条）
 * - 置信度（虚线边框）
 * - 测试次数
 * - 趋势指示
 */

import React from 'react'
import './CapabilityProgressBar.css'

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
 * 能力进度条属性
 */
interface CapabilityProgressBarProps {
  dimension: string
  level: number
  confidence: number
  testCount: number
  trend?: 'up' | 'down' | 'stable'
}

/**
 * 能力进度条组件
 */
export function CapabilityProgressBar({
  dimension,
  level,
  confidence,
  testCount,
  trend = 'stable',
}: CapabilityProgressBarProps) {
  const label = DIMENSION_LABELS[dimension] || dimension
  const trendIcon = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'
  const trendClass = trend === 'up' ? 'trend-up' : trend === 'down' ? 'trend-down' : 'trend-stable'

  return (
    <div className="capability-progress-bar">
      <div className="progress-header">
        <span className="dimension-label">{label}</span>
        <span className={`level-value ${trendClass}`}>
          {(level * 100).toFixed(0)}% {trendIcon}
        </span>
      </div>

      <div className="progress-container">
        {/* 能力水平（实心条） */}
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{ width: `${level * 100}%` }}
            title={`能力水平: ${(level * 100).toFixed(0)}%`}
          />
        </div>

        {/* 置信度指示器（虚线边框） */}
        <div
          className="confidence-indicator"
          style={{ width: `${confidence * 100}%` }}
          title={`置信度: ${(confidence * 100).toFixed(0)}%`}
        />
      </div>

      <div className="progress-footer">
        <span className="test-count">测试次数: {testCount}</span>
        <span className="confidence-value">置信度: {(confidence * 100).toFixed(0)}%</span>
      </div>
    </div>
  )
}
