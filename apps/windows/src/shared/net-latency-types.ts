/**
 * 网络延迟探测的跨进程类型
 *
 * 主进程产出、preload 透传、渲染层消费。只放纯类型，不引运行时依赖。
 */

/** 探测分组：国内 / 国外分开 */
export type NetGroupId = 'domestic' | 'international'

/** 单组延迟探测结果 */
export interface PingResult {
  group: NetGroupId
  ok: boolean
  /** 中位数往返毫秒（已排除预热样本），UI 主数字 */
  ms?: number
  /** 最小往返毫秒：最接近链路真实 RTT（不受排队/抖动抬高） */
  minMs?: number
  /** 抖动：相邻样本差值的平均绝对值（毫秒），越小越稳 */
  jitterMs?: number
  /** 计入统计的样本数（不含预热那一次） */
  samples?: number
  /** 走本机代理才通时为 true，UI 要标注 */
  viaProxy?: boolean
  error?: string
}

/** 一次延迟探测的汇总；best 是自适应选出的「可用且最快」的那组 */
export interface PingReport {
  domestic: PingResult
  international: PingResult
  best: NetGroupId | null
}
