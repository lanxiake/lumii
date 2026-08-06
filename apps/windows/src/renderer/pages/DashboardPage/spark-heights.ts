/**
 * spark-heights.ts - hero 条形微图的柱高计算
 *
 * 单独成文件是为了能不拉起整棵组件树就跑测试。
 */

export const SPARK_BARS = 22

/**
 * 把区间内各时间桶的调用数压成固定根数的柱高（百分比）。
 * 桶比柱子多时按等分聚合取最大值——只表达节律，精确读数交给下方 UsageChart。
 * 无数据时给一排等高矮柱，避免 hero 出现空洞。
 */
export function sparkHeights(buckets: ReadonlyArray<{ calls: number }>): number[] {
  if (buckets.length === 0) return Array.from({ length: SPARK_BARS }, () => 8)
  const step = buckets.length / SPARK_BARS
  const slots = Array.from({ length: SPARK_BARS }, (_, i) => {
    const from = Math.floor(i * step)
    const to = Math.max(Math.floor((i + 1) * step), from + 1)
    return buckets.slice(from, to).reduce((m, b) => Math.max(m, b.calls), 0)
  })
  const max = Math.max(...slots, 1)
  // 最小 8%：有调用但很少的桶不该看起来是空的
  return slots.map((v) => Math.max(8, (v / max) * 100))
}
