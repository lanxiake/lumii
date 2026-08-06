/**
 * UsageChart - 调用分布柱状图（原型 .uchart）
 *
 * 原型按模型堆叠分色，但本地用量库当前只按时间桶聚合（不含 per-model 拆分），
 * 因此这里是单色柱。要分色得先让 usage-store 聚合出模型维度，届时再加。
 */

import React from 'react'
import type { UsageBucketView } from '../../../../hooks/business/useDashboard'
import styles from './UsageChart.module.css'

export interface UsageChartProps {
  buckets: readonly UsageBucketView[]
  groupBy: 'hour' | 'day'
}

function labelOf(ts: number, groupBy: 'hour' | 'day'): string {
  const d = new Date(ts)
  return groupBy === 'hour'
    ? `${String(d.getHours()).padStart(2, '0')}:00`
    : `${d.getMonth() + 1}/${d.getDate()}`
}

export const UsageChart: React.FC<UsageChartProps> = ({ buckets, groupBy }) => {
  if (buckets.length === 0) {
    return <div className={styles.empty}>该区间还没有调用记录</div>
  }

  const max = Math.max(...buckets.map((b) => b.calls))
  return (
    <div className={styles.chart}>
      {buckets.map((b) => (
        <div
          key={b.ts}
          className={styles.col}
          title={`${labelOf(b.ts, groupBy)} · ${b.calls} 次 · ${(
            b.promptTokens + b.completionTokens
          ).toLocaleString()} tokens`}
        >
          {/* 最小 2% 高度，保证「有调用但很少」的桶不会看起来是空的 */}
          <span style={{ height: `${Math.max(2, (b.calls / max) * 100)}%` }} />
        </div>
      ))}
    </div>
  )
}

export default UsageChart
