import React, { useState, useEffect } from 'react'
import clsx from 'clsx'
import type { ExecApprovalRequest, ExecApprovalDecision } from '../../../../types/exec-approvals'
import styles from './ApprovalCard.module.css'

interface ApprovalCardProps {
  approval: ExecApprovalRequest
  decision?: ExecApprovalDecision
  resolvedBy?: string
  isResolving: boolean
  onDecision: (decision: ExecApprovalDecision) => void
}

const ApprovalCard: React.FC<ApprovalCardProps> = ({
  approval,
  decision,
  resolvedBy,
  isResolving,
  onDecision,
}) => {
  const [countdown, setCountdown] = useState(
    Math.max(0, Math.round((approval.expiresAtMs - Date.now()) / 1000))
  )

  useEffect(() => {
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.round((approval.expiresAtMs - Date.now()) / 1000))
      setCountdown(remaining)
      if (remaining === 0) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [approval.expiresAtMs])

  const isResolved = !!decision
  const isUrgent = countdown <= 10 && countdown > 0

  if (isResolved) {
    return (
      <div className={clsx(styles['approval-result'], styles[`approval-result--${decision}`])}>
        <div className={styles['result-icon']}>
          {decision === 'deny' ? '✕' : '✓'}
        </div>
        <div className={styles['result-text']}>
          {decision === 'allow-once' && '已允许（一次）'}
          {decision === 'allow-always' && '已加入白名单'}
          {decision === 'deny' && '已拒绝'}
          {resolvedBy && <span className={styles['approval-resolved-by']}> · {resolvedBy}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className={styles['approval-card']}>
      {/* Header */}
      <div className={styles['approval-header']}>
        <div className={styles['approval-icon-wrapper']}>
          <span className={styles['approval-icon']}>⚡</span>
        </div>
        <div className={styles['approval-title-group']}>
          <div className={styles['approval-title']}>命令执行审批请求</div>
          <div className={styles['approval-subtitle']}>需要您确认是否执行以下命令</div>
        </div>
      </div>

      {/* Command */}
      <div className={styles['approval-command-section']}>
        <div className={styles['approval-command-header']}>
          <span className={styles['approval-command-label']}>命令</span>
          <button
            className={styles['approval-copy-btn']}
            onClick={() => navigator.clipboard.writeText(approval.request.command)}
          >
            📋 复制
          </button>
        </div>
        <pre className={styles['approval-command-code']}>
          <code>{approval.request.command}</code>
        </pre>
      </div>

      {/* Meta info */}
      <div className={styles['approval-meta-grid']}>
        {approval.request.host && (
          <div className={styles['approval-meta-item']}>
            <span className={styles['approval-meta-icon']}>💻</span>
            <span className={styles['approval-meta-label']}>主机</span>
            <span className={styles['approval-meta-value']}>{approval.request.host}</span>
          </div>
        )}
        {approval.request.cwd && (
          <div className={styles['approval-meta-item']}>
            <span className={styles['approval-meta-icon']}>📂</span>
            <span className={styles['approval-meta-label']}>目录</span>
            <span className={styles['approval-meta-value']}>{approval.request.cwd}</span>
          </div>
        )}
        {approval.request.security && (
          <div className={styles['approval-meta-item']}>
            <span className={styles['approval-meta-icon']}>🔒</span>
            <span className={styles['approval-meta-label']}>安全级别</span>
            <span className={styles['approval-meta-value']}>{approval.request.security}</span>
          </div>
        )}
      </div>

      {/* Countdown */}
      <div className={clsx(styles['approval-countdown'], isUrgent && styles.urgent)}>
        <span className={styles['approval-countdown-icon']}>⏱️</span>
        <span className={styles['approval-countdown-text']}>
          {countdown > 0 ? `${countdown}秒后过期` : '已过期'}
        </span>
      </div>

      {/* Actions */}
      <div className={styles['approval-actions']}>
        <button
          className={clsx(styles['approval-btn'], styles['approval-btn--primary'])}
          onClick={() => onDecision('allow-once')}
          disabled={isResolving}
        >
          {isResolving ? '⏳' : '✓'} 允许一次
        </button>
        <button
          className={clsx(styles['approval-btn'], styles['approval-btn--secondary'])}
          onClick={() => onDecision('deny')}
          disabled={isResolving}
        >
          ✕ 拒绝
        </button>
        <button
          className={clsx(styles['approval-btn'], styles['approval-btn--tertiary'])}
          onClick={() => onDecision('allow-always')}
          disabled={isResolving}
          title="加入白名单，以后不再询问"
        >
          白名单
        </button>
      </div>
    </div>
  )
}

export default ApprovalCard
export { ApprovalCard }
