/**
 * useSubscription.ts - 订阅管理 Hook
 *
 * 基于 useSubscription.ts 重构
 * 提供订阅计划、订阅状态和支付功能
 */

import { useState, useCallback } from 'react'
import { useQuery } from '../../common/useQuery'
import { useMutation } from '../../common/useMutation'
import type {
  SubscriptionPlan,
  UserSubscription,
  CreditBalance,
  BillingPeriod,
  GetPlansResponse,
  GetSubscriptionResponse,
  CreateSubscriptionResponse,
} from './useSubscription.types'

export function useSubscription() {
  const [selectedPeriod, setSelectedPeriod] = useState<BillingPeriod>('monthly')

  // 获取订阅计划列表
  const {
    data: plans = [],
    isLoading: isPlansLoading,
    error: plansError,
    refetch: refetchPlans,
  } = useQuery<SubscriptionPlan[]>({
    queryKey: ['subscription', 'plans'],
    queryFn: async () => {
      const response = (await window.electronAPI.api.getAvailablePlans()) as GetPlansResponse
      if (response.success && response.data) {
        return response.data.plans
      }
      throw new Error(response.error || '获取计划列表失败')
    },
  })

  // 获取用户订阅
  const {
    data: subscription,
    isLoading: isSubLoading,
    error: subError,
    refetch: refetchSub,
  } = useQuery<UserSubscription | null>({
    queryKey: ['subscription', 'current'],
    queryFn: async () => {
      const response = (await window.electronAPI.api.getSubscription()) as GetSubscriptionResponse
      if (response.success && response.data) {
        return response.data.subscription
      }
      return null
    },
  })

  // 获取积分余额
  const {
    data: creditBalance,
    isLoading: isCreditLoading,
    refetch: refetchCredit,
  } = useQuery<CreditBalance | null>({
    queryKey: ['subscription', 'creditBalance'],
    queryFn: async () => {
      const response = (await window.electronAPI.api.getCreditBalance()) as {
        success: boolean
        data?: CreditBalance | null
        error?: string
      }
      return response.success ? response.data || null : null
    },
  })

  // 创建订阅
  const createMutation = useMutation<UserSubscription, [string, BillingPeriod]>(
    async (planId: string, billingPeriod: BillingPeriod) => {
      const response = (await window.electronAPI.api.createSubscription({
        planId,
        billingPeriod,
      })) as CreateSubscriptionResponse

      if (!response.success || !response.data) {
        throw new Error(response.error || '创建订阅失败')
      }
      return response.data.subscription
    },
    {
      onSuccess: () => {
        refetchSub()
        refetchCredit()
      },
    }
  )

  // 取消订阅
  const cancelMutation = useMutation<UserSubscription, [boolean | undefined, string | undefined]>(
    async (immediately?: boolean, reason?: string) => {
      if (!subscription) throw new Error('没有活跃的订阅')

      const response = (await window.electronAPI.api.cancelSubscription(
        subscription.id,
        { immediately, reason }
      )) as CreateSubscriptionResponse

      if (!response.success || !response.data) {
        throw new Error(response.error || '取消订阅失败')
      }
      return response.data.subscription
    },
    {
      onSuccess: () => {
        refetchSub()
      },
    }
  )

  // 刷新所有数据
  const refresh = useCallback(async () => {
    await Promise.all([refetchPlans(), refetchSub(), refetchCredit()])
  }, [refetchPlans, refetchSub, refetchCredit])

  // 格式化价格
  const formatPrice = useCallback((plan: SubscriptionPlan): string => {
    if (plan.price === 0) return '免费'
    if (plan.price === -1) return '联系销售'

    const displayPrice = (plan.price / 100).toFixed(0)
    const periodLabel = plan.billingCycle === 'yearly' ? '年' : '月'
    return `¥${displayPrice}/${periodLabel}`
  }, [])

  /** 创建订阅 */
  const createSubscription = useCallback(
    async (planId: string, billingPeriod: BillingPeriod): Promise<void> => {
      await createMutation.mutateAsync(planId, billingPeriod)
    },
    [createMutation]
  )

  /** 取消订阅 */
  const cancelSubscription = useCallback(
    async (immediately?: boolean, reason?: string): Promise<void> => {
      await cancelMutation.mutateAsync(immediately, reason)
    },
    [cancelMutation]
  )

  const isLoading = isPlansLoading || isSubLoading || isCreditLoading
  const error = plansError || subError

  return {
    plans,
    subscription,
    creditBalance,
    isLoading,
    error,
    selectedPeriod,
    formatPrice,
    setSelectedPeriod,
    refresh,
    createSubscription,
    cancelSubscription,
  }
}

export type UseSubscriptionReturn = ReturnType<typeof useSubscription>
