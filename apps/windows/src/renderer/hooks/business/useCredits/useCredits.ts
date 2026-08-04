/**
 * useCredits.ts - 积分管理 Hook
 *
 * 提供积分余额、流水记录和批次信息的查询功能
 * 使用通用 Hook 模式重构
 */

import { useState, useCallback, useEffect } from 'react'
import { useQuery } from '../../common/useQuery'
import type {
  CreditBalance,
  CreditTransaction,
  CreditBatch,
  InviteStats,
  CreditHistoryResponse,
  CreditBalanceResponse,
  CreditBatchesResponse,
  InviteStatsResponse,
} from './useCredits.types'

const PAGE_SIZE = 20

export function useCredits() {
  // 使用 useQuery 获取积分余额
  const {
    data: balance,
    isLoading: isBalanceLoading,
    error: balanceError,
    refetch: refetchBalance,
  } = useQuery<CreditBalance | null>({
    queryKey: ['credits', 'balance'],
    queryFn: async () => {
      const response = (await window.electronAPI.api.getCreditBalance()) as CreditBalanceResponse

      if (response.success) {
        return response.data ?? {
          id: '',
          userId: '',
          totalBalance: 0,
          totalEarned: 0,
          totalConsumed: 0,
          totalExpired: 0,
          createdAt: '',
          updatedAt: '',
        }
      }
      throw new Error(response.error || '获取积分余额失败')
    },
  })

  // 分页状态
  const [transactions, setTransactions] = useState<CreditTransaction[]>([])
  const [isTransactionsLoading, setIsTransactionsLoading] = useState(false)
  const [transactionsError, setTransactionsError] = useState<Error | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  // 获取交易记录
  const fetchTransactions = useCallback(async (newOffset: number, append = false) => {
    setIsTransactionsLoading(true)
    setTransactionsError(null)

    try {
      const response = (await window.electronAPI.api.getCreditHistory({
        limit: PAGE_SIZE,
        offset: newOffset,
      })) as CreditHistoryResponse

      if (response.success && response.data) {
        if (append) {
          setTransactions(prev => [...prev, ...response.data!])
        } else {
          setTransactions(response.data)
        }
        setHasMore(response.meta?.hasMore ?? false)
        setOffset(newOffset + response.data.length)
      } else {
        throw new Error(response.error || '获取积分流水失败')
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('获取积分流水失败')
      setTransactionsError(error)
      console.error('[useCredits] 获取积分流水失败:', error)
    } finally {
      setIsTransactionsLoading(false)
    }
  }, [])

  // 加载更多
  const loadMore = useCallback(async () => {
    if (isTransactionsLoading || !hasMore) return
    await fetchTransactions(offset, true)
  }, [isTransactionsLoading, hasMore, offset, fetchTransactions])

  // 刷新交易记录
  const refreshTransactions = useCallback(async () => {
    setTransactions([])
    setOffset(0)
    setHasMore(false)
    await fetchTransactions(0, false)
  }, [fetchTransactions])

  // 初始加载交易记录
  useEffect(() => {
    fetchTransactions(0, false)
  }, [fetchTransactions])

  // 使用 useQuery 获取积分批次
  const {
    data: batches,
    isLoading: isBatchesLoading,
    error: batchesError,
    refetch: refetchBatches,
  } = useQuery<CreditBatch[]>({
    queryKey: ['credits', 'batches'],
    queryFn: async () => {
      const response = (await window.electronAPI.api.getCreditBatches()) as CreditBatchesResponse

      if (response.success && response.data) {
        return response.data.batches
      }
      // 批次接口可能未实现，静默返回空数组
      return []
    },
  })

  // 使用 useQuery 获取邀请统计
  const {
    data: inviteStats,
    isLoading: isInviteStatsLoading,
    refetch: refetchInviteStats,
  } = useQuery<InviteStats | null>({
    queryKey: ['credits', 'inviteStats'],
    queryFn: async () => {
      const response = (await window.electronAPI.api.getInviteStats()) as InviteStatsResponse

      if (response.success && response.data) {
        return response.data
      }
      return null
    },
  })

  /** 刷新所有数据 */
  const refresh = useCallback(async () => {
    await Promise.allSettled([
      refetchBalance(),
      refreshTransactions(),
      refetchBatches(),
      refetchInviteStats(),
    ])
  }, [refetchBalance, refreshTransactions, refetchBatches, refetchInviteStats])

  const isLoading = isBalanceLoading || isTransactionsLoading || isBatchesLoading || isInviteStatsLoading
  const error = balanceError || transactionsError || batchesError

  return {
    balance,
    transactions,
    batches,
    inviteStats,
    isLoading,
    error,
    hasMoreTransactions: hasMore,
    refresh,
    loadMoreTransactions: loadMore,
  }
}

export type UseCreditsReturn = ReturnType<typeof useCredits>
