import React, { useMemo } from 'react'
import clsx from 'clsx'
import { Bot } from '../../../components/ui/Icon'
import type { ViewProps, Agent } from './types'
import { TIER_LABELS } from './types'
import { SkillMissingBadge } from './SkillMissingBadge'
import { decodeGroupFromDescription } from '../components/GenerateTeamWizard/utils'
import styles from './GridView.module.css'

interface ParsedAgent extends Agent {
  _cleanDesc: string
}

function parseAgents(agents: Agent[]): ParsedAgent[] {
  return agents.map((a) => {
    const { cleanDescription } = decodeGroupFromDescription(a.description ?? '')
    return { ...a, _cleanDesc: cleanDescription }
  })
}

function AgentCard({
  agent,
  runtimeStateMap,
  onEdit,
  onDelete,
  onStartChat,
  isSystem = false,
  onFork,
  missingSkills,
  onInstallSkill,
  onNavigateToStore,
}: {
  agent: ParsedAgent
  runtimeStateMap: Record<string, { anyRunning: boolean } | undefined>
  onEdit: (a: Agent) => void
  onDelete: (id: string) => void
  onStartChat: (id: string) => void
  isSystem?: boolean
  onFork?: (a: Agent) => void
  missingSkills?: import('./types').MissingSkill[]
  onInstallSkill?: (agentId: string, skillId: string, skillName: string) => Promise<boolean>
  onNavigateToStore?: (skillName: string) => void
}) {
  return (
    <div className={clsx(styles.card, isSystem && styles['card--system'])}>
      <div className={styles['card-header']}>
        <div className={clsx(styles.avatar, isSystem && styles['avatar--system'])}>
          {agent.identity?.emoji ?? agent.name.slice(0, 1).toUpperCase()}
        </div>
        <div className={styles.info}>
          <div className={styles.nameRow}>
            <div className={styles.name}>{agent.name}</div>
            {runtimeStateMap[agent.id]?.anyRunning && (
              <span className={styles['badge--running']} title="运行中">
                <span className={styles['runningDot']} />
                运行中
              </span>
            )}
          </div>
          {agent._cleanDesc && (
            <div className={styles.desc}>{agent._cleanDesc}</div>
          )}
          {isSystem && <span className={styles['badge--system']}>系统内置</span>}
        </div>
      </div>
      {!isSystem && agent.systemPrompt && (
        <div className={styles['prompt-preview']}>
          {agent.systemPrompt.slice(0, 120)}
          {agent.systemPrompt.length > 120 && '...'}
        </div>
      )}
      {!isSystem && (
        <div className={styles.tags}>
          {agent.modelTier && (
            <span className={clsx(styles.tag, styles[`tag--${agent.modelTier}`])}>
              {TIER_LABELS[agent.modelTier]}
            </span>
          )}
          {agent.model?.primary && (
            <span className={styles['tag--model']}>
              {agent.model.primary.split('/').pop()}
            </span>
          )}
          {missingSkills && missingSkills.length > 0 && onInstallSkill && onNavigateToStore && (
            <SkillMissingBadge
              agentId={agent.id}
              missing={missingSkills}
              popoverAlign="left"
              onInstallSkill={onInstallSkill}
              onNavigateToStore={onNavigateToStore}
            />
          )}
        </div>
      )}
      <div className={styles.actions}>
        {isSystem ? (
          <button className={styles['btn--primary']} onClick={() => onFork?.(agent)}>基于此创建</button>
        ) : (
          <>
            <button className={styles['btn--chat']} onClick={() => onStartChat(agent.id)}>对话</button>
            <button className={styles['btn--secondary']} onClick={() => onEdit(agent)}>编辑</button>
            <button className={styles['btn--danger']} onClick={() => onDelete(agent.id)}>删除</button>
          </>
        )}
      </div>
    </div>
  )
}

export const GridView: React.FC<ViewProps> = ({
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
  const match = (a: Agent) =>
    !searchQuery ||
    a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    a.description?.toLowerCase().includes(searchQuery.toLowerCase())

  const parsedUser = useMemo(() => parseAgents(userAgents.filter(match)), [userAgents, searchQuery])
  const parsedSys = useMemo(() => parseAgents(systemAgents.filter(match)), [systemAgents, searchQuery])

  if (parsedUser.length === 0 && parsedSys.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles['empty-icon']}><Bot size={36} /></div>
        <div className={styles['empty-text']}>
          {searchQuery ? '没有找到匹配的 Agent' : '还没有自定义 Agent'}
        </div>
      </div>
    )
  }

  const cardProps = { runtimeStateMap, onEdit, onDelete, onStartChat }

  return (
    <div className={styles.container}>
      {parsedUser.length > 0 && (
        <div className={styles.grid}>
          {parsedUser.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              {...cardProps}
              missingSkills={missingSkillsMap?.[agent.id]}
              onInstallSkill={onInstallSkill}
              onNavigateToStore={onNavigateToStore}
            />
          ))}
        </div>
      )}

      {parsedSys.length > 0 && (
        <>
          <div className={styles['section-label']}>系统模板</div>
          <div className={styles.grid}>
            {parsedSys.map((agent) => (
              <AgentCard key={agent.id} agent={agent} {...cardProps} isSystem onFork={onFork} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
