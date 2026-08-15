/**
 * 服务商首字节延迟（Task 4.4）
 *
 * 语义是「到当前模型 provider 的往返延迟」，不是 ping 公网：
 * 记 agent:start（发起）到首个 message:delta（首字节）的间隔，取最近 N 次中位数。
 * 中位数而非均值——偶发的一次长思考不该把读数拉飞。
 *
 * 纯内存环形缓冲，不落盘：延迟是瞬时指标，重启归零没有信息损失。
 */

import { isLocalModel } from '../shared/model-pricing'

/** 保留的样本数。够算出稳定中位数，又不至于让旧样本拖住读数 */
const WINDOW = 20

interface Sample {
  ttfbMs: number
  model: string
}

const samples: Sample[] = []
/** instanceId → agent:start 时刻，等首个 delta 到达时配对 */
const pending = new Map<string, number>()

/** 本轮开始，记下发起时刻 */
export function markRunStart(instanceId: string): void {
  pending.set(instanceId, Date.now())
}

/** 首个 token 到达。同一轮内重复调用只有第一次生效 */
export function markFirstToken(instanceId: string, model: string): void {
  const startedAt = pending.get(instanceId)
  if (startedAt === undefined) return
  pending.delete(instanceId)

  samples.push({ ttfbMs: Date.now() - startedAt, model })
  if (samples.length > WINDOW) samples.shift()
}

/** 本轮结束/中断，丢弃未配对的起点，避免下一轮误配 */
export function clearRun(instanceId: string): void {
  pending.delete(instanceId)
}

export interface LatencyView {
  /** 最近 N 次 TTFB 中位数（毫秒）；无样本时缺省 */
  medianMs?: number
  /** 样本数，UI 可据此显示「样本不足」 */
  sampleCount: number
  /**
   * 最近一次调用是否为本机推理。本地模型无网络往返，
   * 这个读数只反映模型加载与生成速度，UI 需标注而非直接叫「延迟」。
   */
  isLocal: boolean
}

export function getLatency(): LatencyView {
  if (samples.length === 0) {
    return { sampleCount: 0, isLocal: false }
  }
  const sorted = samples.map((s) => s.ttfbMs).sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const medianMs =
    sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
  return {
    medianMs,
    sampleCount: samples.length,
    isLocal: isLocalModel(samples[samples.length - 1].model),
  }
}
