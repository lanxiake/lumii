/**
 * useDashboard.types.ts - 概览页数据类型
 *
 * 本地优先：没有订阅/设备/配额概念，只有本机真实可采集的指标。
 * 拿不到的指标一律用 undefined 表达「无数据」，由 UI 显示「—」，绝不用 0 冒充。
 */

/** 技能统计 */
export interface SkillStats {
  installed: number
}

/** 到当前模型 provider 的首字节延迟 */
export interface LatencyStats {
  /** 最近 N 次 TTFB 中位数（毫秒）；无样本时缺省 */
  medianMs?: number
  sampleCount: number
  /** 本机推理无网络往返，UI 需换文案而不是直接叫「延迟」 */
  isLocal: boolean
}

/** 运行时态势：CPU / 内存 / 磁盘 三环 */
export interface RuntimeGauges {
  /** CPU 占用百分比；首次采样无基准时为 undefined */
  cpuPercent?: number
  memoryPercent?: number
  /** 系统盘占用百分比 */
  diskPercent?: number
  cpuModel?: string
  cpuCores?: number
  totalMemory?: number
  usedMemory?: number
}

/** 用量查询区间 */
export type UsageRange = 'today' | '7d' | '30d'

/** 单个时间桶的用量 */
export interface UsageBucketView {
  ts: number
  calls: number
  promptTokens: number
  completionTokens: number
  costCents: number
  unpricedCalls: number
}

/** 用量与花费聚合视图 */
export interface UsageView {
  totalCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  /** 已知价格部分的花费合计（美分） */
  totalCostCents: number
  /** 价格未知的调用次数，>0 时 UI 需标注「部分未计价」 */
  unpricedCalls: number
  buckets: UsageBucketView[]
  /** 桶粒度，用于图表 x 轴文案 */
  groupBy: 'hour' | 'day'
}
