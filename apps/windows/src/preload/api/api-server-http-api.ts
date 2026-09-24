/**
 * API Server HTTP 调用：只覆盖 main 侧真正注册了 handler 的那部分面
 * （技能商店 / 用户记忆 / AI 灵魂 / Agent 管理 / 搜索配置）。
 *
 * 2026-09-24：删掉登录注册、设备配对、会话消息、验证码、审计日志、文件管理、
 * 技能管理、系统管理等 71 个悬空方法——main 侧从未注册这些 channel，
 * invoke 必然 reject。这个独立开源版是本地优先的，那套「连远端 Lumii 服务」
 * 的 HTTP API 面本就不存在。删完 preload 侧的悬空引用归零。
 */
import { ipcRenderer } from 'electron'

export const apiServerHttpApi = {
  // --- 技能商店接口 ---
  getStoreSkills: (filters?: {
    category?: string
    tags?: string[]
    subscription?: string
    sortBy?: string
    search?: string
    offset?: number
    limit?: number
  }) => ipcRenderer.invoke('api:getStoreSkills', filters),
  getStoreFeatured: (limit?: number) =>
    ipcRenderer.invoke('api:getStoreFeatured', limit),
  getStorePopular: (limit?: number) =>
    ipcRenderer.invoke('api:getStorePopular', limit),
  getStoreRecent: (limit?: number) =>
    ipcRenderer.invoke('api:getStoreRecent', limit),
  getStoreStats: () => ipcRenderer.invoke('api:getStoreStats'),
  getStoreCategories: () => ipcRenderer.invoke('api:getStoreCategories'),
  getStoreSkillDetail: (skillId: string) =>
    ipcRenderer.invoke('api:getStoreSkillDetail', skillId),
  installStoreSkill: (skillId: string) =>
    ipcRenderer.invoke('api:installStoreSkill', skillId),
  createUserSkill: (data: {
    name: string
    description?: string
    version?: string
    code?: string
    manifest?: Record<string, unknown>
    status?: string
    metadata?: Record<string, unknown>
  }) => ipcRenderer.invoke('api:createUserSkill', data),
  refreshStore: () => ipcRenderer.invoke('api:refreshStore'),

  // --- 用户记忆接口 ---
  getUserMemory: () => ipcRenderer.invoke('api:getUserMemory'),
  updateUserMemory: (content: string) => ipcRenderer.invoke('api:updateUserMemory', content),

  // --- AI 灵魂接口 ---
  getSoulContent: () => ipcRenderer.invoke('api:getSoulContent'),
  updateSoulContent: (content: string) => ipcRenderer.invoke('api:updateSoulContent', content),

  // --- Agent 管理接口 ---
  getConfigModels: () => ipcRenderer.invoke('api:getConfigModels'),
  getAgents: () => ipcRenderer.invoke('api:getAgents'),
  getAgent: (agentId: string) => ipcRenderer.invoke('api:getAgent', agentId),
  forkAgent: (systemAgentId: string, data: { name?: string; description?: string }) =>
    ipcRenderer.invoke('api:forkAgent', systemAgentId, data),
  updateAgent: (agentId: string, data: Record<string, unknown>) =>
    ipcRenderer.invoke('api:updateAgent', agentId, data),
  deleteAgent: (agentId: string) => ipcRenderer.invoke('api:deleteAgent', agentId),
  getUserSkills: () => ipcRenderer.invoke('api:getUserSkills'),

  // --- 搜索工具配置 ---
  getSearchConfig: () => ipcRenderer.invoke('api:getSearchConfig'),
  setSearchConfig: (config: { langSearchApiKey?: string; searxngBaseUrl?: string }) =>
    ipcRenderer.invoke('api:setSearchConfig', config),
}
