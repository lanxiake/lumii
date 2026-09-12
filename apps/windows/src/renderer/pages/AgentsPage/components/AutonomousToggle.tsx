import React, { useCallback, useEffect, useState } from 'react'
import { getAutonomousAgents, setAutonomousAgents } from '../../../services/autonomous-service'
import styles from './AutonomousToggle.module.css'

interface AutonomousToggleProps {
  agentId: string
  /** panel = 详情面板大号展示；compact = 卡片/列表行内小号（默认） */
  variant?: 'panel' | 'compact'
}

/**
 * 自主心跳开关：写入 app.json autonomousAgents 列表，心跳 tick 时该 Agent 参与遍历。
 * assistant 恒参与（随全局开关），不渲染本开关。AgentsPage 三个视图（Map/Grid/Feed）共用。
 */
export const AutonomousToggle: React.FC<AutonomousToggleProps> = ({ agentId, variant = 'compact' }) => {
  const [on, setOn] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const ids = await getAutonomousAgents()
        if (!cancelled) setOn(ids.includes(agentId))
      } catch {
        if (!cancelled) setOn(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentId])

  const handleToggle = useCallback(
    async (next: boolean) => {
      try {
        const ids = await getAutonomousAgents()
        const set = new Set(ids)
        if (next) set.add(agentId)
        else set.delete(agentId)
        await setAutonomousAgents([...set])
        setOn(next)
      } catch {
        // 保存失败保持原状态
      }
    },
    [agentId],
  )

  if (agentId === 'assistant') return null
  if (on === null) {
    return <span className={styles['loading']}>自主心跳加载中…</span>
  }

  return (
    <label
      className={variant === 'panel' ? `${styles['row']} ${styles['row--panel']}` : styles['row']}
      onClick={(e) => e.stopPropagation()}
      title="开启后该 Agent 会按心跳周期参与自主行为（反思 / 目标执行），消耗 LLM 调用"
    >
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => void handleToggle(e.target.checked)}
      />
      <span className={styles['label']}>参与自主心跳</span>
    </label>
  )
}
