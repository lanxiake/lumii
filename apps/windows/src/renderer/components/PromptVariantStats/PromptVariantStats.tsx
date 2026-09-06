/**
 * Prompt 变体统计组件
 *
 * 展示 Prompt 进化的 A/B 测试统计数据。
 * 每个变体是一张自包含卡片：名称 + 满意度 + 指标 + 实际文案，
 * 替代「表格 + 文本区」分离布局，让对应关系一目了然。
 */

import React from 'react'
import { Tooltip } from '../ui/Tooltip/Tooltip'
import { TIP_PROMPT_FIELD } from '../../pages/AutonomousPage/autonomousTooltips'
import './PromptVariantStats.css'

/**
 * Prompt 变体数据
 */
export interface PromptVariant {
  id: string
  variantText: string
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
  'expression-style': '表达风格',
}

/**
 * Prompt 变体统计组件
 */
export function PromptVariantStats({ stats }: PromptVariantStatsProps) {
  // 首个片段默认展开（单片段时即为默认展开），后续可由用户手动切换
  const [expandedFragment, setExpandedFragment] = React.useState<string | null>(
    () => stats[0]?.fragmentKey ?? null,
  )

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
  const nonBaselineVariants = sortedVariants.filter((v) => !v.isBaseline)

  return (
    <div className="fragment-card">
      <div className="fragment-header" onClick={onToggle}>
        <div className="header-left">
          <h3 className="fragment-title">{label}</h3>
          <span className="variant-count">{fragment.variants.length} 个风格</span>
        </div>
        <div className="header-right">
          {bestVariant && (
            <span className="best-score">最佳 {(bestVariant.avgSatisfaction * 100).toFixed(0)}%</span>
          )}
          <span className="expand-icon">{expanded ? '▼' : '▶'}</span>
        </div>
      </div>

      {expanded && (
        <div className="fragment-body">
          {sortedVariants.map((variant) => (
            <VariantCard
              key={variant.id}
              variant={variant}
              rank={variant.isBaseline ? 0 : nonBaselineVariants.indexOf(variant) + 1}
              isBest={variant === bestVariant}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 单张变体卡片：名称 + 满意度 + 指标 + 实际文案
 */
function VariantCard({
  variant,
  rank,
  isBest,
}: {
  variant: PromptVariant
  rank: number
  isBest: boolean
}) {
  const successRate =
    variant.trialCount > 0 ? ((variant.successCount / variant.trialCount) * 100).toFixed(0) : '0'
  const name = variant.isBaseline ? '默认风格' : `变体 ${rank}`

  return (
    <div
      className={`variant-card${variant.isBaseline ? ' baseline' : ''}${isBest ? ' best' : ''}`}
    >
      <div className="variant-card-head">
        <div className="variant-title">
          <span className="variant-name">{name}</span>
          {variant.isBaseline && <span className="baseline-badge">基线</span>}
          {isBest && <span className="best-badge">当前最佳</span>}
        </div>
        <Tooltip content={TIP_PROMPT_FIELD.avgSatisfaction} placement="top">
          <span className={`variant-satisfaction ${getSatisfactionClass(variant.avgSatisfaction)}`}>
            {(variant.avgSatisfaction * 100).toFixed(0)}%
          </span>
        </Tooltip>
      </div>

      <div className="variant-stats">
        <Tooltip content={TIP_PROMPT_FIELD.trialCount} placement="top">
          <span className="stat-item">使用 {variant.trialCount} 次</span>
        </Tooltip>
        <Tooltip content={TIP_PROMPT_FIELD.successRate} placement="top">
          <span className="stat-item">成功率 {successRate}%</span>
        </Tooltip>
        <Tooltip content={TIP_PROMPT_FIELD.ucbScore} placement="top">
          <span className="stat-item">UCB {variant.ucbScore.toFixed(2)}</span>
        </Tooltip>
      </div>

      <div className="variant-text">
        {variant.variantText || '默认行为（不附加额外风格提示）'}
      </div>
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
