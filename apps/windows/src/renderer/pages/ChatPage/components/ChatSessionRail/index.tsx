/**
 * ChatSessionRail — 对话区左侧轨道
 *
 * 常驻展示当前会话的任务进度（Todo）与会话文件变更列表，
 * 避免挤在输入框上方或与右侧工作空间面板冲突。
 */

import React from 'react'
import clsx from 'clsx'
import { TodoPanel } from '../TodoPanel'
import { SessionFileList } from '../SessionFileList'
import type { RuntimeFileEvent } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import styles from './ChatSessionRail.module.css'

export interface ChatSessionRailProps {
  todoCalls: readonly {
    id: string
    name: string
    status: 'running' | 'completed' | 'failed' | 'error'
    result?: unknown
    output?: unknown
  }[]
  files: readonly RuntimeFileEvent[]
  sessionKey: string | null
  userId?: string
  /** 打开工作空间并定位到文件（可选） */
  onReviewFiles?: () => void
}

/**
 * 左侧会话元信息轨道：有 Todo 或文件时才渲染
 */
export const ChatSessionRail: React.FC<ChatSessionRailProps> = ({
  todoCalls,
  files,
  sessionKey,
  userId = 'local-user',
  onReviewFiles,
}) => {
  const hasTodo = todoCalls.length > 0
  const hasFiles = files.length > 0
  if (!hasTodo && !hasFiles) return null

  return (
    <aside className={styles.rail} aria-label="会话任务与文件">
      {hasTodo && (
        <section className={styles.section}>
          <TodoPanel toolCalls={todoCalls} variant="rail" />
        </section>
      )}
      {hasFiles && (
        <section className={clsx(styles.section, styles.sectionFiles)}>
          <SessionFileList
            files={files}
            userId={userId}
            sessionKey={sessionKey}
            variant="rail"
            onReview={onReviewFiles}
          />
        </section>
      )}
    </aside>
  )
}

export default ChatSessionRail
