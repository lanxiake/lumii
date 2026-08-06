/**
 * DashboardPage - 概览页
 *
 * 对齐原型 `.hero` + `.grid4` + 用量面板。全部指标来自本机采集：
 * CPU/内存/磁盘 走 system-service，调用/token/花费走 ~/.lumii/usage/*.jsonl。
 * 没有采集来源的指标显示「—」，不填 0 冒充（MCP 尚未立项，见计划 Task 4.5）。
 */

import React from 'react'
import { Boxes, Wrench, Zap, Coins } from 'lucide-react'
import { Card } from '../../components/ui/Card/Card'
import { Button } from '../../components/ui/Button/Button'
import { ErrorBanner } from '../../components/ui/ErrorBanner/ErrorBanner'
import { useDashboard } from '../../hooks/business/useDashboard'
import type { UsageRange } from '../../hooks/business/useDashboard'
import type { ViewType } from '../../components/layout/Sidebar/Sidebar'
import { Gauge } from './components/Gauge'
import { UsageChart } from './components/UsageChart'
import { RecentFocus } from './components/RecentFocus'
import { sparkHeights } from './spark-heights'
import { formatCostCny as formatCost } from '../../../shared/model-pricing'
import clsx from 'clsx'
import styles from './DashboardPage.module.css'

const RANGE_LABELS: ReadonlyArray<{ id: UsageRange; label: string }> = [
  { id: 'today', label: '今日' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
]

function formatTokens(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatGb(bytes: number | undefined): string {
  if (!bytes) return '—'
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}


export interface DashboardPageProps {
  /** 视图切换回调 */
  onViewChange?: (view: ViewType) => void
}

const DashboardPage: React.FC<DashboardPageProps> = ({ onViewChange }) => {
  const {
    gauges,
    skillStats,
    usage,
    usageRange,
    setUsageRange,
    isRefreshing,
    error,
    refresh,
  } = useDashboard()

  const totalTokens = usage ? usage.totalPromptTokens + usage.totalCompletionTokens : undefined
  // 全部调用都未计价时，均价没有意义，显示「—」而不是 0
  const avgCost =
    usage && usage.totalCalls > 0 && usage.unpricedCalls < usage.totalCalls
      ? usage.totalCostCents / usage.totalCalls
      : undefined
  const peakBucket = usage?.buckets.reduce<{ costCents: number } | undefined>(
    (max, b) => (max === undefined || b.costCents > max.costCents ? b : max),
    undefined,
  )
  const spark = sparkHeights(usage?.buckets ?? [])
  const peakCalls = usage?.buckets.reduce<number | undefined>(
    (max, b) => (max === undefined || b.calls > max ? b.calls : max),
    undefined,
  )
  // 已计价占比：未计价的调用没有花费数据，轨道满格才代表花费统计是完整的
  const pricedRatio =
    usage && usage.totalCalls > 0
      ? ((usage.totalCalls - usage.unpricedCalls) / usage.totalCalls) * 100
      : 0
  const outputRatio =
    totalTokens && totalTokens > 0 ? ((usage?.totalCompletionTokens ?? 0) / totalTokens) * 100 : 0

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
          {/* 延迟只在底栏 HUD 出现一次，这里放技能数（计划 Task 2.2 / 3.2） */}
          <span className={styles.chip}>
            <span className={styles.dot} />
            {skillStats.installed} 个技能装载
          </span>
          <Button onClick={refresh} loading={isRefreshing} variant="secondary">
            刷新
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error instanceof Error ? error.message : String(error)} />}

      {/* 运行时态势：左文案 + 右三环仪表 */}
      <Card className={styles.hero} flush>
        <div className={styles['hero-info']}>
          <div className={styles['hero-title']}>运行时态势</div>
          <div className={styles['hero-desc']}>
            {gauges.cpuModel ?? '处理器信息读取中'}
            {gauges.cpuCores ? ` · ${gauges.cpuCores} 核` : ''}
            {gauges.totalMemory ? ` · 内存 ${formatGb(gauges.totalMemory)}` : ''}
            {` · ${skillStats.installed} 个技能装载`}
          </div>
          <div className={styles.spark} aria-hidden="true">
            {spark.map((h, i) => (
              <i key={i} style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
        <div className={styles['hero-gauges']}>
          <Gauge
            value={gauges.cpuPercent}
            label="CPU"
            title={gauges.cpuModel ? `${gauges.cpuModel}（${gauges.cpuCores ?? '?'} 核）` : undefined}
          />
          <Gauge
            value={gauges.memoryPercent}
            label="内存"
            title={
              gauges.usedMemory && gauges.totalMemory
                ? `${formatGb(gauges.usedMemory)} / ${formatGb(gauges.totalMemory)}`
                : undefined
            }
          />
          <Gauge value={gauges.diskPercent} label="磁盘" title="系统盘占用" />
        </div>
      </Card>

      {/* 四指标卡 */}
      <div className={styles['met-grid']}>
        <Card className={clsx(styles.met, styles['t-a'])} flush>
          <div className={styles['met-top']}>
            <div className={styles['met-title']}>
              <span className={styles['met-badge']}><Boxes size={16} strokeWidth={1.8} /></span>
              <div>
                <div className={styles['met-lab']}>MCP 服务</div>
                <div className={styles['met-sub']}>未接入</div>
              </div>
            </div>
          </div>
          <div className={styles['met-rows']}>
            <div className={styles['met-row']}>
              <span className={styles['met-k']}>已连接</span>
              <span className={styles['met-v']}>—</span>
            </div>
          </div>
          <div className={styles['met-note']}>MCP 模块尚未接入</div>
        </Card>

        <Card
          className={clsx(styles.met, styles['t-b'], styles['met--clickable'])}
          onClick={() => onViewChange?.('skills')}
          flush
        >
          <div className={styles['met-top']}>
            <div className={styles['met-title']}>
              <span className={styles['met-badge']}><Wrench size={16} strokeWidth={1.8} /></span>
              <div>
                <div className={styles['met-lab']}>已安装技能</div>
                <div className={styles['met-sub']}>本机磁盘</div>
              </div>
            </div>
          </div>
          <div className={styles['met-rows']}>
            <div className={styles['met-row']}>
              <span className={styles['met-k']}>已装载</span>
              <span className={styles['met-v']}>{skillStats.installed}</span>
            </div>
          </div>
          <div className={styles['met-note']}>点击进入技能管理</div>
        </Card>

        <Card className={clsx(styles.met, styles['t-c'])} flush>
          <div className={styles['met-top']}>
            <div className={styles['met-title']}>
              <span className={styles['met-badge']}><Zap size={16} strokeWidth={1.8} /></span>
              <div>
                <div className={styles['met-lab']}>调用次数</div>
                <div className={styles['met-sub']}>
                  {RANGE_LABELS.find((r) => r.id === usageRange)?.label}
                </div>
              </div>
            </div>
          </div>
          <div className={styles['met-rows']}>
            <div className={styles['met-row']}>
              <span className={styles['met-k']}>请求次数</span>
              <span className={styles['met-v']}>{usage?.totalCalls ?? '—'}</span>
            </div>
            <div className={styles['met-row']}>
              <span className={styles['met-k']}>
                {usage?.groupBy === 'day' ? '单日峰值' : '单小时峰值'}
              </span>
              <span className={clsx(styles['met-v'], styles['met-v--sm'])}>{peakCalls ?? '—'}</span>
            </div>
          </div>
          <div className={styles['met-foot']}>
            <div className={styles.trk}>
              <i style={{ width: `${pricedRatio}%` }} />
            </div>
          </div>
        </Card>

        <Card className={clsx(styles.met, styles['t-d'])} flush>
          <div className={styles['met-top']}>
            <div className={styles['met-title']}>
              <span className={styles['met-badge']}><Coins size={16} strokeWidth={1.8} /></span>
              <div>
                <div className={styles['met-lab']}>Token 用量</div>
                <div className={styles['met-sub']}>入 / 出</div>
              </div>
            </div>
          </div>
          <div className={styles['met-rows']}>
            <div className={styles['met-row']}>
              <span className={styles['met-k']}>合计</span>
              <span className={styles['met-v']}>{formatTokens(totalTokens)}</span>
            </div>
            <div className={styles['met-row']}>
              <span className={styles['met-k']}>输出</span>
              <span className={clsx(styles['met-v'], styles['met-v--sm'])}>
                {formatTokens(usage?.totalCompletionTokens)}
              </span>
            </div>
          </div>
          <div className={styles['met-foot']}>
            {/* 轨道表示输出占比：越靠右说明生成量相对输入越大 */}
            <div className={styles.trk}>
              <i style={{ width: `${outputRatio}%` }} />
            </div>
          </div>
        </Card>
      </div>

      {/* 用量与花费 */}
      <div className={styles['panel-grid']}>
        <Card className={styles.panel} flush>
          <div className={styles['panel-head']}>
            <span className={styles['panel-title']}>用量与花费</span>
            <div className={styles.seg} role="tablist" aria-label="用量时间区间">
              {RANGE_LABELS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="tab"
                  aria-selected={usageRange === r.id}
                  className={clsx(styles['seg-btn'], usageRange === r.id && styles['seg-btn--on'])}
                  onClick={() => setUsageRange(r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles['stat-row']}>
            <div className={styles.stat}>
              <div className={styles['stat-k']}>请求次数</div>
              <div className={styles['stat-v']}>{usage?.totalCalls ?? '—'}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles['stat-k']}>花费</div>
              <div className={clsx(styles['stat-v'], styles['stat-v--accent'])}>
                {formatCost(usage?.totalCostCents)}
              </div>
            </div>
            <div className={styles.stat}>
              <div className={styles['stat-k']}>平均每次</div>
              <div className={styles['stat-v']}>{formatCost(avgCost)}</div>
            </div>
          </div>

          <div className={styles['panel-subhead']}>
            <span>调用分布</span>
            <span className={styles['panel-meta']}>{formatTokens(totalTokens)} tokens</span>
          </div>
          <UsageChart buckets={usage?.buckets ?? []} groupBy={usage?.groupBy ?? 'hour'} />

          <div className={styles.footnote}>
            花费按<b>各模型公开单价</b>本地估算，仅供参考；本地模型不计费。
            {usage && usage.unpricedCalls > 0
              ? ` 其中 ${usage.unpricedCalls} 次调用价格未知，未计入花费。`
              : ''}
          </div>
        </Card>

        <Card className={styles.panel} flush>
          <div className={styles['panel-head']}>
            <span className={styles['panel-title']}>花费概况</span>
            <span className={styles['panel-meta']}>
              {usageRange === 'today' ? '今日 · 按小时' : '按天'}
            </span>
          </div>
          <div className={styles['stat-row-2']}>
            <div className={styles.stat}>
              <div className={styles['stat-k']}>{usageRange === 'today' ? '时均花费' : '日均花费'}</div>
              <div className={styles['stat-v']}>
                {usage && usage.buckets.length > 0
                  ? formatCost(usage.totalCostCents / usage.buckets.length)
                  : '—'}
              </div>
            </div>
            <div className={styles.stat}>
              <div className={styles['stat-k']}>
                {usageRange === 'today' ? '花费最高小时' : '花费最高一天'}
              </div>
              <div className={styles['stat-v']}>{formatCost(peakBucket?.costCents)}</div>
            </div>
          </div>
          <div className={styles.footnote}>
            记录写在 <code>~/.lumii/usage/</code>，按月分片，不上传。
          </div>
        </Card>
      </div>

      {/* 近期关注 */}
      <RecentFocus onViewChange={onViewChange} />
    </div>
  )
}

export { DashboardPage }
export default DashboardPage
