/**
 * API Server HTTP 调用（登录/聊天/审计/技能商店/文件管理等）
 */
import { ipcRenderer } from 'electron'

export const apiServerHttpApi = {
  login: (params: { identifier: string; password: string; captchaToken?: string }) =>
    ipcRenderer.invoke('api:login', params),
  register: (params: {
    username?: string
    phone?: string
    email?: string
    password: string
    displayName?: string
    captchaToken?: string
  }) => ipcRenderer.invoke('api:register', params),
  refreshToken: (refreshToken?: string) =>
    ipcRenderer.invoke('api:refreshToken', refreshToken),
  logout: (refreshToken?: string) =>
    ipcRenderer.invoke('api:logout', refreshToken),
  sendCode: (params: { phone?: string; email?: string; type?: string }) =>
    ipcRenderer.invoke('api:sendCode', params),
  requestPairing: (params: {
    deviceId: string
    publicKey: string
    displayName?: string
    platform?: string
    role?: string
    silent?: boolean
  }) => ipcRenderer.invoke('api:requestPairing', params),
  checkPairingStatus: (requestId: string) =>
    ipcRenderer.invoke('api:checkPairingStatus', requestId),
  generatePairingCode: () => ipcRenderer.invoke('api:generatePairingCode'),
  getCurrentUser: () => ipcRenderer.invoke('api:getCurrentUser'),
  getUserDevices: () => ipcRenderer.invoke('api:getUserDevices'),
  deleteDevice: (deviceId: string) => ipcRenderer.invoke('api:deleteDevice', deviceId),
  updateDevice: (deviceId: string, updates: { alias?: string; isPrimary?: boolean }) =>
    ipcRenderer.invoke('api:updateDevice', deviceId, updates),
  updateUser: (params: { displayName?: string; avatar?: string }) =>
    ipcRenderer.invoke('api:updateUser', params),
  changePassword: (params: { currentPassword: string; newPassword: string }) =>
    ipcRenderer.invoke('api:changePassword', params),
  setBaseUrl: (url: string) => ipcRenderer.invoke('api:setBaseUrl', url),
  getBaseUrl: () => ipcRenderer.invoke('api:getBaseUrl'),
  setAccessToken: (token: string | null) =>
    ipcRenderer.invoke('api:setAccessToken', token),
  checkAuth: () => ipcRenderer.invoke('api:checkAuth'),
  requestPasswordReset: (email: string) =>
    ipcRenderer.invoke('api:requestPasswordReset', email),

  // --- 聊天接口 ---
  getConversations: () => ipcRenderer.invoke('api:getConversations'),
  createConversation: (params: { title?: string }) =>
    ipcRenderer.invoke('api:createConversation', params),
  getConversationDetail: (conversationId: string) =>
    ipcRenderer.invoke('api:getConversationDetail', conversationId),
  deleteConversation: (conversationId: string) =>
    ipcRenderer.invoke('api:deleteConversation', conversationId),
  getMessages: (conversationId: string, params?: { limit?: number; offset?: number }) =>
    ipcRenderer.invoke('api:getMessages', conversationId, params),
  sendMessage: (params: { conversationId: string; content: string; attachments?: string[] }) =>
    ipcRenderer.invoke('api:sendMessage', params),
  sendMessageStream: (params: { conversationId: string; content: string }, callbacks: unknown) =>
    ipcRenderer.invoke('api:sendMessageStream', params, callbacks),
  retryMessage: (messageId: string) =>
    ipcRenderer.invoke('api:retryMessage', messageId),
  stopGenerating: (conversationId: string) =>
    ipcRenderer.invoke('api:stopGenerating', conversationId),
  clearConversation: (conversationId: string) =>
    ipcRenderer.invoke('api:clearConversation', conversationId),
  getSuggestedReplies: (conversationId: string) =>
    ipcRenderer.invoke('api:getSuggestedReplies', conversationId),
  rateMessage: (messageId: string, params: { rating: 'like' | 'dislike'; feedback?: string }) =>
    ipcRenderer.invoke('api:rateMessage', messageId, params),

  // --- 验证码与安全接口 ---
  getCaptchaChallenge: () => ipcRenderer.invoke('api:getCaptchaChallenge'),
  verifyCaptcha: (captchaId: string, sliderX: number) =>
    ipcRenderer.invoke('api:verifyCaptcha', captchaId, sliderX),
  getPublicKey: () => ipcRenderer.invoke('api:getPublicKey'),

  // --- 记忆接口（API Server /api/memories）---
  getMemories: (options?: {
    type?: string
    category?: string
    activeOnly?: boolean
    limit?: number
    offset?: number
  }) => ipcRenderer.invoke('api:getMemories', options),
  createMemory: (data: {
    type: string
    content: string
    category?: string
    summary?: string
    importance?: number
  }) => ipcRenderer.invoke('api:createMemory', data),
  updateMemory: (
    id: string,
    data: { content?: string; summary?: string; category?: string; importance?: number },
  ) => ipcRenderer.invoke('api:updateMemory', id, data),
  deleteMemory: (id: string) => ipcRenderer.invoke('api:deleteMemory', id),

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
  submitSkillToStore: (data: {
    name: string
    description?: string
    readme?: string
    version?: string
    categoryId?: string
    tags?: string[]
    config?: Record<string, unknown>
  }) => ipcRenderer.invoke('api:submitSkillToStore', data),
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

  // --- 审计日志接口 ---
  queryAuditLogs: (filters?: {
    startTime?: string
    endTime?: string
    eventTypes?: string[]
    severities?: string[]
    results?: string[]
    sourceTypes?: string[]
    search?: string
    sessionId?: string
    offset?: number
    limit?: number
    sortOrder?: string
  }) => ipcRenderer.invoke('api:queryAuditLogs', filters),
  getRecentAuditLogs: (limit?: number) =>
    ipcRenderer.invoke('api:getRecentAuditLogs', limit),
  getAuditStats: () => ipcRenderer.invoke('api:getAuditStats'),
  getAuditConfig: () => ipcRenderer.invoke('api:getAuditConfig'),
  updateAuditConfig: (config: Record<string, unknown>) =>
    ipcRenderer.invoke('api:updateAuditConfig', config),
  exportAuditLogs: (params: {
    format: string
    filters?: Record<string, unknown>
  }) => ipcRenderer.invoke('api:exportAuditLogs', params),
  clearAuditLogs: (beforeDate?: string) =>
    ipcRenderer.invoke('api:clearAuditLogs', beforeDate),

  // --- 用户记忆接口 ---
  getUserMemory: () => ipcRenderer.invoke('api:getUserMemory'),
  updateUserMemory: (content: string) => ipcRenderer.invoke('api:updateUserMemory', content),

  // --- AI 灵魂接口 ---
  getSoulContent: () => ipcRenderer.invoke('api:getSoulContent'),
  updateSoulContent: (content: string) => ipcRenderer.invoke('api:updateSoulContent', content),

  // --- 文件上传 ---
  uploadSkillFile: (params: {
    skillId: string
    fileType: string
    originalName: string
    contentType: string
    data: string
  }) => ipcRenderer.invoke('api:uploadSkillFile', params),

  // --- 文件管理接口 ---
  getFileList: (path?: string) => ipcRenderer.invoke('api:getFileList', path),
  uploadFile: (file: unknown) => ipcRenderer.invoke('api:uploadFile', file),
  downloadFile: (fileId: string) => ipcRenderer.invoke('api:downloadFile', fileId),
  deleteFile: (fileId: string) => ipcRenderer.invoke('api:deleteFile', fileId),
  getFileDetail: (fileId: string) => ipcRenderer.invoke('api:getFileDetail', fileId),
  searchFiles: (query: string) => ipcRenderer.invoke('api:searchFiles', query),
  createFolder: (name: string, parentId?: string) =>
    ipcRenderer.invoke('api:createFolder', name, parentId),
  moveFile: (fileId: string, targetId: string) =>
    ipcRenderer.invoke('api:moveFile', fileId, targetId),
  copyFile: (fileId: string, targetId: string) =>
    ipcRenderer.invoke('api:copyFile', fileId, targetId),

  // --- 技能管理接口（API Server）---
  getSkillList: (params?: unknown) => ipcRenderer.invoke('api:getSkillList', params),
  getSkill: (skillId: string) => ipcRenderer.invoke('api:getSkill', skillId),
  createSkill: (data: unknown) => ipcRenderer.invoke('api:createSkill', data),
  updateSkill: (skillId: string, data: unknown) =>
    ipcRenderer.invoke('api:updateSkill', skillId, data),
  deleteSkill: (skillId: string) => ipcRenderer.invoke('api:deleteSkill', skillId),
  executeSkill: (skillId: string, params: unknown) =>
    ipcRenderer.invoke('api:executeSkill', skillId, params),
  getSkillExecutionHistory: (skillId: string) =>
    ipcRenderer.invoke('api:getSkillExecutionHistory', skillId),
  getSkillStats: (skillId: string) => ipcRenderer.invoke('api:getSkillStats', skillId),
  exportSkill: (skillId: string) => ipcRenderer.invoke('api:exportSkill', skillId),

  // --- 系统管理接口 ---
  getSystemInfo: () => ipcRenderer.invoke('api:getSystemInfo'),
  getDiskUsage: () => ipcRenderer.invoke('api:getDiskUsage'),
  restartApp: () => ipcRenderer.invoke('api:restartApp'),
  checkForUpdates: () => ipcRenderer.invoke('api:checkForUpdates'),
  getEnvVars: () => ipcRenderer.invoke('api:getEnvVars'),
  getAppLogs: (params?: unknown) => ipcRenderer.invoke('api:getAppLogs', params),
  clearAppLogs: () => ipcRenderer.invoke('api:clearAppLogs'),
  getConfigModels: () => ipcRenderer.invoke('api:getConfigModels'),
  getChatModels: () => ipcRenderer.invoke('api:getChatModels'),
  setChatModel: (modelId: string) => ipcRenderer.invoke('api:setChatModel', modelId),
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
