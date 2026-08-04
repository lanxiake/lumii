import React, { useState } from 'react'
import clsx from 'clsx'
import type { ViewProps, Agent } from './types'
import { TIER_LABELS } from './types'
import { SkillMissingBadge } from './SkillMissingBadge'
import styles from './FeedView.module.css'

export const FeedView: React.FC<ViewProps> = ({
  userAgents,
  systemAgents,
  searchQuery,
  runtimeStateMap,
  onEdit,
  onDelete,
  onFork,
  onStartChat,
  missingSkillsMap,
  onInstallSkill,
  onNavigateToStore,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const match = (a: Agent) =>
    !searchQuery ||
    a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    a.description?.toLowerCase().includes(searchQuery.toLowerCase())

  const renderRow = (agent: Agent, isSystem: boolean) => {
    const expanded = expandedId === agent.id
    const runtime = runtimeStateMap[agent.id]
    const isRunning = !!runtime?.anyRunning
    const agentMissing = !isSystem ? missingSkillsMap?.[agent.id] : undefined
    return (
      <div
        key={agent.id}
        className={clsx(
          styles.row,
          isSystem && styles['row--system'],
          expanded && styles['row--expanded'],
        )}
        onClick={() => setExpandedId(expanded ? null : agent.id)}
      >
        <div className={styles['row-main']}>
          <span className={styles['row-emoji']}>
            {agent.identity?.emoji ?? agent.name.slice(0, 1).toUpperCase()}
          </span>
          <div className={styles['row-info']}>
            <span className={styles['row-name']}>{agent.name}</span>
            {agent.description && (
              <span className={styles['row-desc']}>{agent.description}</span>
            )}
          </div>
          <div className={styles['row-badges']}>
            {isRunning && (
              <span className={styles['badge--running']} title="运行中">
                <span className={styles['runningDot']} />
                运行中
              </span>
            )}
            {agent.modelTier && (
              <span className={clsx(styles.badge, styles[`badge--${agent.modelTier}`])}>
                {TIER_LABELS[agent.modelTier]}
              </span>
            )}
            {agent.model?.primary && (
              <span className={styles['badge--model']}>
                {agent.model.primary.split('/').pop()}
              </span>
            )}
            {isSystem && <span className={styles['badge--system']}>系统内置</span>}
            {agentMissing && agentMissing.length > 0 && onInstallSkill && onNavigateToStore && (
              <SkillMissingBadge
                agentId={agent.id}
                missing={agentMissing}
                popoverAlign="right"
                onInstallSkill={onInstallSkill}
                onNavigateToStore={onNavigateToStore}
              />
            )}
          </div>
        </div>
        {expanded && (
          <div
            className={styles['row-actions']}
            onClick={(e) => e.stopPropagation()}
          >
            {isSystem ? (
              <button className={styles['btn--primary']} onClick={() => onFork(agent)}>
                基于此创建
              </button>
            ) : (
              <>
                <button className={styles['btn--chat']} onClick={() => onStartChat(agent.id)}>
                  发起对话
                </button>
                <button className={styles['btn--secondary']} onClick={() => onEdit(agent)}>
                  编辑
                </button>
                <button className={styles['btn--danger']} onClick={() => onDelete(agent.id)}>
                  删除
                </button>
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  const filtered = userAgents.filter(match)
  const filteredSys = systemAgents.filter(match)

  if (filtered.length === 0 && filteredSys.length === 0) {
    return <div className={styles.empty}>没有找到匹配的 Agent</div>
  }

  return (
    <div className={styles.feed}>
      {filtered.map((a) => renderRow(a, false))}
      {filteredSys.length > 0 && (
        <>
          <div className={styles['section-label']}>系统模板</div>
          {filteredSys.map((a) => renderRow(a, true))}
        </>
      )}
    </div>
  )
}
