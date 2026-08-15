/**
 * UsagePanel - 用量与花费（设置中心 › 用量与花费）
 *
 * 原先长在概览页，但它是「事后对账」型信息，不该占概览的一屏；搬到设置里后
 * 不再需要折叠，主数字 + 明细图表一次全展开。
 * 视觉对齐 demos/ui-tech-refresh「使用统计」：彩色圆形图标、入/出分格、花费绿色。
 * 数据仍走 usage:query（~/.lumii/usage/*.jsonl），本地估价，不上传。
 */

import React from 'react'
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleDollarSign,
  TrendingUp,
  Zap,
} from 'lucide-react'
import { useDashboard, type UsageRange } from '../../../../hooks/business/useDashboard'
import { UsageChart } from '../../../DashboardPage/components/UsageChart'
import { formatCostCny as formatCost } from '../../../../../shared/model-pricing'

/** 模型 id 去掉 provider 前缀，展示更短 */
function shortModel(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}
import clsx from 'clsx'
import styles from './UsagePanel.module.css'

const RANGE_LABELS: ReadonlyArray<{ id: UsageRange; label: string }> = [
  { id: 'today', label: '今日' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
]

/** 紧凑 Token 数（K / M） */
function formatTokens(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

/** 主数字旁的「约合万」副标，贴近参考图 ≈ xxxx 万 */
function formatTokensApprox(n: number | undefined): string | null {
  if (n === undefined || n < 10_000) return null
  return `≈ ${(n / 10_000).toFixed(2)} 万`
}

/** 主数字千分位，大数一眼可读 */
function formatTokensExact(n: number | undefined): string {
  if (n === undefined) return '—'
  return n.toLocaleString('en-US')
}

export const UsagePanel: React.FC = () => {
  const { usage, usageRange, setUsageRange } = useDashboard()

  const totalTokens = usage ? usage.totalPromptTokens + usage.totalCompletionTokens : undefined
  // 有计价样本才展示花费；全未计价时显示「—」，避免把缺价误当成 0 元
  const hasPricedSample =
    !!usage && usage.totalCalls > 0 && usage.unpricedCalls < usage.totalCalls
  const displayCost = hasPricedSample ? usage!.totalCostCents : undefined
  const avgCost = hasPricedSample ? usage!.totalCostCents / usage!.totalCalls : undefined
  const peakBucket = usage?.buckets.reduce<{ costCents: number } | undefined>(
    (max, b) => (max === undefined || b.costCents > max.costCents ? b : max),
    undefined,
  )
  const displayPeak = hasPricedSample ? peakBucket?.costCents : undefined
  const displayAvgBucket =
    hasPricedSample && usage!.buckets.length > 0
      ? usage!.totalCostCents / usage!.buckets.length
      : undefined
  // 已计价占比：未计价的调用没有花费数据，轨道满格才代表花费统计是完整的
  const pricedRatio =
    usage && usage.totalCalls > 0
      ? ((usage.totalCalls - usage.unpricedCalls) / usage.totalCalls) * 100
      : 0
  const approx = formatTokensApprox(totalTokens)

  // 图表下方总结：按花费排名，最多取 5 个模型
  const models = usage?.byModel ?? []
  const topModels = models.slice(0, 5)
  const topCostModel = hasPricedSample
    ? models.find((m) => m.costCents > 0)
    : undefined
  const topCallsModel = models.reduce<(typeof models)[number] | undefined>(
    (max, m) => (max === undefined || m.calls > max.calls ? m : max),
    undefined,
  )

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
          <div className={styles['hero-icon']} aria-hidden>
            <Zap size={18} strokeWidth={2.2} />
          </div>
          <div className={styles['hero-body']}>
            <div className={styles['hero-k']}>Token 总用量</div>
            <div className={styles['hero-v-row']}>
              <span className={styles['hero-v']}>{formatTokensExact(totalTokens)}</span>
              {approx ? <span className={styles['hero-approx']}>{approx}</span> : null}
            </div>
            <div className={styles.chips}>
              <div className={styles.chip}>
                <span className={clsx(styles['chip-ic'], styles['chip-ic--in'])}>
                  <ArrowDownToLine size={12} strokeWidth={2.2} />
                </span>
                <span className={styles['chip-lab']}>输入</span>
                <b className={styles['chip-val']}>{formatTokens(usage?.totalPromptTokens)}</b>
              </div>
              <div className={styles.chip}>
                <span className={clsx(styles['chip-ic'], styles['chip-ic--out'])}>
                  <ArrowUpFromLine size={12} strokeWidth={2.2} />
                </span>
                <span className={styles['chip-lab']}>输出</span>
                <b className={styles['chip-val']}>{formatTokens(usage?.totalCompletionTokens)}</b>
              </div>
            </div>
          </div>
        </div>

        <div className={styles['sum-grid']}>
          <div className={styles.stat}>
            <div className={styles['stat-k']}>
              <span className={clsx(styles['stat-ic'], styles['stat-ic--req'])}>
                <Activity size={12} strokeWidth={2.2} />
              </span>
              请求次数
            </div>
            <div className={styles['stat-v']}>{usage?.totalCalls ?? '—'}</div>
          </div>
          <div className={styles.stat}>
            <div className={styles['stat-k']}>
              <span className={clsx(styles['stat-ic'], styles['stat-ic--cost'])}>
                <CircleDollarSign size={12} strokeWidth={2.2} />
              </span>
              花费
            </div>
            <div className={clsx(styles['stat-v'], styles['stat-v--cost'])}>
              {formatCost(displayCost)}
            </div>
          </div>
          <div className={styles.stat}>
            <div className={styles['stat-k']}>
              <span className={clsx(styles['stat-ic'], styles['stat-ic--avg'])}>
                <TrendingUp size={12} strokeWidth={2.2} />
              </span>
              平均每次
            </div>
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
            <div className={styles['stat-v']}>{formatCost(displayAvgBucket)}</div>
          </div>
          <div className={styles.stat}>
            <div className={styles['stat-k']}>
              {usageRange === 'today' ? '花费最高小时' : '花费最高一天'}
            </div>
            <div className={styles['stat-v']}>{formatCost(displayPeak)}</div>
          </div>
        </div>

        <div className={styles.subhead}>
          <span>使用趋势</span>
          <span className={styles.meta}>{usage?.groupBy === 'day' ? '按天' : '按小时'}</span>
        </div>
        <UsageChart buckets={usage?.buckets ?? []} groupBy={usage?.groupBy ?? 'hour'} />

        {topModels.length > 0 ? (
          <div className={styles.models}>
            <div className={styles.subhead}>
              <span>模型明细</span>
              <span className={styles.meta}>共 {models.length} 个模型</span>
            </div>
            <div className={styles['models-lead']}>
              本区间共调用 <b>{usage?.totalCalls ?? 0}</b> 次。
              {topCallsModel ? (
                <>
                  {' '}
                  请求最多的是 <b>{shortModel(topCallsModel.model)}</b>（
                  {topCallsModel.calls} 次）。
                </>
              ) : null}
              {topCostModel ? (
                <>
                  {' '}
                  花费最多的是 <b>{shortModel(topCostModel.model)}</b>，约{' '}
                  <span className={styles.cost}>{formatCost(topCostModel.costCents)}</span>。
                </>
              ) : null}
            </div>
            <div className={styles.mlist}>
              {topModels.map((m, i) => (
                <div
                  key={m.model}
                  className={clsx(styles.mrow, i === 0 && styles['mrow--top'])}
                >
                  <span className={styles.mrank}>{i + 1}</span>
                  <span className={styles.mname} title={m.model}>
                    {shortModel(m.model)}
                  </span>
                  <span className={styles.mmetric}>
                    <b>{m.calls}</b>次
                  </span>
                  <span className={styles.mmetric}>
                    <b>{formatTokens(m.promptTokens + m.completionTokens)}</b>Tokens
                  </span>
                  <span className={clsx(styles.mmetric, styles['mmetric--cost'])}>
                    <b>
                      {m.unpricedCalls === m.calls && m.costCents === 0
                        ? '—'
                        : formatCost(m.costCents)}
                    </b>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

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
