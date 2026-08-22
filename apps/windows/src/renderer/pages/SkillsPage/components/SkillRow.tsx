import React from 'react'
import clsx from 'clsx'
import { Loader2, ToggleLeft, ToggleRight, Folder, Trash2 } from 'lucide-react'
import styles from '../SkillsPage.module.css'

/**
 * SkillRow - 紧凑技能行（替代大卡片）
 * 高度约 36px，hover 时显示操作按钮
 */
export interface SkillRowProps {
  skillInfo: {
    skillItemId: string
    isEnabled: boolean
    executionCount?: number
    skill: { name: string; description?: string; version: string; tags?: string[] }
  }
  isOperating: boolean
  onDetail: () => void
  onToggle: () => void
  onUninstall: () => void
  onOpenDir?: () => void
}

export const SkillRow: React.FC<SkillRowProps> = ({ skillInfo, isOperating, onDetail, onToggle, onUninstall, onOpenDir }) => {
  return (
    <div
      className={clsx(styles['skill-row'], !skillInfo.isEnabled && styles['skill-row--disabled'])}
      onClick={onDetail}
      style={{ cursor: 'pointer' }}
    >
      {/* 状态指示点 */}
      <span className={clsx(styles['skill-row-dot'], skillInfo.isEnabled ? styles['dot-enabled'] : styles['dot-disabled'])} />

      {/* 名称 + 描述 */}
      <span className={styles['skill-row-name']} title={skillInfo.skill.name}>
        {skillInfo.skill.name}
      </span>
      {skillInfo.skill.description && (
        <span className={styles['skill-row-desc']} title={skillInfo.skill.description}>
          {skillInfo.skill.description}
        </span>
      )}

      {/* 调用次数 */}
      <span
        className={styles['skill-row-usage']}
        title={skillInfo.executionCount ? `累计调用 ${skillInfo.executionCount} 次` : '从未调用过'}
      >
        {skillInfo.executionCount ? `${skillInfo.executionCount} 次` : '未用过'}
      </span>

      {/* 操作区（hover 显示） */}
      <div className={styles['skill-row-actions']}>
        <button
          className={clsx(styles['skill-row-btn'], skillInfo.isEnabled ? styles['btn-disable'] : styles['btn-enable'])}
          onClick={(e) => { e.stopPropagation(); onToggle() }}
          disabled={isOperating}
          title={skillInfo.isEnabled ? '禁用' : '启用'}
        >
          {isOperating ? <Loader2 size={13} className="animate-spin" /> : skillInfo.isEnabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
        </button>
        {onOpenDir && (
          <button
            className={styles['skill-row-btn']}
            onClick={(e) => { e.stopPropagation(); onOpenDir() }}
            title="打开目录"
          >
            <Folder size={13} />
          </button>
        )}
        <button
          className={clsx(styles['skill-row-btn'], styles['btn-danger'])}
          onClick={(e) => { e.stopPropagation(); onUninstall() }}
          disabled={isOperating}
          title="卸载"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}
