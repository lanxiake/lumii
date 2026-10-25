/**
 * ask_user_question 时间线卡片：待答时内联表单，答完后展示摘要。
 */

import React, { useMemo } from 'react'
import { AskUserModal } from '../../../../components/AskUserModal'
import {
  useAnyPendingAskUser,
  useAgentRuntimeActions,
} from '../../../../hooks/business/useAgentRuntime'
import type { TimelineCardContext } from '../TimelineCards/registry'
import styles from './AskUserCard.module.css'

/** 从工具结果里抽出简短摘要文案 */
function summarizeAskResult(result: unknown): string | null {
  try {
    let text: string | undefined
    if (typeof result === 'string') {
      text = result
    } else if (result && typeof result === 'object') {
      const content = (result as { content?: unknown }).content
      if (Array.isArray(content)) {
        const first = content[0] as { text?: unknown } | undefined
        if (typeof first?.text === 'string') text = first.text
      }
    }
    if (!text?.trim()) return null
    const line = text.trim().split('\n').find((l) => l.trim())
    return line?.slice(0, 200) ?? null
  } catch {
    return null
  }
}

/**
 * 匹配 ask_user_question 工具 part；pending 时渲染可点选表单。
 */
export const AskUserCard: React.FC<TimelineCardContext> = ({ part }) => {
  const { pending } = useAnyPendingAskUser()
  const { respondAskUser } = useAgentRuntimeActions()
  const isPending = pending?.requestId === part.id
  const summary = useMemo(() => summarizeAskResult(part.result), [part.result])

  if (isPending && pending) {
    return (
      <AskUserModal
        open
        variant="inline"
        context={pending.context}
        questions={pending.questions}
        timeoutMs={pending.timeoutMs}
        onSubmit={(payload) => void respondAskUser(payload)}
        onDecline={() => void respondAskUser({ answers: {}, declined: true })}
      />
    )
  }

  return (
    <div className={styles.summary} data-testid="ask-user-card-summary">
      <div className={styles.summaryTitle}>用户问答</div>
      <div className={styles.summaryBody}>
        {part.status === 'running'
          ? '等待用户回答…'
          : summary ?? (part.isError ? '提问未完成' : '已收到回答')}
      </div>
    </div>
  )
}
