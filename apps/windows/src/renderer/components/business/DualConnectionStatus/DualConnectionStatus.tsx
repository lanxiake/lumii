import React from 'react'
import clsx from 'clsx'
import styles from './DualConnectionStatus.module.css'

/**
 * 连接状态类型
 */
export type ConnectionState = 'connected' | 'disconnected' | 'connecting' | 'error'

/**
 * 单个连接的状态信息
 */
export interface SingleConnectionStatus {
  /** 连接状态 */
  state: ConnectionState
  /** 连接时长 (秒) */
  connectedDuration?: number
  /** 上次连接时间 */
  lastConnectedAt?: string
  /** 错误信息 */
  errorMessage?: string
}

/**
 * DualConnectionStatus 组件 Props
 */
export interface DualConnectionStatusProps {
  /** Gateway 地址 */
  gatewayUrl?: string
  /** UI 连接状态 */
  uiConnection: SingleConnectionStatus
  /** Node 连接状态 */
  nodeConnection: SingleConnectionStatus
  /** 连接所有回调 */
  onConnectAll?: () => void
  /** 断开所有回调 */
  onDisconnectAll?: () => void
  /** 仅连接 UI 回调 */
  onConnectUI?: () => void
  /** 仅断开 UI 回调 */
  onDisconnectUI?: () => void
  /** 仅连接 Node 回调 */
  onConnectNode?: () => void
  /** 仅断开 Node 回调 */
  onDisconnectNode?: () => void
}

/**
 * 获取状态显示文本
 */
function getStatusText(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return '已连接'
    case 'disconnected':
      return '已断开'
    case 'connecting':
      return '连接中'
    case 'error':
      return '错误'
    default:
      return state
  }
}

/**
 * 获取状态图标
 */
function getStatusIcon(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return '✓'
    case 'disconnected':
      return '✕'
    case 'connecting':
      return '⟳'
    case 'error':
      return '⚠'
    default:
      return '?'
  }
}

/**
 * 格式化连接时长
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} 秒`
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟`
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`
  }
  return `${Math.floor(seconds / 86400)} 天`
}

/**
 * 单个连接状态卡片
 */
const ConnectionCard: React.FC<{
  title: string
  description: string
  status: SingleConnectionStatus
  onConnect?: () => void
  onDisconnect?: () => void
}> = ({ title, description, status, onConnect, onDisconnect }) => {
  const statusText = getStatusText(status.state)
  const statusIcon = getStatusIcon(status.state)

  return (
    <div className={clsx(styles['connection-card'], styles[`status-${status.state}`])}>
      <div className={styles['card-header']}>
        <div className={styles['card-title-section']}>
          <h4 className={styles['card-title']}>{title}</h4>
          <p className={styles['card-description']}>{description}</p>
        </div>
        <div className={styles['card-status']}>
          <span className={clsx(styles['status-icon'], styles[status.state])}>{statusIcon}</span>
          <span className={clsx(styles['status-badge'], styles[status.state])}>{statusText}</span>
        </div>
      </div>

      {/* 连接信息 */}
      {status.state === 'connected' && status.connectedDuration !== undefined && (
        <div className={styles['card-detail']}>
          <span className={styles['detail-label']}>连接时长:</span>
          <span className={styles['detail-value']}>{formatDuration(status.connectedDuration)}</span>
        </div>
      )}

      {status.state === 'disconnected' && status.lastConnectedAt && (
        <div className={styles['card-detail']}>
          <span className={styles['detail-label']}>上次连接:</span>
          <span className={styles['detail-value']}>
            {new Date(status.lastConnectedAt).toLocaleString('zh-CN')}
          </span>
        </div>
      )}

      {/* 错误信息 */}
      {status.state === 'error' && status.errorMessage && (
        <div className={styles['card-error']}>
          <span className={styles['error-label']}>错误:</span>
          <p className={styles['error-message']}>{status.errorMessage}</p>
        </div>
      )}

      {/* 操作按钮 */}
      <div className={styles['card-actions']}>
        {(status.state === 'disconnected' || status.state === 'error') && onConnect && (
          <button className={clsx(styles['action-btn'], styles['connect-btn'])} onClick={onConnect}>
            <span className={styles['btn-icon']}>↻</span>
            连接
          </button>
        )}

        {status.state === 'connected' && onDisconnect && (
          <button className={clsx(styles['action-btn'], styles['disconnect-btn'])} onClick={onDisconnect}>
            <span className={styles['btn-icon']}>✕</span>
            断开
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * DualConnectionStatus 组件 - 双连接状态显示
 *
 * 显示 UI 和 Node 两个连接的状态
 * 支持独立控制每个连接
 * 支持批量操作(连接所有/断开所有)
 */
export const DualConnectionStatus: React.FC<DualConnectionStatusProps> = ({
  gatewayUrl,
  uiConnection,
  nodeConnection,
  onConnectAll,
  onDisconnectAll,
  onConnectUI,
  onDisconnectUI,
  onConnectNode,
  onDisconnectNode,
}) => {
  // 判断是否所有连接都已连接
  const allConnected = uiConnection.state === 'connected' && nodeConnection.state === 'connected'

  // 判断是否所有连接都已断开
  const allDisconnected =
    uiConnection.state === 'disconnected' && nodeConnection.state === 'disconnected'

  return (
    <div className={styles['dual-connection-status']}>
      {/* 头部 */}
      <div className={styles['status-header']}>
        <div className={styles['header-info']}>
          <h3 className={styles['header-title']}>连接状态</h3>
          {gatewayUrl && (
            <div className={styles['header-detail']}>
              <span className={styles['detail-label']}>Gateway:</span>
              <code className={styles['detail-value']}>{gatewayUrl}</code>
            </div>
          )}
        </div>

        {/* 批量操作按钮 */}
        <div className={styles['header-actions']}>
          {!allConnected && onConnectAll && (
            <button className={clsx(styles['action-btn'], styles['primary-btn'])} onClick={onConnectAll}>
              <span className={styles['btn-icon']}>⚡</span>
              连接所有
            </button>
          )}

          {!allDisconnected && onDisconnectAll && (
            <button className={clsx(styles['action-btn'], styles['secondary-btn'])} onClick={onDisconnectAll}>
              <span className={styles['btn-icon']}>✕</span>
              断开所有
            </button>
          )}
        </div>
      </div>

      {/* 连接卡片 */}
      <div className={styles['connection-cards']}>
        <ConnectionCard
          title="UI 连接"
          description="用户界面通信连接,处理 UI 交互和会话管理"
          status={uiConnection}
          onConnect={onConnectUI}
          onDisconnect={onDisconnectUI}
        />

        <ConnectionCard
          title="Node 连接"
          description="设备节点连接,处理命令执行和文件操作"
          status={nodeConnection}
          onConnect={onConnectNode}
          onDisconnect={onDisconnectNode}
        />
      </div>

      {/* 状态说明 */}
      <div className={styles['status-info']}>
        <p className={styles['info-text']}>
          <span className={styles['info-icon']}>ℹ</span>
          UI 连接和 Node 连接可以独立管理。UI 连接用于界面交互,Node 连接用于命令执行。
        </p>
      </div>
    </div>
  )
}

export default DualConnectionStatus
