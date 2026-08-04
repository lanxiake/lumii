import React from 'react';
import { Monitor, Smartphone, Laptop, HardDrive } from 'lucide-react';
import clsx from 'clsx';
import type { SingleConnectionStatus } from '../DualConnectionStatus/DualConnectionStatus';
import styles from './DeviceCard.module.css';

/**
 * 设备状态类型
 */
export type DeviceStatus = 'online' | 'offline' | 'connecting';

/**
 * 设备卡片数据接口
 */
export interface DeviceCardData {
  /** 设备ID */
  id: string;
  /** 设备名称 */
  name: string;
  /** 设备类型 */
  type?: string;
  /** 设备状态 */
  status: DeviceStatus;
  /** 最后活跃时间 */
  lastActiveAt?: string;
  /** 设备信息 */
  info?: {
    platform?: string;
    version?: string;
    ip?: string;
  };
}

/**
 * DeviceCard 组件 Props
 */
export interface DeviceCardProps {
  /** 设备数据 */
  device: {
    id: string
    name: string
    platform: string
    version?: string
    isOnline: boolean
    isPrimary?: boolean
    lastActiveAt?: string
    ipAddress?: string
  }
  /** 设备图标 */
  icon?: React.ReactNode
  /** 是否是当前设备 */
  isCurrentDevice?: boolean
  /** 设置为主设备回调 */
  onSetPrimary?: () => void
  /** 取消主设备回调 */
  onUnsetPrimary?: () => void
  /** 删除设备回调 */
  onDelete?: () => void
  /** 轮换 Token 回调 */
  onRotateToken?: () => void
  /** 本机 Gateway 连接信息（仅本机设备展示） */
  gateway?: {
    url: string
    uiConnection: SingleConnectionStatus
    nodeConnection: SingleConnectionStatus
  }
  /** 手动重连 Gateway（仅本机设备） */
  onReconnect?: () => void
  /** 是否正在重连 */
  isReconnecting?: boolean
  isSelected?: boolean
  /** 是否正在操作 */
  isOperating?: boolean
  /** 点击卡片回调 */
  onClick?: () => void
}

/**
 * 格式化日期显示
 */
function formatLastActive(dateStr?: string): string {
  if (!dateStr) {return '从未活跃';}

  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) {return '刚刚';}
    if (minutes < 60) {return `${minutes} 分钟前`;}
    if (hours < 24) {return `${hours} 小时前`;}
    if (days < 30) {return `${days} 天前`;}

    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

/**
 * 获取 Gateway 子连接状态文案
 */
function getGatewayLinkText(state: SingleConnectionStatus['state']): string {
  switch (state) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '连接中'
    case 'error':
      return '异常'
    default:
      return '未连接'
  }
}

/**
 * 获取设备在线状态显示文本
 */
function getStatusText(status: DeviceStatus): string {
  switch (status) {
    case 'online':
      return '在线';
    case 'offline':
      return '离线';
    case 'connecting':
      return '连接中';
    default:
      return status;
  }
}

/**
 * 获取设备图标
 */
function getDeviceIcon(type?: string): React.ReactNode {
  switch (type?.toLowerCase()) {
    case 'mobile':
    case 'phone':
      return <Smartphone size={16} />;
    case 'tablet':
      return <Smartphone size={16} />;
    case 'desktop':
    case 'computer':
      return <Laptop size={16} />;
    case 'server':
      return <Monitor size={16} />;
    default:
      return <HardDrive size={16} />;
  }
}

/**
 * DeviceCard 组件 - 设备卡片
 *
 * 显示设备名称、ID、状态、最后活跃时间
 * 支持删除、轮换 Token 等操作
 */
export const DeviceCard: React.FC<DeviceCardProps> = ({
  device,
  icon,
  isCurrentDevice = false,
  isSelected = false,
  isOperating = false,
  onClick,
  onSetPrimary,
  onUnsetPrimary,
  onDelete,
  onRotateToken,
  gateway,
  onReconnect,
  isReconnecting = false,
}) => {
  const status = device.isOnline ? 'online' : 'offline'

  /**
   * 处理删除按钮点击
   */
  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete?.()
  }

  /**
   * 处理轮换 Token 按钮点击
   */
  const handleRotateTokenClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onRotateToken?.()
  }

  /**
   * 处理设置主设备按钮点击
   */
  const handleSetPrimaryClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSetPrimary?.()
  }

  /**
   * 处理取消主设备按钮点击
   */
  const handleUnsetPrimaryClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onUnsetPrimary?.()
  }

  /**
   * 处理手动重连按钮点击
   */
  const handleReconnectClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onReconnect?.()
  }

  return (
    <div
      className={clsx(styles['device-card'], isSelected && styles['selected'], styles[`status-${status}`])}
      onClick={onClick}
    >
      {/* 设备主要信息（图标 + 内容） */}
      <div className={styles['device-card-main']}>
        {/* 设备图标 */}
        <div className={styles['device-card-icon']}>
          <span>{icon || getDeviceIcon(device.platform)}</span>
          <span className={clsx(styles['device-status-dot'], styles[status])} />
        </div>

        {/* 设备内容 */}
        <div className={styles['device-card-content']}>
          <div className={styles['device-card-header']}>
            <h4 className={styles['device-name']} title={device.name}>
              {device.name}
              {isCurrentDevice && <span className={styles['local-badge']}>（本机）</span>}
              {!isCurrentDevice && device.isPrimary && (
                <span className={styles['primary-badge']}>（主设备）</span>
              )}
            </h4>
            <span className={clsx(styles['device-status-badge'], styles[status])}>
              {getStatusText(status)}
            </span>
          </div>

          <div className={styles['device-id']}>
            <span className={styles['label']}>ID:</span>
            <code className={styles['value']}>{device.id}</code>
          </div>

          <div className={styles['device-meta']}>
            <span className={styles['last-active']}>
              最后活跃: {formatLastActive(device.lastActiveAt)}
            </span>
            {device.platform && (
              <span className={styles['device-platform']}>{device.platform}</span>
            )}
          </div>

          {(device.version || device.ipAddress) && (
            <div className={styles['device-info']}>
              {device.version && (
                <span className={styles['info-tag']}>v{device.version}</span>
              )}
              {device.ipAddress && (
                <span className={clsx(styles['info-tag'], styles['ip'])}>{device.ipAddress}</span>
              )}
            </div>
          )}

          {gateway && (
            <div className={styles['gateway-inline']}>
              <div className={styles['gateway-url']} title={gateway.url}>
                <span className={styles['label']}>Gateway:</span>
                <code className={styles['value']}>{gateway.url}</code>
              </div>
              <div className={styles['gateway-links']}>
                <span className={clsx(styles['gateway-link'], styles[`link-${gateway.uiConnection.state}`])}>
                  UI {getGatewayLinkText(gateway.uiConnection.state)}
                </span>
                <span className={styles['gateway-link-sep']}>·</span>
                <span className={clsx(styles['gateway-link'], styles[`link-${gateway.nodeConnection.state}`])}>
                  Node {getGatewayLinkText(gateway.nodeConnection.state)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className={styles['device-card-actions']}>
        {onReconnect && (
          <button
            className={clsx(styles['action-btn'], styles['reconnect-btn'])}
            onClick={handleReconnectClick}
            disabled={isOperating || isReconnecting}
            title="重新连接 Gateway"
          >
            {isReconnecting ? '连接中...' : '重连'}
          </button>
        )}
        {onRotateToken && (
          <button
            className={clsx(styles['action-btn'], styles['rotate-btn'])}
            onClick={handleRotateTokenClick}
            disabled={isOperating}
            title="轮换 Token"
          >
            {isOperating ? '...' : '轮换'}
          </button>
        )}
        {onSetPrimary && (
          <button
            className={clsx(styles['action-btn'], styles['primary-btn'])}
            onClick={handleSetPrimaryClick}
            disabled={isOperating}
            title="设为主设备"
          >
            设为主设备
          </button>
        )}
        {onUnsetPrimary && (
          <button
            className={clsx(styles['action-btn'], styles['unset-primary-btn'])}
            onClick={handleUnsetPrimaryClick}
            disabled={isOperating}
            title="取消主设备"
          >
            取消主设备
          </button>
        )}
        {onDelete && (
          <button
            className={clsx(styles['action-btn'], styles['delete-btn'])}
            onClick={handleDeleteClick}
            disabled={isOperating}
            title="删除设备"
          >
            {isOperating ? '...' : '删除'}
          </button>
        )}
      </div>
    </div>
  )
}

export default DeviceCard
