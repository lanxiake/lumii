/**
 * ask_user_question 时间线卡片：待答时内联表单，答完后展示摘要。
 *
 * 可点选表单优先对齐 `pendingAskUser.requestId === part.id`；
 * 若 IPC pending 丢失 / 被其它会话脏数据抢占，则回退到 `part.args`，
 * 避免只显示「等待用户回答…」却无法选择。
 */

import React, { useMemo } from 'react'
import { AskUserModal, type AskUserModalQuestion } from '../../../../components/AskUserModal'
import {
  useAgentRuntimeActions,
  useAgentRuntimeGlobalState,
} from '../../../../hooks/business/useAgentRuntime'
import {
  findPendingAskUserByRequestId,
  type PendingAskUser,
} from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import type { TimelineCardContext } from '../TimelineCards/registry'
import styles from './AskUserCard.module.css'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

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

/** 从工具 args 解析提问内容（pending 丢失时的回退数据源） */
function parseAskArgs(args: unknown): {
  context?: string
  questions: AskUserModalQuestion[]
} | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  const rawQuestions = record.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null

  const questions: AskUserModalQuestion[] = []
  for (const item of rawQuestions) {
    if (!item || typeof item !== 'object') continue
    const q = item as Record<string, unknown>
    if (typeof q.question !== 'string' || typeof q.header !== 'string') continue
    if (!Array.isArray(q.options) || q.options.length < 2) continue
    const options = q.options
      .map((opt) => {
        if (!opt || typeof opt !== 'object') return null
        const o = opt as Record<string, unknown>
        if (typeof o.label !== 'string' || typeof o.description !== 'string') return null
        return {
          label: o.label,
          description: o.description,
          ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
          ...(o.recommended === true ? { recommended: true as const } : {}),
          ...(typeof o.recommendReason === 'string' ? { recommendReason: o.recommendReason } : {}),
        }
      })
      .filter((opt): opt is NonNullable<typeof opt> => opt !== null)
    if (options.length < 2) continue
    questions.push({
      question: q.question,
      header: q.header,
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    })
  }
  if (questions.length === 0) return null
  return {
    ...(typeof record.context === 'string' && record.context.trim()
      ? { context: record.context }
      : {}),
    questions,
  }
}

/** 订阅与本 part 对齐的 pending（按 requestId，而非全局首个） */
function usePendingAskForPart(requestId: string): PendingAskUser | null {
  return useAgentRuntimeGlobalState((state) => {
    const found = findPendingAskUserByRequestId(state, requestId)
    return found?.pending ?? null
  })
}

/**
 * 匹配 ask_user_question 工具 part；pending 或 running+args 时渲染可点选表单。
 */
export const AskUserCard: React.FC<TimelineCardContext> = ({ part }) => {
  const pending = usePendingAskForPart(part.id)
  const { respondAskUser } = useAgentRuntimeActions()
  const summary = useMemo(() => summarizeAskResult(part.result), [part.result])
  const argsFallback = useMemo(() => parseAskArgs(part.args), [part.args])

  const interactive = useMemo(() => {
    if (pending) return pending
    if (part.status !== 'running' || !argsFallback) return null
    return {
      requestId: part.id,
      context: argsFallback.context,
      questions: argsFallback.questions,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      receivedAt: 0,
    }
  }, [pending, part.status, part.id, argsFallback])

  if (interactive) {
    return (
      <AskUserModal
        open
        variant="inline"
        context={interactive.context}
        questions={interactive.questions}
        timeoutMs={interactive.timeoutMs}
        onSubmit={(payload) => void respondAskUser(payload, part.id)}
        onDecline={() => void respondAskUser({ answers: {}, declined: true }, part.id)}
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

/** 单测入口：args 解析 */
export const __askUserCardTest = { parseAskArgs, summarizeAskResult }
