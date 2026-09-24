/**
 * API 服务相关 API
 */
import { ipcRenderer } from 'electron'

export const apiServerApi = {
  // Provider 配置
  getProviderConfig: () => ipcRenderer.invoke('provider:getConfig'),
  setProviderConfig: (cfg: unknown) => ipcRenderer.invoke('provider:setConfig', cfg),
  listModels: (slot: string, draftCfg?: unknown) =>
    ipcRenderer.invoke('provider:listModels', slot, draftCfg),
  testConnection: (slot: string, draftCfg?: unknown) =>
    ipcRenderer.invoke('provider:testConnection', slot, draftCfg),

  // 用量查询
  queryUsage: (query: unknown) => ipcRenderer.invoke('usage:query', query),
  getLatency: () => ipcRenderer.invoke('usage:latency'),

  // 资讯和 Feed
  getLatestDashboardFeed: () => ipcRenderer.invoke('dashboard-feed:latest'),
  getDashboardFeedMeta: (feedId: string) => ipcRenderer.invoke('dashboard-feed:meta', feedId),
  getDashboardFeedPage: (feedId: string, opts?: { limit?: number; before?: { timestamp: number; id: string } | null }) =>
    ipcRenderer.invoke('dashboard-feed:page', feedId, opts),
  getDashboardFeedBatches: (feedId: string, opts?: { limit?: number; before?: { createdAt: string; id: string } | null }) =>
    ipcRenderer.invoke('dashboard-feed:batches', feedId, opts),
  refreshDashboardFeed: () => ipcRenderer.invoke('dashboard-feed:refresh'),
  setActiveDashboardFeed: (feedId: string) =>
    ipcRenderer.invoke('dashboard-feed:set-active', feedId),

  // 维护体检报告（概览页「资产体检」卡片）
  getMaintenanceReportOverview: (limit?: number) =>
    ipcRenderer.invoke('maintenance-report:overview', limit),
}
