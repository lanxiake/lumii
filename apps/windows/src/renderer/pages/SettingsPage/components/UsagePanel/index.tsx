/**
 * UsagePanel - 用量与花费（设置中心 › 用量与花费）
 *
 * 原先长在概览页，但它是「事后对账」型信息，不该占概览的一屏；搬到设置里后
 * 不再需要折叠，主数字 + 三格 + 明细图表一次全展开。
 * 数据仍走 usage:query（~/.lumii/usage/*.jsonl），本地估价，不上传。
 */

import React from 'react'
import { Coins, Zap } from 'lucide-react'
import { useDashboard, type UsageRange } from '../../../../hooks/business/useDashboard'
import { UsageChart } from '../../../DashboardPage/components/UsageChart'
import { formatCostCny as formatCost } from '../../../../../shared/model-pricing'
import clsx from 'clsx'
import styles from './UsagePanel.module.css'

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

export const UsagePanel: React.FC = () => {
  const { usage, usageRange, setUsageRange } = useDashboard()

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
  // 已计价占比：未计价的调用没有花费数据，轨道满格才代表花费统计是完整的
  const pricedRatio =
    usage && usage.totalCalls > 0
      ? ((usage.totalCalls - usage.unpricedCalls) / usage.totalCalls) * 100
      : 0

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.title}>用量与花费</span>
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

      <div className={styles.summary}>
        <div className={styles.hero}>
          <div className={styles['hero-k']}>
            <Coins size={12} strokeWidth={1.8} />
            Token 总用量
          </div>
          <div className={styles['hero-v']}>{formatTokens(totalTokens)}</div>
          <div className={styles['hero-sub']}>
            入 {formatTokens(usage?.totalPromptTokens)} · 出{' '}
            {formatTokens(usage?.totalCompletionTokens)}
          </div>
        </div>

        <div className={styles['sum-grid']}>
          <div className={styles.stat}>
            <div className={styles['stat-k']}>
              <Zap size={11} strokeWidth={1.8} />
              请求次数
            </div>
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

        <div className={styles.priced}>
          <div className={styles['priced-line']}>
            <span>已计价占比</span>
            <b>{Math.round(pricedRatio)}%</b>
          </div>
          <div className={styles.trk}>
            <i style={{ width: `${pricedRatio}%` }} />
          </div>
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles['stat-row']}>
          <div className={styles.stat}>
            <div className={styles['stat-k']}>
              {usageRange === 'today' ? '时均花费' : '日均花费'}
            </div>
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

        <div className={styles.subhead}>
          <span>调用分布</span>
          <span className={styles.meta}>{usage?.groupBy === 'day' ? '按天' : '按小时'}</span>
        </div>
        <UsageChart buckets={usage?.buckets ?? []} groupBy={usage?.groupBy ?? 'hour'} />

        <div className={styles.footnote}>
          花费按<b>各模型公开单价</b>本地估算，仅供参考；本地模型不计费。记录写在{' '}
          <code>~/.lumii/usage/</code>，按月分片，不上传。
          {usage && usage.unpricedCalls > 0
            ? ` 其中 ${usage.unpricedCalls} 次调用价格未知，未计入花费。`
            : ''}
        </div>
      </div>
    </div>
  )
}

export default UsagePanel
