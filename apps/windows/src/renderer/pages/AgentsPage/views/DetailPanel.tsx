import React, { useEffect } from 'react'
import type { Agent } from './types'
import { agentColor } from './types'
import { AgentDefinitionView, resolveWhenToUse } from './AgentDefinitionView'
import { MessageSquare, PenLine, Trash2, X, GitBranch } from 'lucide-react'
import styles from './DetailPanel.module.css'

interface DetailPanelProps {
  agent: Agent
  isSystem: boolean
  onClose: () => void
  onStartChat: (agentId: string) => void
  onEdit: (agent: Agent) => void
  onDelete: (agentId: string) => void
  onFork: (agent: Agent) => void
}

export const DetailPanel: React.FC<DetailPanelProps> = ({
  agent,
  isSystem,
  onClose,
  onStartChat,
  onEdit,
  onDelete,
  onFork,
}) => {
  const color = agentColor(agent)

  // Escape 关闭（面板由 AgentsPage 统一挂载，键盘处理收在这里）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    // 遮罩铺满整个内容区：点击面板外的空白处即关闭
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.avatar} style={{ borderColor: color }}>
            {agent.identity?.emoji ?? agent.name.slice(0, 1).toUpperCase()}
          </div>
          <div className={styles.titleArea}>
            <h3 className={styles.name}>{agent.name}</h3>
            {/* 内置 Agent 的 description 即「何时使用」，下方同名区块会完整展示，此处不重复 */}
            {agent.description && agent.description !== resolveWhenToUse(agent) && (
              <p className={styles.desc}>{agent.description}</p>
            )}
          </div>
          <button className={styles.closeBtn} onClick={onClose}><X size={14} /></button>
        </div>

        <div className={styles.actions}>
          {isSystem ? (
            <>
              {agent.selectable && (
                <button className={styles['btn--chat']} onClick={() => onStartChat(agent.id)}>
                  <MessageSquare size={13} /> 发起对话
                </button>
              )}
              <button className={styles['btn--primary']} onClick={() => onFork(agent)}>
                <GitBranch size={13} /> 基于此创建
              </button>
            </>
          ) : (
            <>
              <button className={styles['btn--chat']} onClick={() => onStartChat(agent.id)}>
                <MessageSquare size={13} /> 发起对话
              </button>
              <button className={styles['btn--secondary']} onClick={() => onEdit(agent)}>
                <PenLine size={13} /> 编辑
              </button>
              <button className={styles['btn--danger']} onClick={() => onDelete(agent.id)}>
                <Trash2 size={13} /> 删除
              </button>
            </>
          )}
        </div>

        <AgentDefinitionView agent={agent} />

        {agent.systemPrompt && (
          <div className={styles.section}>
            <div className={styles['section-title']}>系统提示词</div>
            <div className={styles.promptText}>{agent.systemPrompt}</div>
          </div>
        )}

        {isSystem && (
          <div className={styles.systemBadge}>系统内置 Agent · 不可编辑</div>
        )}
      </div>
    </div>
  )
}
