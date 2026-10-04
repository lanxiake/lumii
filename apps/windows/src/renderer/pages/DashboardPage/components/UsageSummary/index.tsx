/**
 * UsageSummary - 概览页「用量」
 *
 * 只露三个关键数字：近 7 天调用次数 / Tokens / 花费。
 * 完整面板（切区间、按模型细分、趋势图）在设置中心 › 用量与花费（UsagePanel），
 * 概览这里不重复它那一屏。
 *
 * 数据走 `usage:query`（~/.lumii/usage/*.jsonl，本地估价，不上传）。
 * 刻意**不复用 useDashboard**：那个 hook 顺带每 3s 轮询系统信息与磁盘，
 * 概览页已经不需要这些读数了。
 */

import React, { useCallback, useMemo } from 'react'
import { Card } from '../../../../components/ui/Card/Card'
import { useQuery } from '../../../../hooks/common/useQuery'
import { queryUsage } from '../../../../services/usage-service'
import { formatCostYuan } from '../../../../../shared/model-pricing'
import type { UsageView } from '../../../../hooks/business/useDashboard/useDashboard.types'
import styles from './UsageSummary.module.css'

const RANGE_DAYS = 7

/** 近 7 天区间（含今天），与设置中心的默认区间口径一致 */
function resolve7dRange(): { from: number; to: number; groupBy: 'hour' | 'day' } {
  const now = new Date()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (RANGE_DAYS - 1))
  return { from: start.getTime(), to: now.getTime() + 1, groupBy: 'day' }
}

/** 紧凑 Token 数（K / M） */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export const UsageSummary: React.FC = () => {
  const range = useMemo(resolve7dRange, [])

  const fetchUsage = useCallback(async (): Promise<UsageView> => {
    const data = await queryUsage(range)
    return { ...data, buckets: [...data.buckets], groupBy: range.groupBy }
  }, [range])

  const { data: usage } = useQuery<UsageView>({
    queryKey: ['dashboard', 'usage-summary', '7d'],
    queryFn: fetchUsage,
    retryCount: 0,
  })

  const tokens = usage ? usage.totalPromptTokens + usage.totalCompletionTokens : undefined

  return (
    <Card className={styles.panel} flush>
      <div className={styles.head}>
        <span className={styles.title}>用量</span>
        <span className={styles.tag}>近 7 天</span>
      </div>

      <div className={styles.rows}>
        <div className={styles.row}>
          <span className={styles.k}>调用</span>
          <span className={styles.v}>
            {usage ? usage.totalCalls.toLocaleString('en-US') : '—'}
            <em>次</em>
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.k}>Tokens</span>
          <span className={styles.v}>{tokens === undefined ? '—' : formatTokens(tokens)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.k}>花费</span>
          <span className={styles.v}>
            {usage ? formatCostYuan(usage.totalCostYuan) : '—'}
          </span>
        </div>
      </div>

      {/* 价格表里没有的模型会记不上价，宁可标出来也不让花费看着「偏低」 */}
      {usage && usage.unpricedCalls > 0 && <div className={styles.note}>部分调用未计价</div>}
    </Card>
  )
}
