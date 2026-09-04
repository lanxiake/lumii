/**
 * 自主进化 Preload API
 *
 * 暴露自主进化功能给渲染进程。
 */

import { ipcRenderer } from 'electron'

/**
 * 自主进化状态
 */
export interface AutonomousStatus {
  enabled: boolean
  satisfaction: {
    overall: number
    trend: 'improving' | 'stable' | 'declining'
    breakdown: {
      taskCompletion: number
      userFeedback: number
      efficiency: number
      knowledgeGrowth: number
    }
    lastUpdated: string
  }
  pendingGoalsCount: number
  capabilities?: Record<
    string,
    {
      level: number
      confidence: number
      testCount: number
    }
  >
  lastReflection?: {
    timestamp: string
    primaryIssue: string
    recommendationCount: number
  }
}

/**
 * 自主目标
 */
export interface AutonomousGoal {
  id: string
  type: 'learning' | 'proactive-message' | 'capability-improvement' | 'skill-enhancement' | 'memory-optimization'
  description: string
  triggerReason: string
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed'
  priority: number
  userValueScore?: number
  feasibility?: number
  metadata?: Record<string, any>
  createdAt: string
  approvedAt?: string
  completedAt?: string
}

/**
 * 审批设置
 */
export interface ApprovalSettings {
  channel: 'feishu' | 'weixin' | 'wecom' | 'local' | 'off'
  peerId?: string
  autoApproveInternal: boolean
  ttlOverrides?: Record<string, number>
  quietHours?: { start: number; end: number }
}

/**
 * 自主进化 API
 */
export const autonomousApi = {
  /**
   * 获取自主状态
   */
  getStatus: (): Promise<AutonomousStatus> => {
    return ipcRenderer.invoke('autonomous:getStatus')
  },

  /**
   * 获取待审批目标
   */
  getPendingGoals: (): Promise<AutonomousGoal[]> => {
    return ipcRenderer.invoke('autonomous:getPendingGoals')
  },

  /**
   * 批准目标
   */
  approveGoal: (goalId: string, note?: string): Promise<AutonomousGoal> => {
    return ipcRenderer.invoke('autonomous:approveGoal', goalId, note)
  },

  /**
   * 拒绝目标
   */
  rejectGoal: (
    goalId: string,
    options?: { reason?: string; neverAskAgain?: boolean }
  ): Promise<void> => {
    return ipcRenderer.invoke('autonomous:rejectGoal', goalId, options)
  },

  /**
   * 获取能力详情
   */
  getCapabilities: (): Promise<
    Record<
      string,
      {
        level: number
        confidence: number
        testCount: number
      }
    >
  > => {
    return ipcRenderer.invoke('autonomous:getCapabilities')
  },

  /**
   * 获取反思记录
   */
  getReflections: (limit?: number): Promise<any[]> => {
    return ipcRenderer.invoke('autonomous:getReflections', limit)
  },

  /**
   * 获取满意度历史
   */
  getSatisfactionHistory: (window?: string): Promise<any> => {
    return ipcRenderer.invoke('autonomous:getSatisfactionHistory', window)
  },

  /**
   * 获取审批设置
   */
  getApprovalSettings: (userId: string): Promise<ApprovalSettings | null> => {
    return ipcRenderer.invoke('autonomous:getApprovalSettings', userId)
  },

  /**
   * 更新审批设置
   */
  updateApprovalSettings: (userId: string, settings: Partial<ApprovalSettings>): Promise<void> => {
    return ipcRenderer.invoke('autonomous:updateApprovalSettings', userId, settings)
  },
}
