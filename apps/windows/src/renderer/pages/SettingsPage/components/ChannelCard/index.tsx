import React from 'react'
import { Card } from '../../../../components/ui/Card/Card'

interface ChannelCardProps {
  /** 渠道图标（可选；无官方图时可不传） */
  icon?: React.ReactNode
  /** 渠道名称 */
  name: string
  /** 渠道描述（可选） */
  description?: string
  /** 状态区域（右上角，通常是 LoginStatus / Tag 等） */
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
 * ChannelCard - 通用渠道设置卡片
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
    <Card>
      <div style={{ padding: '4px 0' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {icon ? (
              <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0, display: 'inline-flex' }}>{icon}</span>
            ) : null}
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, lineHeight: '20px' }}>{name}</div>
              {description && (
                <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>{description}</div>
              )}
            </div>
          </div>
          {statusSlot && (
            <div style={{ flexShrink: 0, marginLeft: 12 }}>
              {statusSlot}
            </div>
          )}
        </div>

        {/* 错误横幅 */}
        {errorMessage && (
          <div style={{
            marginBottom: 12,
            padding: '7px 12px',
            background: '#fff2f0',
            border: '1px solid #ffccc7',
            borderRadius: 6,
            color: '#cf1322',
            fontSize: 13,
          }}>
            {errorMessage}
          </div>
        )}

        {/* 操作按钮区 */}
        {actionsSlot && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {actionsSlot}
          </div>
        )}

        {/* 额外信息区 */}
        {extraSlot && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#8c8c8c' }}>
            {extraSlot}
          </div>
        )}

        {/* 可扩展内容区（配置表单等） */}
        {children}
      </div>
    </Card>
  )
}

export default ChannelCard
