/**
 * useCredits.types.ts - 积分管理类型定义
 */

/** 积分余额 */
export interface CreditBalance {
  id: string
  userId: string
  totalBalance: number
  totalEarned: number
  totalConsumed: number
  totalExpired: number
  createdAt: string
  updatedAt: string
}

/** 积分流水记录 */
export interface CreditTransaction {
  id: string
  userId: string
  batchId?: string
  type: string
  amount: number
  balanceAfter: number
  source: string
  sourceId?: string
  description?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

/** 积分批次 */
export interface CreditBatch {
  id: string
  source: string
  originalAmount: number
  remainingAmount: number
  expiresAt: string
  description?: string
  createdAt: string
}

/** 邀请统计 */
export interface InviteStats {
  count: number
  totalCredits: number
  maxCredits: number
}

/** API 响应类型 */
export interface CreditHistoryResponse {
  success: boolean
  data?: CreditTransaction[]
  meta?: { count: number; hasMore: boolean; limit: number; offset: number }
  error?: string
}

export interface CreditBalanceResponse {
  success: boolean
  data?: CreditBalance | null
  error?: string
}

export interface CreditBatchesResponse {
  success: boolean
  data?: { batches: CreditBatch[] }
  error?: string
}

export interface InviteStatsResponse {
  success: boolean
  data?: InviteStats
  error?: string
}
