/**
 * session-metrics.ts - 底栏 HUD 的会话级累计
 *
 * 单独成文件是为了能不渲染组件就跑测试。
 */

import { estimateCostYuan, type TokenBreakdown } from '../../../../shared/model-pricing'

export interface UsageLike {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

export interface SessionMetrics {
  readonly upTokens: number
  readonly downTokens: number
  /** 已知价格部分的花费合计（人民币元）；hasPrice 为 false 时无意义 */
  readonly costYuan: number
  /** 是否至少有一条能算出价格；否则 UI 显示「—」而不是 ¥0 */
  readonly hasPrice: boolean
}

/**
 * 累计会话内带 usage 回执的消息。
 *
 * 只算真实回执，不估算 token —— 估算值混进来会让花费统计失真。
 * 本地模型价格为 0 但 hasPrice 为真：0 元和「价格未知」是两回事。
 */
export function sessionMetrics(
  messages: ReadonlyArray<{ readonly usage?: UsageLike }>,
  modelId: string | null,
): SessionMetrics {
  let upTokens = 0
  let downTokens = 0
  let costYuan = 0
  let hasPrice = false

  for (const m of messages) {
    if (!m.usage) continue
    upTokens += m.usage.inputTokens
    downTokens += m.usage.outputTokens
    if (!modelId) continue
    const breakdown: TokenBreakdown = {
      inputTokens: m.usage.inputTokens,
      outputTokens: m.usage.outputTokens,
      cacheReadTokens: m.usage.cacheRead,
      cacheWriteTokens: m.usage.cacheWrite,
      // 会话级实时展示不计 per-call（生图另走工具链路，此处无调用）
      callCount: 0,
    }
    const yuan = estimateCostYuan(modelId, breakdown)
    if (yuan !== undefined) {
      costYuan += yuan
      hasPrice = true
    }
  }

  return { upTokens, downTokens, costYuan, hasPrice }
}
