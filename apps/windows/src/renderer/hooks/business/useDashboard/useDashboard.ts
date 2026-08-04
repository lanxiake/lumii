/**
 * useDashboard.ts - 仪表盘数据 Hook
 *
 * 基于 useDashboard.ts 重构
 * 聚合统计数据和订阅信息
 */

import { useState, useCallback } from 'react'
import { useAuth } from '../../../contexts/AuthContext/AuthContext'
import { useQuery } from '../../common/useQuery'
import type {
  Subscription,
  SubscriptionPlan,
  UsageStats,
  SkillQuotaStats,
} from './useDashboard.types'

const SKILL_INSTALL_LIMIT = 100
const DEVICE_LIMIT = 5

function calcDaysRemaining(endDate: string | undefined): number {
  if (!endDate) return 0
  const end = new Date(endDate)
  const now = new Date()
  const diffMs = end.getTime() - now.getTime()
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)))
}

export function useDashboard() {
  const { isAuthenticated, isTokenSynced, accessToken } = useAuth()
  const isReady = isAuthenticated && isTokenSynced

  const [planName, setPlanName] = useState<string>('免费版')
  const [daysRemaining, setDaysRemaining] = useState<number>(0)

  // 稳定 queryFn，避免每次渲染都创建新函数导致 useQuery 重新执行
  const fetchSubscription = useCallback(async () => {
    if (!accessToken) throw new Error('未登录')

    const response = (await window.electronAPI.api.getSubscription()) as {
      success: boolean
      data?: { subscription: Subscription; plan?: SubscriptionPlan }
      error?: string
    }

    if (response.success && response.data) {
      setPlanName(response.data.plan?.displayName || '免费版')
      setDaysRemaining(calcDaysRemaining(response.data.subscription?.currentPeriodEnd))
      return response.data.subscription
    }
    throw new Error(response.error || '获取订阅信息失败')
  }, [accessToken])

  const fetchUsage = useCallback(async () => {
    const response = (await window.electronAPI.api.getUsage()) as {
      success: boolean
      data?: {
        daily?: {
          conversations?: number
          aiCalls?: number
          skillExecutions?: number
          fileOperations?: number
          storageUsedMb?: number
        }
        monthly?: {
          conversations?: number
          aiCalls?: number
          storageUsedMb?: number
        }
      }
      error?: string
    }
    if (!response.success || !response.data) return null
    const daily = response.data.daily ?? {}
    return {
      conversationsUsed: daily.aiCalls ?? 0,
      conversationsLimit: 0,
      messagesUsed: daily.conversations ?? 0,
      messagesLimit: 0,
      storageUsed: daily.storageUsedMb ?? 0,
      storageLimit: 0,
      tokensUsed: 0,
      tokensLimit: 0,
    } satisfies UsageStats
  }, [])

  const fetchDevices = useCallback(async () => {
    const response = (await window.electronAPI.api.getUserDevices()) as {
      success: boolean
      data?: { devices?: Array<unknown> } | Array<unknown>
      error?: string
    }
    if (!response.success || !response.data) return 0
    // API 返回格式: { success: true, data: { devices: [...] } }
    // 兼容旧格式: { success: true, data: [...] }
    const devices = Array.isArray(response.data)
      ? response.data
      : (response.data as { devices?: Array<unknown> }).devices ?? []
    return devices.length
  }, [])

  const fetchSkills = useCallback(async () => {
    const raw = await window.electronAPI.skills.listLocalInstalled()
    // IPC 返回 { success, data } 格式，兼容旧版裸数组
    const localSkills: Array<unknown> = Array.isArray(raw) ? raw : ((raw as any)?.data ?? [])
    const installedCount = localSkills.length
    return { installed: installedCount, limit: SKILL_INSTALL_LIMIT }
  }, [])

  // 获取订阅信息
  const {
    data: subscription,
    isLoading: isSubLoading,
    isRefetching: isSubRefetching,
    error: subError,
    refetch: refetchSub,
  } = useQuery<Subscription | null>({
    queryKey: ['dashboard', 'subscription'],
    queryFn: fetchSubscription,
    enabled: isReady,
    retryCount: 0,
  })

  // 获取使用量统计
  const {
    data: usage,
    isLoading: isUsageLoading,
    isRefetching: isUsageRefetching,
    refetch: refetchUsage,
  } = useQuery<UsageStats | null>({
    queryKey: ['dashboard', 'usage'],
    queryFn: fetchUsage,
    enabled: isReady,
    retryCount: 0,
  })

  // 获取设备数量
  const {
    data: deviceCount = 0,
    isLoading: isDeviceLoading,
    isRefetching: isDeviceRefetching,
    refetch: refetchDevices,
  } = useQuery<number>({
    queryKey: ['dashboard', 'devices'],
    queryFn: fetchDevices,
    enabled: isReady,
    retryCount: 0,
  })

  // 获取技能统计
  const {
    data: skillStats,
    isLoading: isSkillLoading,
    isRefetching: isSkillRefetching,
    refetch: refetchSkills,
  } = useQuery<SkillQuotaStats>({
    queryKey: ['dashboard', 'skills'],
    queryFn: fetchSkills,
    enabled: isReady,
    retryCount: 0,
  })

  // 刷新所有数据
  const refresh = useCallback(async () => {
    await Promise.all([
      refetchSub(),
      refetchUsage(),
      refetchDevices(),
      refetchSkills(),
    ])
  }, [refetchSub, refetchUsage, refetchDevices, refetchSkills])

  const isLoading = isSubLoading || isUsageLoading || isDeviceLoading || isSkillLoading
  const isRefreshing = isSubRefetching || isUsageRefetching || isDeviceRefetching || isSkillRefetching

  return {
    subscription,
    planName,
    usage,
    deviceCount,
    skillStats: skillStats || { installed: 0, limit: SKILL_INSTALL_LIMIT },
    daysRemaining,
    isLoading,
    isRefreshing,
    error: subError,
    refresh,
  }
}

export type UseDashboardReturn = ReturnType<typeof useDashboard>
