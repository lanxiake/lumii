/**
 * 指标帮助提示：悬停显示说明文案
 */

import React from 'react'
import { HelpCircle } from 'lucide-react'
import { Tooltip } from '../../components/ui/Tooltip/Tooltip'
import styles from './AutonomousPage.module.css'

interface MetricTipProps {
  /** 说明文案 */
  content: string
  /** 无障碍标签前缀 */
  label: string
  /** 气泡方向 */
  placement?: 'top' | 'bottom' | 'left' | 'right'
}

/**
 * 渲染带问号图标的指标说明触发器
 */
export function MetricTip({ content, label, placement = 'top' }: MetricTipProps) {
  return (
    <Tooltip content={content} placement={placement} delay={120}>
      <button
        type="button"
        className={styles.helpBtn}
        aria-label={`${label}说明`}
        onClick={(e) => e.preventDefault()}
      >
        <HelpCircle size={14} strokeWidth={2} />
      </button>
    </Tooltip>
  )
}

interface TitledHeaderProps {
  title: string
  tip: string
}

/**
 * 卡片标题行：标题 + 说明图标
 */
export function TitledHeader({ title, tip }: TitledHeaderProps) {
  return (
    <div className={styles.cardTitleRow}>
      <h4 className={styles.cardTitleText}>{title}</h4>
      <MetricTip content={tip} label={title} placement="bottom" />
    </div>
  )
}

interface LabeledMetricProps {
  label: string
  tip: string
  className?: string
  children?: React.ReactNode
}

/**
 * 带悬停说明的指标标签（整段文字可悬停）
 */
export function LabeledMetric({ label, tip, className, children }: LabeledMetricProps) {
  return (
    <Tooltip content={tip} placement="top" delay={120}>
      <span className={className ?? styles.tipLabel} tabIndex={0}>
        {children ?? label}
      </span>
    </Tooltip>
  )
}
