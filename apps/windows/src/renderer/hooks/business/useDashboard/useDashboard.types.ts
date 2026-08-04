/**
 * useDashboard.types.ts - 仪表盘数据类型定义
 */

/** 订阅信息 */
export interface Subscription {
  id: string
  userId: string
  planId: string
  status: string
  billingPeriod: string
  currentPeriodStart: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  createdAt: string
  updatedAt: string
}

/** 订阅计划 */
export interface SubscriptionPlan {
  id: string
  name: string
  displayName: string
  description?: string
  price: number
  currency: string
  billingCycle: string
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

/** 使用量统计 */
export interface UsageStats {
  conversationsUsed: number
  conversationsLimit: number
  messagesUsed: number
  messagesLimit: number
  storageUsed: number
  storageLimit: number
  tokensUsed: number
  tokensLimit: number
}

/** 技能统计 */
export interface SkillQuotaStats {
  installed: number
  limit: number
}

/** 仪表盘数据 */
export interface DashboardData {
  subscription: Subscription | null
  planName: string
  usage: UsageStats | null
  deviceCount: number
  skillStats: SkillQuotaStats
  daysRemaining: number
}
