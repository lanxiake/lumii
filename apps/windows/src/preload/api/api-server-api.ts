/**
 * API 服务相关 API
 */
import { ipcRenderer } from 'electron'

export const apiServerApi = {
  // AI 灵魂 / 个人记忆
  getSoulContent: () => ipcRenderer.invoke('api:getSoulContent'),
  updateSoulContent: (content: string) => ipcRenderer.invoke('api:updateSoulContent', content),
  getUserMemory: () => ipcRenderer.invoke('api:getUserMemory'),
  updateUserMemory: (content: string) => ipcRenderer.invoke('api:updateUserMemory', content),

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
  getLatestNews: () => ipcRenderer.invoke('news:latest'),
  getLatestDashboardFeed: () => ipcRenderer.invoke('dashboard-feed:latest'),
  refreshDashboardFeed: () => ipcRenderer.invoke('dashboard-feed:refresh'),
  setActiveDashboardFeed: (feedId: string) =>
    ipcRenderer.invoke('dashboard-feed:set-active', feedId),

  // Agent 管理
  getAgents: () => ipcRenderer.invoke('api:getAgents'),
  getConfigModels: () => ipcRenderer.invoke('api:getConfigModels'),
  getChatModels: () => ipcRenderer.invoke('api:getChatModels'),
  setChatModel: (modelId: string) => ipcRenderer.invoke('api:setChatModel', modelId),
  getAgent: (agentId: string) => ipcRenderer.invoke('api:getAgent', agentId),
  forkAgent: (systemAgentId: string, data: { name?: string; description?: string }) =>
    ipcRenderer.invoke('api:forkAgent', systemAgentId, data),
  updateAgent: (agentId: string, data: Record<string, unknown>) =>
    ipcRenderer.invoke('api:updateAgent', agentId, data),
  deleteAgent: (agentId: string) => ipcRenderer.invoke('api:deleteAgent', agentId),
  getUserSkills: () => ipcRenderer.invoke('api:getUserSkills'),
  uploadSkillFile: () => ipcRenderer.invoke('api:uploadSkillFile'),
}
