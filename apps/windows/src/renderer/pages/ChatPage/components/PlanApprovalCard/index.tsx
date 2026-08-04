import React, { useState } from 'react'
import clsx from 'clsx'
import type { PlanApprovalRequest } from '../../../../types/plan-approval'
import styles from './PlanApprovalCard.module.css'

interface PlanApprovalCardProps {
  request: PlanApprovalRequest
  decision?: 'approved' | 'rejected'
  feedback?: string
  isResolving: boolean
  onApprove: () => void
  onReject: (feedback?: string) => void
}

const PlanApprovalCard: React.FC<PlanApprovalCardProps> = ({
  request,
  decision,
  isResolving,
  onApprove,
  onReject,
}) => {
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')

  if (decision) {
    return (
      <div className={clsx(styles['plan-result'], styles[`plan-result--${decision}`])}>
        <div className={styles['result-icon']}>
          {decision === 'approved' ? '✓' : '✕'}
        </div>
        <div className={styles['result-text']}>
          {decision === 'approved' ? '执行计划已批准' : '执行计划已拒绝'}
        </div>
      </div>
    )
  }

  return (
    <div className={styles['plan-card']}>
      {/* Header */}
      <div className={styles['plan-header']}>
        <div className={styles['plan-icon-wrapper']}>
          <span className={styles['plan-icon']}>📋</span>
        </div>
        <div className={styles['plan-title-group']}>
          <div className={styles['plan-title']}>执行计划审批</div>
          <div className={styles['plan-subtitle']}>AI助手请求您确认以下执行计划</div>
        </div>
      </div>

      {/* Summary */}
      <div className={styles['plan-summary']}>
        {request.plan.summary}
      </div>

      {/* Steps */}
      <div className={styles['plan-steps']}>
        <div className={styles['plan-steps-label']}>执行步骤</div>
        {request.plan.steps.map((step) => (
          <div key={step.order} className={styles['plan-step']}>
            <div className={styles['plan-step-number']}>{step.order}</div>
            <div className={styles['plan-step-content']}>
              <div className={styles['plan-step-agent']}>{step.agentName}</div>
              <div className={styles['plan-step-desc']}>{step.description}</div>
              {step.parallel && (
                <span className={styles['plan-step-parallel']}>可并行</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Feedback input (when rejecting) */}
      {showFeedback && (
        <div className={styles['plan-feedback']}>
          <textarea
            className={styles['plan-feedback-input']}
            placeholder="请描述您的修改意见（可选，最多500字）..."
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value.slice(0, 500))}
            maxLength={500}
            rows={3}
            autoFocus
          />
          <div className={styles['plan-feedback-actions']}>
            <button
              className={clsx(styles['plan-btn'], styles['plan-btn--danger'])}
              onClick={() => onReject(feedbackText || undefined)}
              disabled={isResolving}
            >
              确认拒绝
            </button>
            <button
              className={clsx(styles['plan-btn'], styles['plan-btn--ghost'])}
              onClick={() => setShowFeedback(false)}
              disabled={isResolving}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      {!showFeedback && (
        <div className={styles['plan-actions']}>
          <button
            className={clsx(styles['plan-btn'], styles['plan-btn--primary'])}
            onClick={onApprove}
            disabled={isResolving}
          >
            {isResolving ? '⏳' : '✓'} 批准执行
          </button>
          <button
            className={clsx(styles['plan-btn'], styles['plan-btn--secondary'])}
            onClick={() => setShowFeedback(true)}
            disabled={isResolving}
          >
            ✕ 拒绝
          </button>
        </div>
      )}
    </div>
  )
}

export default PlanApprovalCard
export { PlanApprovalCard }
