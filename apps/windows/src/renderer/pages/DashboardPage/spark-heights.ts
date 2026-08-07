/**
 * spark-heights.ts - hero 条形微图的柱高与悬停数据
 *
 * 单独成文件是为了能不拉起整棵组件树就跑测试。
 */

export const SPARK_BARS = 22

export interface SparkBar {
  /** 柱高百分比 8–100 */
  height: number
  /** 该柱聚合后的调用次数 */
  calls: number
  /** 悬停说明 */
  title: string
}

/**
 * 把区间内各时间桶压成固定根数的柱（高度 + 调用数 + 文案）。
 * 桶比柱子多时按等分聚合取最大值；无数据时给一排等高矮柱。
 */
export function sparkBars(
  buckets: ReadonlyArray<{ calls: number; ts?: number }>,
  groupBy: 'hour' | 'day' = 'hour',
): SparkBar[] {
  if (buckets.length === 0) {
    return Array.from({ length: SPARK_BARS }, () => ({
      height: 8,
      calls: 0,
      title: '暂无调用记录',
    }))
  }

  const step = buckets.length / SPARK_BARS
  const slots = Array.from({ length: SPARK_BARS }, (_, i) => {
    const from = Math.floor(i * step)
    const to = Math.max(Math.floor((i + 1) * step), from + 1)
    const slice = buckets.slice(from, to)
    const calls = slice.reduce((m, b) => Math.max(m, b.calls), 0)
    const ts = slice.find((b) => typeof b.ts === 'number')?.ts
    return { calls, ts }
  })

  const max = Math.max(...slots.map((s) => s.calls), 1)

  return slots.map((s) => ({
    height: Math.max(8, (s.calls / max) * 100),
    calls: s.calls,
    title: formatSparkTitle(s.calls, s.ts, groupBy),
  }))
}

/**
 * 仅返回柱高（兼容旧调用与单测）
 */
export function sparkHeights(buckets: ReadonlyArray<{ calls: number }>): number[] {
  return sparkBars(buckets).map((b) => b.height)
}

/**
 * 生成柱状图悬停文案
 */
function formatSparkTitle(
  calls: number,
  ts: number | undefined,
  groupBy: 'hour' | 'day',
): string {
  const when =
    typeof ts === 'number'
      ? formatBucketTime(ts, groupBy)
      : ''
  if (calls <= 0) {
    return when ? `${when} · 无调用` : '无调用'
  }
  return when ? `${when} · ${calls} 次调用` : `${calls} 次调用`
}

/**
 * 格式化时间桶标签
 */
function formatBucketTime(ts: number, groupBy: 'hour' | 'day'): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  if (groupBy === 'day') {
    return `${d.getMonth() + 1}/${pad(d.getDate())}`
  }
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:00`
}
