/**
 * DashboardPage - 概览页
 *
 * 一屏不滚动：页头 + 运行时条（三环 + 装载 chip）+ 最近资讯卡片 + 底部「近期关注 / 虚拟人」双栏。
 * 指标来自本机采集：CPU/内存/磁盘 走 system-service，MCP 走 mcp:status，
 * 资讯来自「资讯抓取与综述」定时任务写下的 ~/.lumii/news/latest.json。
 * 用量与花费是事后对账信息，已移到设置中心，不占概览的一屏。
 */

import React from 'react'
import { Boxes, Wrench } from 'lucide-react'
import { Card } from '../../components/ui/Card/Card'
import { Button } from '../../components/ui/Button/Button'
import { ErrorBanner } from '../../components/ui/ErrorBanner/ErrorBanner'
import { useDashboard } from '../../hooks/business/useDashboard'
import { useMcpServers } from '../../components/McpServersPanel/useMcpServers'
import type { ViewType } from '../../components/layout/Sidebar/Sidebar'
import { Gauge } from './components/Gauge'
import { RecentFocus } from './components/RecentFocus'
import { NewsFeed } from './components/NewsFeed'
import { VirtualHuman } from './components/VirtualHuman'
import { sparkBars } from './spark-heights'
import clsx from 'clsx'
import styles from './DashboardPage.module.css'

function formatGb(bytes: number | undefined): string {
  if (!bytes) return '—'
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export interface DashboardPageProps {
  /** 视图切换回调 */
  onViewChange?: (view: ViewType) => void
}

const DashboardPage: React.FC<DashboardPageProps> = ({ onViewChange }) => {
  const { gauges, skillStats, usage, isRefreshing, error, refresh } = useDashboard()
  const { servers: mcpServers } = useMcpServers()

  const mcpConnected = mcpServers.filter((s) => s.connected).length
  const mcpTotal = mcpServers.length
  const spark = sparkBars(usage?.buckets ?? [], usage?.groupBy ?? 'hour')

  return (
    <div className={styles['dashboard-page']}>
      <div className={styles['page-head']}>
        <div>
          <h1 className={styles['page-title']}>概览</h1>
          <div className={styles['page-sub']}>
            <span className={styles.dot} />
            本地运行正常 · 全部数据来自本机采集
            {usage ? <> · 已记录 <b>{usage.totalCalls}</b> 次调用</> : null}
          </div>
        </div>
        <div className={styles['page-actions']}>
          <Button onClick={refresh} loading={isRefreshing} variant="secondary">
            刷新
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error instanceof Error ? error.message : String(error)} />}

      {/* 运行时条：三环仪表 + 装载统计 + 调用节律微图 */}
      <Card className={styles.runtime} flush overflowVisible>
        <div className={styles['rt-info']}>
          <div className={styles['rt-title']}>运行时态势</div>
          <div className={styles['rt-desc']}>
            {gauges.cpuModel ?? '处理器信息读取中'}
            {gauges.cpuCores ? ` · ${gauges.cpuCores} 核` : ''}
            {gauges.totalMemory ? ` · ${formatGb(gauges.totalMemory)}` : ''}
          </div>
        </div>

        <div className={styles.spark} role="img" aria-label="近期调用节律">
          {spark.map((bar, i) => (
            <i
              key={i}
              style={{ height: `${bar.height}%` }}
              data-tip={bar.title}
            />
          ))}
        </div>

        <div className={styles['rt-stats']}>
          <button
            type="button"
            className={clsx(styles['rt-stat'], styles['t-b'])}
            onClick={() => onViewChange?.('skills')}
            title="进入技能管理"
          >
            <span className={styles['rt-stat-icon']} aria-hidden="true">
              <Wrench size={14} strokeWidth={1.8} />
            </span>
            <span className={styles['rt-stat-body']}>
              <span className={styles['rt-stat-label']}>技能</span>
              <span className={styles['rt-stat-value']}>
                <b>{skillStats.installed}</b>
                <em>已安装</em>
              </span>
            </span>
          </button>
          <button
            type="button"
            className={clsx(styles['rt-stat'], styles['t-a'])}
            onClick={() => onViewChange?.('mcp')}
            title="进入 MCP 管理"
          >
            <span className={styles['rt-stat-icon']} aria-hidden="true">
              <Boxes size={14} strokeWidth={1.8} />
            </span>
            <span className={styles['rt-stat-body']}>
              <span className={styles['rt-stat-label']}>MCP</span>
              <span className={styles['rt-stat-value']}>
                <b>{mcpConnected}</b>
                <em>/ {mcpTotal} 在线</em>
              </span>
            </span>
          </button>
        </div>

        <div className={styles['rt-gauges']}>
          <Gauge
            value={gauges.cpuPercent}
            label="CPU"
            tone="var(--mt-tone-a)"
            title={gauges.cpuModel ? `${gauges.cpuModel}（${gauges.cpuCores ?? '?'} 核）` : undefined}
          />
          <Gauge
            value={gauges.memoryPercent}
            label="内存"
            tone="var(--mt-tone-b)"
            title={
              gauges.usedMemory && gauges.totalMemory
                ? `${formatGb(gauges.usedMemory)} / ${formatGb(gauges.totalMemory)}`
                : undefined
            }
          />
          <Gauge
            value={gauges.diskPercent}
            label="磁盘"
            tone="var(--mt-tone-d)"
            title="系统盘占用"
          />
        </div>
      </Card>

      {/* 最近资讯：点卡片把解读请求预填进对话页 */}
      <NewsFeed onViewChange={onViewChange} />

      {/* 底部：近期关注 + 虚拟人 */}
      <div className={styles['bottom-grid']}>
        <RecentFocus onViewChange={onViewChange} />
        <VirtualHuman />
      </div>
    </div>
  )
}

export { DashboardPage }
export default DashboardPage
