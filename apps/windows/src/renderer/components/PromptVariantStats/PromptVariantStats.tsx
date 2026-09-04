/**
 * Prompt 变体统计组件
 *
 * 展示 Prompt 进化的 A/B 测试统计数据。
 */

import React from 'react'
import './PromptVariantStats.css'

/**
 * Prompt 变体数据
 */
export interface PromptVariant {
  id: string
  isBaseline: boolean
  trialCount: number
  successCount: number
  avgSatisfaction: number
  ucbScore: number
}

/**
 * Prompt 片段统计
 */
export interface PromptFragmentStats {
  fragmentKey: string
  variants: PromptVariant[]
}

/**
 * Prompt 变体统计属性
 */
interface PromptVariantStatsProps {
  stats: PromptFragmentStats[]
}

/**
 * 片段键中文标签
 */
const FRAGMENT_LABELS: Record<string, string> = {
  greeting: '问候语',
  task_instruction: '任务指令',
  output_format: '输出格式',
  constraints: '约束条件',
  examples: '示例',
  system_prompt: '系统提示',
}

/**
 * Prompt 变体统计组件
 */
export function PromptVariantStats({ stats }: PromptVariantStatsProps) {
  const [expandedFragment, setExpandedFragment] = React.useState<string | null>(null)

  const handleToggle = (fragmentKey: string) => {
    setExpandedFragment(expandedFragment === fragmentKey ? null : fragmentKey)
  }

  if (stats.length === 0) {
    return (
      <div className="prompt-variant-stats empty">
        <p>暂无 Prompt 进化数据</p>
      </div>
    )
  }

  return (
    <div className="prompt-variant-stats">
      {stats.map((fragment) => (
        <PromptFragmentCard
          key={fragment.fragmentKey}
          fragment={fragment}
          expanded={expandedFragment === fragment.fragmentKey}
          onToggle={() => handleToggle(fragment.fragmentKey)}
        />
      ))}
    </div>
  )
}

/**
 * Prompt 片段卡片
 */
interface PromptFragmentCardProps {
  fragment: PromptFragmentStats
  expanded: boolean
  onToggle: () => void
}

function PromptFragmentCard({ fragment, expanded, onToggle }: PromptFragmentCardProps) {
  const label = FRAGMENT_LABELS[fragment.fragmentKey] || fragment.fragmentKey
  const sortedVariants = [...fragment.variants].sort((a, b) => b.avgSatisfaction - a.avgSatisfaction)
  const bestVariant = sortedVariants[0]

  return (
    <div className="fragment-card">
      <div className="fragment-header" onClick={onToggle}>
        <div className="header-left">
          <h3 className="fragment-title">{label}</h3>
          <span className="variant-count">{fragment.variants.length} 个变体</span>
        </div>
        <div className="header-right">
          {bestVariant && (
            <span className="best-score">最佳: {(bestVariant.avgSatisfaction * 100).toFixed(0)}%</span>
          )}
          <span className="expand-icon">{expanded ? '▼' : '▶'}</span>
        </div>
      </div>

      {expanded && (
        <div className="fragment-body">
          <table className="variants-table">
            <thead>
              <tr>
                <th>变体 ID</th>
                <th>使用次数</th>
                <th>成功率</th>
                <th>平均满意度</th>
                <th>UCB 分数</th>
              </tr>
            </thead>
            <tbody>
              {sortedVariants.map((variant) => (
                <tr key={variant.id} className={variant.isBaseline ? 'baseline' : ''}>
                  <td>
                    <span className="variant-id">
                      {variant.id}
                      {variant.isBaseline && <span className="baseline-badge">基线</span>}
                    </span>
                  </td>
                  <td>{variant.trialCount}</td>
                  <td>
                    <div className="success-rate">
                      <span className="rate-value">
                        {variant.trialCount > 0
                          ? ((variant.successCount / variant.trialCount) * 100).toFixed(0)
                          : 0}
                        %
                      </span>
                      <div className="rate-bar">
                        <div
                          className="rate-fill"
                          style={{
                            width: `${variant.trialCount > 0 ? (variant.successCount / variant.trialCount) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`satisfaction-value ${getSatisfactionClass(variant.avgSatisfaction)}`}>
                      {(variant.avgSatisfaction * 100).toFixed(0)}%
                      {variant === bestVariant && <span className="best-marker">⭐</span>}
                    </span>
                  </td>
                  <td>
                    <span className="ucb-score">{variant.ucbScore.toFixed(3)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * 获取满意度样式类
 */
function getSatisfactionClass(score: number): string {
  if (score >= 0.8) return 'high'
  if (score >= 0.6) return 'medium'
  return 'low'
}
