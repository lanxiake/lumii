/**
 * DashboardPage - 仪表盘页面
 *
 * 基于 DashboardView.tsx 重构
 * 使用 useDashboard hook 获取真实数据
 */

import React from 'react'
import { CheckCircle, Monitor, Wrench, Zap, Layers, MessageSquare } from 'lucide-react'
import { Card } from '../../components/ui/Card/Card'
import { Button } from '../../components/ui/Button/Button'
import { PageHeader } from '../../components/ui/PageHeader/PageHeader'
import { ErrorBanner } from '../../components/ui/ErrorBanner/ErrorBanner'
import { useAuth } from '../../contexts/AuthContext/AuthContext'
import { useDashboard } from '../../hooks/business/useDashboard'
import type { ViewType } from '../../components/layout/Sidebar/Sidebar'
import clsx from 'clsx'
import styles from './DashboardPage.module.css'

function getUsageLevel(current: number, limit: number): string {
  if (limit <= 0) return 'low'
  const percent = (current / limit) * 100
  if (percent >= 80) return 'high'
  if (percent >= 50) return 'medium'
  return 'low'
}

function formatUsage(current: number, limit: number): string {
  if (limit <= 0) return `${current} / 无限制`
  return `${current} / ${limit}`
}

export interface DashboardPageProps {
  /** 显示名称（可选，从 user 获取） */
  displayName?: string
  /** 视图切换回调 */
  onViewChange?: (view: ViewType) => void
}

const DashboardPage: React.FC<DashboardPageProps> = ({ onViewChange }) => {
  const { user } = useAuth()
  const {
    subscription,
    planName,
    usage,
    deviceCount,
    skillStats,
    daysRemaining,
    isLoading,
    isRefreshing,
    error,
    refresh,
  } = useDashboard()

  const safeDeviceCount = deviceCount ?? 0
  const deviceLimit = 5
  const dailyCalls = usage?.conversationsUsed ?? 0
  const dailyCallLimit = usage?.conversationsLimit ?? 0

  // if (isLoading) {
  //   return (
  //     <div className="dashboard-page">
  //       <Loading text="加载仪表盘数据..." />
  //     </div>
  //   )
  // }

  return (
    <div className={styles['dashboard-page']}>
      {/* 欢迎区域 */}
      <PageHeader
        title={`欢迎回来${user?.displayName ? `，${user.displayName}` : ''}`}
        subtitle={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <CheckCircle size={16} className={styles['status-icon-ok']} /> 本地运行正常
          </span>
        }
        actions={
          <Button onClick={refresh} loading={isRefreshing} variant="secondary">
            刷新
          </Button>
        }
      />

      {/* 错误提示 */}
      {error && (
        <ErrorBanner
          message={error instanceof Error ? error.message : String(error)}
        />
      )}

      {/* 统计卡片网格 */}
      <div className={styles['stats-grid']}>
        {/* 设备卡片 */}
        <Card className={styles['stat-card']}>
          <div className={styles['stat-card-header']}>
            <div className={clsx(styles['stat-icon'], styles['devices'])}><Monitor size={20} className={styles['stat-icon-svg']} /></div>
            <span className={styles['stat-label']}>已连接设备</span>
          </div>
          <div className={styles['stat-value']}>{safeDeviceCount}</div>
          <div className={styles['stat-sub']}>{formatUsage(safeDeviceCount, deviceLimit)}</div>
          <div className={styles['usage-bar']}>
            <div
              className={clsx(styles['usage-fill'], styles[getUsageLevel(safeDeviceCount, deviceLimit)])}
              style={{ width: `${Math.min(100, (safeDeviceCount / deviceLimit) * 100)}%` }}
            />
          </div>
        </Card>

        {/* 技能卡片 */}
        <Card className={styles['stat-card']}>
          <div className={styles['stat-card-header']}>
            <div className={clsx(styles['stat-icon'], styles['skills'])}><Wrench size={20} className={styles['stat-icon-svg']} /></div>
            <span className={styles['stat-label']}>已安装技能</span>
          </div>
          <div className={styles['stat-value']}>{skillStats.installed}</div>
          <div className={styles['stat-sub']}>{formatUsage(skillStats.installed, skillStats.limit)}</div>
          {skillStats.limit > 0 && (
            <div className={styles['usage-bar']}>
              <div
                className={clsx(styles['usage-fill'], styles[getUsageLevel(skillStats.installed, skillStats.limit)])}
                style={{ width: `${Math.min(100, (skillStats.installed / skillStats.limit) * 100)}%` }}
              />
            </div>
          )}
        </Card>

        {/* 今日调用卡片 */}
        <Card className={styles['stat-card']}>
          <div className={styles['stat-card-header']}>
            <div className={clsx(styles['stat-icon'], styles['calls'])}><Zap size={20} className={styles['stat-icon-svg']} /></div>
            <span className={styles['stat-label']}>今日调用</span>
          </div>
          <div className={styles['stat-value']}>{dailyCalls}</div>
          <div className={styles['stat-sub']}>{formatUsage(dailyCalls, dailyCallLimit)}</div>
          {dailyCallLimit > 0 && (
            <div className={styles['usage-bar']}>
              <div
                className={clsx(styles['usage-fill'], styles[getUsageLevel(dailyCalls, dailyCallLimit)])}
                style={{ width: `${Math.min(100, (dailyCalls / dailyCallLimit) * 100)}%` }}
              />
            </div>
          )}
        </Card>

        {/* 订阅卡片 */}
        <Card className={styles['stat-card']}>
          <div className={styles['stat-card-header']}>
            <div className={clsx(styles['stat-icon'], styles['plan'])}><Layers size={20} className={styles['stat-icon-svg']} /></div>
            <span className={styles['stat-label']}>当前订阅</span>
          </div>
          <div className={styles['stat-value']}>{planName}</div>
          <div className={styles['stat-sub']}>
            {subscription
              ? daysRemaining > 0 ? `剩余 ${daysRemaining} 天` : '已到期'
              : '未订阅'}
          </div>
        </Card>
      </div>

      {/* 快捷操作 */}
      <div className={styles['quick-actions']}>
        <h2>快捷操作</h2>
        <div className={styles['quick-actions-grid']}>
          <button className={styles['quick-action-card']} onClick={() => onViewChange?.('skills')}>
            <div className={styles['quick-action-icon']}><Wrench size={24} className={styles['stat-icon-svg']} /></div>
            <div className={styles['quick-action-title']}>浏览技能商店</div>
            <div className={styles['quick-action-desc']}>发现和安装新技能</div>
          </button>

          <button className={styles['quick-action-card']} onClick={() => onViewChange?.('chat')}>
            <div className={styles['quick-action-icon']}><MessageSquare size={24} className={styles['stat-icon-svg']} /></div>
            <div className={styles['quick-action-title']}>开始对话</div>
            <div className={styles['quick-action-desc']}>与 AI 助手开始对话</div>
          </button>
        </div>
      </div>
    </div>
  )
}

export { DashboardPage }
export default DashboardPage
