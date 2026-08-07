import React from 'react'
import { Tag } from '../../../../components/ui/Tag/Tag'

type WeixinLoginStatus = 'idle' | 'waiting_qrcode' | 'scanned' | 'confirmed' | 'logged_in' | 'error'

interface WeixinSession {
  userId: string
  /** iLink 设备标识（部分会话数据可能缺失） */
  deviceId?: string
  loginAt: number
}

interface LoginStatusProps {
  status: WeixinLoginStatus
  /** @deprecated 用户 ID 已改由 ChannelCard.extraSlot 展示，保留参数以免破坏调用方 */
  session?: WeixinSession | null
}

const STATUS_LABELS: Record<WeixinLoginStatus, string> = {
  idle: '未连接',
  waiting_qrcode: '获取二维码中...',
  scanned: '等待扫码...',
  confirmed: '确认登录中...',
  logged_in: '已连接',
  error: '连接出错',
}

const STATUS_COLORS: Record<WeixinLoginStatus, 'default' | 'success' | 'warning' | 'error'> = {
  idle: 'default',
  waiting_qrcode: 'warning',
  scanned: 'warning',
  confirmed: 'warning',
  logged_in: 'success',
  error: 'error',
}

export const LoginStatus: React.FC<LoginStatusProps> = ({ status }) => {
  const label = STATUS_LABELS[status] ?? status
  const color = STATUS_COLORS[status] ?? 'default'

  // 仅展示状态 Tag；用户 ID 等细节放到 ChannelCard.extraSlot，避免挤占标题行宽度
  return <Tag color={color}>{label}</Tag>
}
