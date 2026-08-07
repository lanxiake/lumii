import React from 'react'
import { Card } from '../../../../components/ui/Card/Card'
import styles from './ChannelCard.module.css'

interface ChannelCardProps {
  /** 渠道图标（可选；无官方图时可不传） */
  icon?: React.ReactNode
  /** 渠道名称 */
  name: string
  /** 渠道描述（可选） */
  description?: string
  /** 状态区域（右上角，通常是 Tag） */
  statusSlot?: React.ReactNode
  /** 操作按钮区（底部） */
  actionsSlot?: React.ReactNode
  /** 额外信息区（已连接时显示的额外内容，例如登录时间） */
  extraSlot?: React.ReactNode
  /** 错误提示（非空时展示红色错误横幅） */
  errorMessage?: string | null
  /** 可扩展内容区（如配置表单，展示在操作按钮之后） */
  children?: React.ReactNode
}

/**
 * ChannelCard - 通用渠道设置卡片（等宽网格友好，防止描述被挤成一字一行）
 */
export const ChannelCard: React.FC<ChannelCardProps> = ({
  icon,
  name,
  description,
  statusSlot,
  actionsSlot,
  extraSlot,
  errorMessage,
  children,
}) => {
  return (
    <Card className={styles.card} flush>
      <div className={styles.body}>
        <div className={styles.header}>
          <div className={styles.headerMain}>
            {icon ? <span className={styles.icon}>{icon}</span> : null}
            <div className={styles.headerText}>
              <div className={styles.name}>{name}</div>
              {description && <div className={styles.description}>{description}</div>}
            </div>
          </div>
          {statusSlot && <div className={styles.status}>{statusSlot}</div>}
        </div>

        {errorMessage && <div className={styles.error}>{errorMessage}</div>}

        {actionsSlot && <div className={styles.actions}>{actionsSlot}</div>}

        {extraSlot && <div className={styles.extra}>{extraSlot}</div>}

        {children}
      </div>
    </Card>
  )
}

export default ChannelCard
