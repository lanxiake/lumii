import React from 'react'
import clsx from 'clsx'
import { FileText, Terminal, Globe, Brain, Bot, Radio, Wrench } from 'lucide-react'
import styles from './ToolCard.module.css'

const ICON_SIZE = 15

/** 工具分类图标映射 */
const CATEGORY_ICON_MAP: Record<string, React.ReactNode> = {
  filesystem: <FileText size={ICON_SIZE} />,
  shell:      <Terminal size={ICON_SIZE} />,
  web:        <Globe size={ICON_SIZE} />,
  memory:     <Brain size={ICON_SIZE} />,
  agent:      <Bot size={ICON_SIZE} />,
  channel:    <Radio size={ICON_SIZE} />,
}

export interface ToolCardProps {
  /** 工具名称（如 file_read） */
  name: string
  /** 显示标签 */
  label: string
  /** 一句话描述 */
  description: string
  /** 工具分类 */
  category: string
  /** 是否只读 */
  isReadOnly: boolean
  /** 启用状态 */
  enabled: boolean
  /** 累计调用次数，从未调用过为 0 */
  usageCount?: number
  /** 最后一次调用时刻（epoch ms） */
  lastUsedAt?: number
  /** 操作中（切换时） */
  isToggling?: boolean
  /** 切换启用/禁用回调 */
  onToggle: (enabled: boolean) => void
}

/**
 * ToolCard — 工具卡片（一行极简展示）
 *
 * 图标 + 名称 + 描述 + 开关，满足计划 P1 极简原则。
 */
export const ToolCard: React.FC<ToolCardProps> = ({
  name,
  label,
  description,
  category,
  isReadOnly,
  enabled,
  usageCount = 0,
  lastUsedAt,
  isToggling = false,
  onToggle,
}) => {
  const icon = CATEGORY_ICON_MAP[category] ?? <Wrench size={ICON_SIZE} />

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!isToggling) {
      onToggle(!enabled)
    }
  }

  return (
    <div className={clsx(styles['tool-card'], !enabled && styles['disabled'])}>
      {/* 分类图标 */}
      <span className={styles['tool-icon']} title={category}>
        {icon}
      </span>

      {/* 工具信息 */}
      <div className={styles['tool-info']}>
        <span className={styles['tool-label']}>{label}</span>
        <span className={styles['tool-name']}>{name}</span>
      </div>

      {/* 描述 */}
      <p className={styles['tool-description']} title={description}>
        {description}
      </p>

      {/* 调用次数：从未用过的弱化显示，提示可关掉省上下文 */}
      <span
        className={clsx(styles['tool-usage'], usageCount === 0 && styles['tool-usage-never'])}
        title={
          usageCount === 0
            ? '从未调用过，可考虑禁用以节省上下文'
            : `累计调用 ${usageCount} 次${lastUsedAt ? `，最后使用 ${new Date(lastUsedAt).toLocaleString()}` : ''}`
        }
      >
        {usageCount === 0 ? '未用过' : `${usageCount} 次`}
      </span>

      {/* 只读标记 */}
      {isReadOnly && (
        <span className={styles['tool-readonly']} title="只读工具，无需权限确认">
          只读
        </span>
      )}

      {/* 开关按钮 */}
      <button
        className={clsx(
          styles['toggle-btn'],
          enabled ? styles['on'] : styles['off'],
        )}
        onClick={handleToggle}
        disabled={isToggling}
        title={enabled ? '点击禁用' : '点击启用'}
      >
        {isToggling ? '...' : enabled ? '已启用' : '已禁用'}
      </button>
    </div>
  )
}

export default ToolCard
