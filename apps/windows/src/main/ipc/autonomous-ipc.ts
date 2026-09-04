/**
 * 自主进化 IPC 处理器
 *
 * 暴露自主进化功能给渲染进程：
 * - 获取自主状态
 * - 获取待审批目标
 * - 批准/拒绝目标
 * - 获取能力详情
 * - 获取反思记录
 *
 * 来源：前端可视化实施方案.md
 */

import { ipcMain } from 'electron'
import type { AutonomousCoordinator } from '@lumii/agent-runtime/src/autonomous/autonomous-coordinator'

/**
 * IPC 依赖
 */
interface AutonomousIpcDeps {
  getCoordinator: () => AutonomousCoordinator | null
}

let deps: AutonomousIpcDeps | null = null

/**
 * 设置依赖
 */
export function setAutonomousIpcDeps(d: AutonomousIpcDeps): void {
  deps = d
}

/**
 * 注册 IPC 处理器
 */
export function registerAutonomousIpcHandlers(): void {
  /**
   * 获取自主进化状态
   */
  ipcMain.handle('autonomous:getStatus', async () => {
    const coordinator = deps?.getCoordinator()
    if (!coordinator) {
      return {
        enabled: false,
        satisfaction: {
          overall: 0,
          trend: 'stable',
          breakdown: {
            taskCompletion: 0,
            userFeedback: 0,
            efficiency: 0,
            knowledgeGrowth: 0,
          },
          lastUpdated: new Date().toISOString(),
        },
        pendingGoalsCount: 0,
      }
    }

    return coordinator.getStatus()
  })

  /**
   * 获取待审批目标
   */
  ipcMain.handle('autonomous:getPendingGoals', async () => {
    const coordinator = deps?.getCoordinator()
    if (!coordinator) {
      return []
    }

    return coordinator.getPendingGoals()
  })

  /**
   * 批准目标
   */
  ipcMain.handle('autonomous:approveGoal', async (_event, goalId: string, note?: string) => {
    const coordinator = deps?.getCoordinator()
    if (!coordinator) {
      throw new Error('Autonomous coordinator not available')
    }

    return coordinator.approveGoal(goalId, { note })
  })

  /**
   * 拒绝目标
   */
  ipcMain.handle(
    'autonomous:rejectGoal',
    async (_event, goalId: string, options?: { reason?: string; neverAskAgain?: boolean }) => {
      const coordinator = deps?.getCoordinator()
      if (!coordinator) {
        throw new Error('Autonomous coordinator not available')
      }

      return coordinator.rejectGoal(goalId, options)
    }
  )

  /**
   * 获取能力详情
   */
  ipcMain.handle('autonomous:getCapabilities', async () => {
    const coordinator = deps?.getCoordinator()
    if (!coordinator) {
      return {}
    }

    return coordinator.getCapabilities()
  })

  /**
   * 获取反思记录
   */
  ipcMain.handle('autonomous:getReflections', async (_event, limit: number = 10) => {
    const coordinator = deps?.getCoordinator()
    if (!coordinator) {
      return []
    }

    return coordinator.getReflections({ limit })
  })

  /**
   * 获取满意度历史
   */
  ipcMain.handle('autonomous:getSatisfactionHistory', async (_event, window: string = '7d') => {
    const coordinator = deps?.getCoordinator()
    if (!coordinator) {
      return { dataPoints: [] }
    }

    return coordinator.getSatisfactionHistory(window)
  })

  /**
   * 获取审批设置
   */
  ipcMain.handle('autonomous:getApprovalSettings', async (_event, userId: string) => {
    const coordinator = deps?.getCoordinator()
    if (!coordinator) {
      return null
    }

    return coordinator.getApprovalSettings(userId)
  })

  /**
   * 更新审批设置
   */
  ipcMain.handle('autonomous:updateApprovalSettings', async (_event, userId: string, settings: any) => {
    const coordinator = deps?.getCoordinator()
    if (!coordinator) {
      throw new Error('Autonomous coordinator not available')
    }

    return coordinator.updateApprovalSettings(userId, settings)
  })
}
