/**
 * 自主进化 IPC 处理器
 * ponytail: stub implementation - returns mock data, add real coordinator integration when backend ready
 */

import { ipcMain } from 'electron'

export function registerAutonomousHandlers() {
  // Stub handlers - 返回模拟数据直到后端实现
  ipcMain.handle('autonomous:getStatus', async () => ({
    enabled: false,
    satisfaction: {
      overall: 0.75,
      trend: 'stable' as const,
      breakdown: {
        taskCompletion: 0.8,
        userFeedback: 0.7,
        efficiency: 0.75,
        knowledgeGrowth: 0.7,
      },
      lastUpdated: new Date().toISOString(),
    },
    pendingGoalsCount: 0,
  }))

  ipcMain.handle('autonomous:getPendingGoals', async () => [])

  ipcMain.handle('autonomous:approveGoal', async (_event, goalId: string) => ({
    id: goalId,
    type: 'learning',
    description: '',
    triggerReason: '',
    status: 'approved',
    priority: 0,
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
  }))

  ipcMain.handle('autonomous:rejectGoal', async () => {})

  ipcMain.handle('autonomous:getCapabilities', async () => ({}))

  ipcMain.handle('autonomous:getReflections', async () => [])

  ipcMain.handle('autonomous:getSatisfactionHistory', async () => ({
    dataPoints: [],
  }))

  ipcMain.handle('autonomous:getApprovalSettings', async () => null)

  ipcMain.handle('autonomous:updateApprovalSettings', async () => {})
}
