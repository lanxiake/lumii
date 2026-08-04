/**
 * useSubscription.types.ts - 订阅管理类型定义
 */

/** 计费周期 */
export type BillingPeriod = 'monthly' | 'yearly'

/** 订阅状态 */
export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'expired'
  | 'paused'

/** 订阅计划 */
export interface SubscriptionPlan {
  id: string
  name: string
  displayName: string
  description?: string
  price: number
  currency: string
  billingCycle: 'monthly' | 'yearly'
  features: {
    maxDevices: number
    maxSkills: number
    maxConversations: number
    maxMemorySize: number
    prioritySupport: boolean
    customBranding: boolean
  }
  isActive: boolean
}

/** 用户订阅 */
export interface UserSubscription {
  id: string
  userId: string
  planId: string
  status: SubscriptionStatus
  billingPeriod: BillingPeriod
  currentPeriodStart: string
  currentPeriodEnd: string
  canceledAt?: string
  cancelAtPeriodEnd: boolean
  createdAt: string
  updatedAt: string
}

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

/** API 响应类型 */
export interface GetPlansResponse {
  success: boolean
  data?: { plans: SubscriptionPlan[] }
  error?: string
}

export interface GetSubscriptionResponse {
  success: boolean
  data?: { subscription: UserSubscription; plan?: SubscriptionPlan }
  error?: string
}

export interface CreateSubscriptionResponse {
  success: boolean
  data?: { subscription: UserSubscription; message?: string }
  error?: string
}
