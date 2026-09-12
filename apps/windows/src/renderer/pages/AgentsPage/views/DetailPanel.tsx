import React, { useCallback, useEffect, useState } from 'react'
import type { Agent } from './types'
import { TIER_LABELS, agentColor } from './types'
import { getAgentLifecycleSnapshot } from '../../../services/agent-service'
import { AutonomousToggle } from '../components/AutonomousToggle'
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

/** 主进程聚合的运行时快照（与 bridge.getLifecycleSnapshot 对齐） */
interface LifecycleSnapshot {
  instanceCount: number
  runningCount: number
  anyRunning: boolean
  runningSinceMs: number | null
  totalTurns: number
  totalInputTokens: number
  totalOutputTokens: number
  subAgentsRunning: number
}

/**
 * 展示运行中时长文案（相对 runningSinceMs）
 */
function formatRunningLabel(anyRunning: boolean, sinceMs: number | null): string {
  if (!anyRunning || sinceMs == null) {
    return '空闲'
  }
  const sec = Math.floor((Date.now() - sinceMs) / 1000)
  if (sec < 60) {
    return `运行中（约 ${sec} 秒）`
  }
  const min = Math.floor(sec / 60)
  if (min < 60) {
    return `运行中（约 ${min} 分钟）`
  }
  const h = Math.floor(min / 60)
  const m = min % 60
  return m > 0 ? `运行中（约 ${h} 小时 ${m} 分）` : `运行中（约 ${h} 小时）`
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
  const [lifecycle, setLifecycle] = useState<LifecycleSnapshot | null | undefined>(undefined)

  const refreshLifecycle = useCallback(async () => {
    try {
      const s = await getAgentLifecycleSnapshot(agent.id)
      setLifecycle(s as LifecycleSnapshot)
    } catch {
      setLifecycle(null)
    }
  }, [agent.id])

  useEffect(() => {
    void refreshLifecycle()
    const t = window.setInterval(() => void refreshLifecycle(), 2000)
    return () => window.clearInterval(t)
  }, [refreshLifecycle])

  // Escape 关闭（面板由 AgentsPage 统一挂载，键盘处理收在这里）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
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

        <div className={styles.section}>
          <div className={styles['section-title']}>模型信息</div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>模型级别</span>
            <span className={styles.infoValue}>
              {agent.modelTier ? TIER_LABELS[agent.modelTier] : '未设置'}
            </span>
          </div>
          {agent.model?.primary && (
            <div className={styles.infoRow}>
              <span className={styles.infoLabel}>主模型</span>
              <span className={styles.infoValue}>{agent.model.primary}</span>
            </div>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles['section-title']}>运行状态</div>
          {lifecycle === undefined && (
            <p className={styles.muted}>加载中…</p>
          )}
          {lifecycle === null && (
            <p className={styles.muted}>
              连接本地 Agent Runtime 后可查看运行统计
            </p>
          )}
          {lifecycle && (
            <>
              <div className={styles.lifecycleRow}>
                <span
                  className={styles.lifecycleDot}
                  data-on={lifecycle.anyRunning ? '1' : '0'}
                  aria-hidden
                />
                <span className={styles.infoValue}>
                  {formatRunningLabel(lifecycle.anyRunning, lifecycle.runningSinceMs)}
                </span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>活跃会话</span>
                <span className={styles.infoValue}>{lifecycle.instanceCount} 个</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>累计轮次</span>
                <span className={styles.infoValue}>{lifecycle.totalTurns} 轮</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Token 消耗</span>
                <span className={styles.infoValue}>
                  {(lifecycle.totalInputTokens + lifecycle.totalOutputTokens).toLocaleString()}
                  {' '}
                  <span className={styles.muted}>
                    (入 {lifecycle.totalInputTokens.toLocaleString()} / 出{' '}
                    {lifecycle.totalOutputTokens.toLocaleString()})
                  </span>
                </span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>子 Agent</span>
                <span className={styles.infoValue}>
                  {lifecycle.subAgentsRunning > 0
                    ? `${lifecycle.subAgentsRunning} 个运行中`
                    : '无'}
                </span>
              </div>
            </>
          )}
        </div>

        {agent.systemPrompt && (
          <div className={styles.section}>
            <div className={styles['section-title']}>系统提示词</div>
            <div className={styles.promptText}>{agent.systemPrompt}</div>
          </div>
        )}

        <div className={styles.section}>
          <div className={styles['section-title']}>自主能力</div>
          {agent.id === 'assistant' ? (
            <p className={styles.muted}>随全局开关参与自主行为，无需单独配置</p>
          ) : (
            <>
              <AutonomousToggle agentId={agent.id} variant="panel" />
              <p className={styles.muted}>
                开启后该 Agent 会按心跳周期参与自主行为（反思 / 目标执行），消耗 LLM 调用。
              </p>
            </>
          )}
        </div>

        {isSystem && (
          <div className={styles.systemBadge}>系统内置 Agent · 不可编辑</div>
        )}
      </div>
    </div>
  )
}
