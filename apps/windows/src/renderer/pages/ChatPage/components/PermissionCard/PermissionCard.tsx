/**
 * 工具审批时间线卡片：pending 且 requestId === part.id 时渲染可点选审批。
 */

import React from 'react'
import { ConfirmationDialog } from '../../../../components/ConfirmationDialog'
import {
  useAnyPendingPermission,
  useAgentRuntimeActions,
  useAgentRuntimeGlobalState,
} from '../../../../hooks/business/useAgentRuntime'
import { findAnyPendingPermission, runtimeStore } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import type { TimelineCardContext, ToolPart } from '../TimelineCards/registry'
import styles from './PermissionCard.module.css'

/** 当前是否有挂起审批且对准该工具 part（供注册表 match 使用） */
export function matchesPendingPermission(part: ToolPart): boolean {
  const found = findAnyPendingPermission(runtimeStore.getState())
  return found?.pending.requestId === part.id
}

/**
 * 审批卡：仅在挂起态展示交互；解除后由注册表不再命中，回落到普通工具行。
 */
export const PermissionCard: React.FC<TimelineCardContext> = ({ part }) => {
  const { pending, sessionKey } = useAnyPendingPermission()
  const { respondPermission } = useAgentRuntimeActions()
  const currentSessionKey = useAgentRuntimeGlobalState((s) => s.currentSessionKey)
  const focusPermissionRequestId = useAgentRuntimeGlobalState((s) => s.focusPermissionRequestId)
  const isPending = pending?.requestId === part.id
  const highlight =
    Boolean(focusPermissionRequestId) && focusPermissionRequestId === part.id

  if (!isPending || !pending) {
    return (
      <div className={styles.fallback} data-testid="permission-card-idle">
        等待审批…
      </div>
    )
  }

  return (
    <ConfirmationDialog
      open
      description={pending.description}
      toolName={pending.toolName}
      timeoutMs={pending.timeoutMs}
      highlight={highlight}
      sessionHint={
        sessionKey && sessionKey !== currentSessionKey
          ? `来自后台会话：${sessionKey}`
          : undefined
      }
      onAllowOnce={() => void respondPermission('allow-once')}
      onAllowAlways={() => void respondPermission('allow-always')}
      onDeny={() => void respondPermission('deny')}
    />
  )
}
