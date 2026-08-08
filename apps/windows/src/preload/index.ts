/**
 * Preload Script - 预加载脚本
 *
 * 在渲染进程加载前执行，提供安全的 IPC 桥接
 * 使用 contextBridge 暴露 API 给渲染进程
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { petApi } from './pet-api'
import type { PetElectronAPI } from '../shared/pet-mode'
// 仅类型引用，编译期擦除，不会把主进程代码打进 preload
import type { UsageSummary } from '../main/usage-store'
import type { NewsSnapshot } from '../main/news-store'
import type { DashboardFeedSnapshot } from '../main/dashboard-feed-store'
import type { LatencyView } from '../main/provider-latency'

// 日志输出
const log = {
  info: (...args: unknown[]) => console.log('[Preload]', ...args),
  error: (...args: unknown[]) => console.error('[Preload]', ...args),
}

log.info('预加载脚本开始执行')

/**
 * voice:event 单路复用：设置页有多个面板各自 onEvent，若每个都 ipcRenderer.on 会触发 MaxListenersExceeded。
 */
const voiceEventSubscribers = new Set<(event: unknown) => void>()
let voiceEventIpcBound = false

/**
 * 订阅语音事件（内部只挂一条 ipcRenderer 监听）
 */
function subscribeVoiceEvent(callback: (event: unknown) => void): () => void {
  voiceEventSubscribers.add(callback)
  if (!voiceEventIpcBound) {
    voiceEventIpcBound = true
    ipcRenderer.on('voice:event', (_evt, data: unknown) => {
      for (const cb of voiceEventSubscribers) {
        try {
          cb(data)
        } catch (e) {
          log.error('voice:event 订阅回调异常:', e)
        }
      }
    })
  }
  return () => {
    voiceEventSubscribers.delete(callback)
  }
}

/**
 * ACP 项目条目（与 main/config/types.ts 的 CodingDevProject 对齐）
 */
export interface CodingDevProject {
  name: string
  realPath: string
  isExternal: boolean
}

/**
 * 本地 LLM Provider 配置视图（与 main/provider-config.ts 对齐）
 */
export interface LocalProviderConfigView {
  enabled: boolean
  type: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'lmstudio'
  baseUrl: string
  modelId: string
  apiKey: string
  /** chat/vision：对话框可选模型列表 */
  allowedModelIds?: string[]
}

/** 模型能力槽 */
export type CapabilitySlot = 'chat' | 'vision' | 'image'

/** 全部能力槽配置 */
export interface ProviderSlotsConfigView {
  chat: LocalProviderConfigView
  vision: LocalProviderConfigView
  image: LocalProviderConfigView
}

/** 模型列表项 */
export interface ListedModel {
  id: string
  name: string
}

/** 连通性测试结果 */
export interface ProviderTestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

/**
 * 更新状态类型
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/**
 * 更新状态
 */
export interface UpdateState {
  /** 当前状态 */
  status: UpdateStatus
  /** 当前版本 */
  currentVersion: string
  /** 可用的新版本 */
  availableVersion?: string
  /** 更新说明 */
  releaseNotes?: string
  /** 发布日期 */
  releaseDate?: string
  /** 下载进度 (0-100) */
  downloadProgress?: number
  /** 下载速度 (bytes/s) */
  downloadSpeed?: number
  /** 已下载大小 */
  downloadedBytes?: number
  /** 总大小 */
  totalBytes?: number
  /** 错误信息 */
  error?: string
  /** 最后检查时间 */
  lastCheckTime?: number
}

/**
 * 更新配置
 */
export interface UpdaterConfig {
  /** 是否自动检查更新 */
  autoCheck: boolean
  /** 自动检查间隔 (毫秒) */
  checkInterval: number
  /** 是否自动下载 */
  autoDownload: boolean
  /** 是否自动安装 */
  autoInstall: boolean
  /** 是否允许预发布版本 */
  allowPrerelease: boolean
}

/**
 * 定义暴露给渲染进程的 API 类型
 */
export interface ElectronAPI {
  // 通用事件监听
  on: (channel: string, callback: (...args: unknown[]) => void) => void
  off: (channel: string, callback: (...args: unknown[]) => void) => void

  // 文件操作
  file: {
    list: (dirPath: string) => Promise<unknown[]>
    read: (filePath: string) => Promise<string>
    readAsBase64: (filePath: string) => Promise<{
      content: string
      mimeType: string
      size: number
      fileName: string
    }>
    write: (filePath: string, content: string) => Promise<void>
    move: (sourcePath: string, destPath: string) => Promise<void>
    copy: (sourcePath: string, destPath: string) => Promise<void>
    delete: (filePath: string) => Promise<void>
    createDir: (dirPath: string) => Promise<void>
    exists: (filePath: string) => Promise<boolean>
    getInfo: (filePath: string) => Promise<unknown>
    search: (dirPath: string, pattern: string, options?: unknown) => Promise<unknown[]>
  }

  // 系统信息
  system: {
    getInfo: () => Promise<unknown>
    getDiskInfo: () => Promise<unknown[]>
    getProcessList: () => Promise<unknown[]>
    killProcess: (pid: number) => Promise<void>
    launchApp: (appPath: string, args?: string[]) => Promise<void>
    executeCommand: (command: string) => Promise<{ stdout: string; stderr: string }>
    getUserPaths: () => Promise<{
      home: string
      desktop: string
      documents: string
      downloads: string
    }>
  }

  /** 本地用量与花费统计（Task 4.3，数据来自 ~/.lumii/usage/*.jsonl） */
  usage: {
    query: (query: {
      from: number
      to: number
      groupBy: 'hour' | 'day'
    }) => Promise<{ success: boolean; data?: UsageSummary; error?: string }>
    /** 到当前模型 provider 的首字节延迟（最近 N 次中位数） */
    latency: () => Promise<{ success: boolean; data?: LatencyView }>
  }

  /** 概览页资讯（由「资讯抓取与综述」定时任务写入 ~/.lumii/news/latest.json） */
  news: {
    /** 读最新一批资讯；从未抓过时 data 为 null */
    latest: () => Promise<{ success: boolean; data?: NewsSnapshot | null; error?: string }>
    /** 立即跑一次抓取+综述流水线，返回新快照 */
    refresh: () => Promise<{
      success: boolean
      data?: { summary: string; snapshot: NewsSnapshot | null }
      error?: string
    }>
  }

  /** Dashboard 当前激活的通用 feed；默认是资讯，也可由工作流替换。 */
  dashboardFeed: {
    latest: () => Promise<{ success: boolean; data?: DashboardFeedSnapshot | null; error?: string }>
    refresh: () => Promise<{
      success: boolean
      data?: { summary: string; snapshot: DashboardFeedSnapshot | null }
      error?: string
    }>
    setActive: (feedId: string) => Promise<{
      success: boolean
      data?: DashboardFeedSnapshot | null
      error?: string
    }>
  }

  // 窗口操作
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    /**
     * 光标相对窗口内容区坐标（穿透标题栏 drag 区域；边缘光效用）
     */
    getCursorClientPos: () => Promise<{ x: number; y: number; inside: boolean } | null>
  }

  /**
   * 与定时任务相同的桌面通知（主进程 Notification + 托盘 + 失焦时任务栏闪烁）
   */
  notifyDesktop: (title: string, body: string) => Promise<void>

  // 应用操作
  /** 本地 LLM Provider 配置（按能力槽 chat/vision/image） */
  provider: {
    getConfig: () => Promise<ProviderSlotsConfigView>
    setConfig: (cfg: ProviderSlotsConfigView | LocalProviderConfigView) => Promise<ProviderSlotsConfigView>
    listModels: (slot: CapabilitySlot) => Promise<{ success: boolean; data?: ListedModel[]; error?: string }>
    testConnection: (slot: CapabilitySlot) => Promise<ProviderTestResult>
  }
  /** 开机画面（主窗口内全屏） */
  splash: {
    /** 是否应跳过开机画面（托盘静默启动 / 测试模式 / 环境变量） */
    shouldSkip: () => boolean
  }
  app: {
    getVersion: () => Promise<string>
    getServerConfig: () => Promise<{ apiUrl: string; gatewayUrl: string }>
    updateServerConfig: (config: Partial<{ gatewayUrl: string; apiUrl: string }>) => Promise<void>
    quit: () => void
    openExternal: (url: string) => Promise<void>
    showItemInFolder: (filePath: string) => Promise<void>
    /** 在资源管理器中打开当前应用日志文件 */
    openLogFile: () => Promise<{ success: boolean; path?: string; error?: string }>
    /** 获取开机自启状态 */
    getOpenAtLogin: () => Promise<boolean>
    /** 设置开机自启 */
    setOpenAtLogin: (enable: boolean) => Promise<boolean>
    /** 重置所有数据并重启应用 */
    resetAllData: () => Promise<void>
    /** 开发类 AI 工具（ACP）环境说明与当前解析的工作区 */
    getCodingDevEnvInfo: () => Promise<{
      resolvedWorkspace: string
      usesDedicatedWorkspace: boolean
      powershellGatewayEnvBlock: string
      weixinSlashHint: string
    }>
    /** 探测本机 Cursor/Claude/Codex/Copilot/Gemini/OpenCode 是否已安装 */
    detectCodingDevTools: () => Promise<Array<{
      id: string
      label: string
      description: string
      installed: boolean
      resolvedPath?: string
      resolvedCommand?: string
      homepageUrl: string
      githubUrl?: string
      installUrl: string
      installCommand: string
      installHint: string
      currentVersion?: string
      latestVersion?: string
    }>>
    /** 一键安装本机 ACP CLI（执行官方白名单安装命令） */
    installCodingDevTool: (toolId: string) => Promise<{
      ok: boolean
      toolId: string
      exitCode: number | null
      stdout: string
      stderr: string
      status: {
        id: string
        label: string
        installed: boolean
        resolvedPath?: string
        installCommand: string
        installHint: string
        installUrl: string
        currentVersion?: string
        latestVersion?: string
      }
      message: string
    }>
    /** 设置 ACP 专用工作目录；传 undefined 或空则与主工作区一致 */
    setCodingDevAcpWorkspace: (dirPath: string | undefined) => Promise<void>
    /** 列出 ACP 项目及当前活动项目 */
    listCodingDevProjects: () => Promise<{ projects: CodingDevProject[]; activeProject?: string }>
    /** 新建项目（在 projects 目录下创建），成功后设为活动项目 */
    createCodingDevProject: (name: string) => Promise<{ projects: CodingDevProject[]; activeProject?: string }>
    /** 打开已有项目（软链接挂载到 projects 目录），成功后设为活动项目 */
    openCodingDevProject: (name: string, targetPath: string) => Promise<{ projects: CodingDevProject[]; activeProject?: string }>
    /** 移除项目（外部项目仅删链接，保留真实目录） */
    removeCodingDevProject: (name: string) => Promise<{ projects: CodingDevProject[]; activeProject?: string }>
    /** 设置活动项目（其 realPath 作为 ACP cwd） */
    setCodingDevActiveProject: (name: string) => Promise<{ projects: CodingDevProject[]; activeProject?: string }>
    /** 获取拖拽 File 对象的本地文件系统路径（Electron webUtils.getPathForFile） */
    getPathForFile: (file: File) => string
  }

  // 对话框
  dialog: {
    showOpenDialog: (options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
    showSaveDialog: (options: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>
    showMessageBox: (options: Electron.MessageBoxOptions) => Promise<Electron.MessageBoxReturnValue>
  }

  // 剪贴板
  clipboard: {
    readText: () => Promise<string>
    writeText: (text: string) => Promise<void>
    /** 将文件对象写入剪贴板，可在资源管理器/聊天框直接粘贴出文件 */
    writeFiles: (filePaths: string[]) => Promise<void>
  }

  // 自动更新
  updater: {
    /** 获取更新状态 */
    getState: () => Promise<UpdateState>
    /** 获取更新配置 */
    getConfig: () => Promise<UpdaterConfig>
    /** 更新配置 */
    updateConfig: (config: Partial<UpdaterConfig>) => Promise<UpdaterConfig>
    /** 检查更新 */
    checkForUpdates: () => Promise<UpdateState>
    /** 下载更新 */
    downloadUpdate: () => Promise<UpdateState>
    /** 安装更新 */
    installUpdate: () => void
    /** 启动自动检查 */
    startAutoCheck: () => void
    /** 停止自动检查 */
    stopAutoCheck: () => void
    /** 监听状态变化 */
    onStateChange: (callback: (state: UpdateState) => void) => () => void
  }

  // API Server HTTP 调用
  api: {
    /** 用户登录 */
    login: (params: { identifier: string; password: string; captchaToken?: string }) => Promise<unknown>
    /** 用户注册 */
    register: (params: {
      username?: string
      phone?: string
      email?: string
      password: string
      displayName?: string
      captchaToken?: string
    }) => Promise<unknown>
    /** 刷新访问令牌 */
    refreshToken: (refreshToken?: string) => Promise<unknown>
    /** 用户登出 */
    logout: (refreshToken?: string) => Promise<void>
    /** 发送验证码 */
    sendCode: (params: { phone?: string; email?: string; type?: string }) => Promise<unknown>
    /** 发起设备配对请求 */
    requestPairing: (params: {
      deviceId: string
      publicKey: string
      displayName?: string
      platform?: string
      role?: string
      silent?: boolean
    }) => Promise<unknown>
    /** 查询配对请求状态 */
    checkPairingStatus: (requestId: string) => Promise<unknown>
    /** 生成配对码（用于设备配对） */
    generatePairingCode: () => Promise<unknown>
    /** 获取当前用户信息 */
    getCurrentUser: () => Promise<unknown>
    /** 获取用户设备列表 */
    getUserDevices: () => Promise<unknown>
    /** 删除设备 */
    deleteDevice: (deviceId: string) => Promise<unknown>
    /** 更新设备信息 */
    updateDevice: (deviceId: string, updates: { alias?: string; isPrimary?: boolean }) => Promise<unknown>
    /** 更新用户信息 */
    updateUser: (params: { displayName?: string; avatar?: string }) => Promise<unknown>
    /** 修改密码 */
    changePassword: (params: { currentPassword: string; newPassword: string }) => Promise<unknown>
    /** 设置 API Server URL */
    setBaseUrl: (url: string) => Promise<void>
    /** 获取 API Server URL */
    getBaseUrl: () => Promise<string>
    /** 设置访问令牌（登录成功后同步到主进程） */
    setAccessToken: (token: string | null) => Promise<void>
    /** 检查认证状态 */
    checkAuth: () => Promise<unknown>
    /** 请求密码重置 */
    requestPasswordReset: (email: string) => Promise<unknown>

    // --- 聊天接口 ---
    /** 获取会话列表 */
    getConversations: () => Promise<unknown>
    /** 创建新会话 */
    createConversation: (params: { title?: string }) => Promise<unknown>
    /** 获取会话详情 */
    getConversationDetail: (conversationId: string) => Promise<unknown>
    /** 删除会话 */
    deleteConversation: (conversationId: string) => Promise<unknown>
    /** 获取消息列表 */
    getMessages: (conversationId: string, params?: { limit?: number; offset?: number }) => Promise<unknown>
    /** 发送消息 */
    sendMessage: (params: { conversationId: string; content: string; attachments?: string[] }) => Promise<unknown>
    /** 流式发送消息 */
    sendMessageStream: (params: { conversationId: string; content: string }, callbacks: unknown) => Promise<unknown>
    /** 重试消息 */
    retryMessage: (messageId: string) => Promise<unknown>
    /** 停止生成 */
    stopGenerating: (conversationId: string) => Promise<unknown>
    /** 清空会话 */
    clearConversation: (conversationId: string) => Promise<unknown>
    /** 获取建议回复 */
    getSuggestedReplies: (conversationId: string) => Promise<unknown>
    /** 评价消息 */
    rateMessage: (messageId: string, params: { rating: 'like' | 'dislike'; feedback?: string }) => Promise<unknown>

    // --- 验证码与安全接口 ---
    /** 获取滑动验证码 */
    getCaptchaChallenge: () => Promise<unknown>
    /** 验证滑动验证码 */
    verifyCaptcha: (captchaId: string, sliderX: number) => Promise<unknown>
    /** 获取 RSA 公钥 */
    getPublicKey: () => Promise<unknown>

    // --- 记忆接口（API Server /api/memories） ---
    getMemories: (options?: {
      type?: string
      category?: string
      activeOnly?: boolean
      limit?: number
      offset?: number
    }) => Promise<unknown>
    createMemory: (data: {
      type: string
      content: string
      category?: string
      summary?: string
      importance?: number
    }) => Promise<unknown>
    updateMemory: (
      id: string,
      data: { content?: string; summary?: string; category?: string; importance?: number },
    ) => Promise<unknown>
    deleteMemory: (id: string) => Promise<unknown>

    // --- 技能商店接口 ---
    /** 获取商店技能列表 */
    getStoreSkills: (filters?: {
      category?: string
      tags?: string[]
      subscription?: string
      sortBy?: string
      search?: string
      offset?: number
      limit?: number
    }) => Promise<unknown>
    /** 获取推荐技能 */
    getStoreFeatured: (limit?: number) => Promise<unknown>
    /** 获取热门技能 */
    getStorePopular: (limit?: number) => Promise<unknown>
    /** 获取最新技能 */
    getStoreRecent: (limit?: number) => Promise<unknown>
    /** 获取商店统计 */
    getStoreStats: () => Promise<unknown>
    /** 获取商店分类列表 */
    getStoreCategories: () => Promise<unknown>
    /** 获取商店技能详情 */
    getStoreSkillDetail: (skillId: string) => Promise<unknown>
    /** 安装商店技能（下载并解压到本地） */
    installStoreSkill: (skillId: string) => Promise<unknown>
    /** 提交技能到商店 */
    submitSkillToStore: (data: {
      name: string
      description?: string
      readme?: string
      version?: string
      categoryId?: string
      tags?: string[]
      config?: Record<string, unknown>
    }) => Promise<unknown>
    /** 创建用户自建技能 */
    createUserSkill: (data: {
      name: string
      description?: string
      version?: string
      code?: string
      manifest?: Record<string, unknown>
      status?: string
      metadata?: Record<string, unknown>
    }) => Promise<unknown>
    /** 刷新商店缓存 */
    refreshStore: () => Promise<unknown>

    // --- 审计日志接口 ---
    /** 查询审计日志 */
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
    }) => Promise<unknown>
    /** 获取最近审计日志 */
    getRecentAuditLogs: (limit?: number) => Promise<unknown>
    /** 获取审计日志统计 */
    getAuditStats: () => Promise<unknown>
    /** 获取审计配置 */
    getAuditConfig: () => Promise<unknown>
    /** 更新审计配置 */
    updateAuditConfig: (config: Record<string, unknown>) => Promise<unknown>
    /** 导出审计日志 */
    exportAuditLogs: (params: {
      format: string
      filters?: Record<string, unknown>
    }) => Promise<unknown>
    /** 清除审计日志 */
    clearAuditLogs: (beforeDate?: string) => Promise<unknown>

    // --- 用户记忆接口（新）---
    /** 获取用户记忆 */
    getUserMemory: () => Promise<unknown>
    /** 更新用户记忆 */
    updateUserMemory: (content: string) => Promise<unknown>

    // --- AI 灵魂接口 ---
    /** 获取 AI 灵魂内容（本地文件） */
    getSoulContent: () => Promise<unknown>
    /** 更新 AI 灵魂内容（本地文件） */
    updateSoulContent: (content: string) => Promise<unknown>

    // --- 技能运行时 + 节点列表 + 文件上传 ---
    /** 获取所有已加载技能列表（通过 Gateway WS） */
    listAllSkills: () => Promise<unknown>
    /** 获取 Gateway 节点列表（通过 Gateway WS） */
    listNodes: () => Promise<unknown>
    /** 上传技能文件（Base64，通过 API Server） */
    uploadSkillFile: (params: {
      skillId: string
      fileType: string
      originalName: string
      contentType: string
      data: string
    }) => Promise<unknown>

    // --- 文件管理接口 ---
    /** 获取文件列表 */
    getFileList: (path?: string) => Promise<unknown>
    /** 上传文件 */
    uploadFile: (file: unknown) => Promise<unknown>
    /** 下载文件 */
    downloadFile: (fileId: string) => Promise<unknown>
    /** 删除文件 */
    deleteFile: (fileId: string) => Promise<unknown>
    /** 获取文件详情 */
    getFileDetail: (fileId: string) => Promise<unknown>
    /** 搜索文件 */
    searchFiles: (query: string) => Promise<unknown>
    /** 创建文件夹 */
    createFolder: (name: string, parentId?: string) => Promise<unknown>
    /** 移动文件 */
    moveFile: (fileId: string, targetId: string) => Promise<unknown>
    /** 复制文件 */
    copyFile: (fileId: string, targetId: string) => Promise<unknown>

    // --- 技能管理接口（API Server） ---
    /** 获取技能列表 */
    getSkillList: (params?: unknown) => Promise<unknown>
    /** 获取技能详情 */
    getSkill: (skillId: string) => Promise<unknown>
    /** 创建技能 */
    createSkill: (data: unknown) => Promise<unknown>
    /** 更新技能 */
    updateSkill: (skillId: string, data: unknown) => Promise<unknown>
    /** 删除技能 */
    deleteSkill: (skillId: string) => Promise<unknown>
    /** 执行技能 */
    executeSkill: (skillId: string, params: unknown) => Promise<unknown>
    /** 获取技能执行历史 */
    getSkillExecutionHistory: (skillId: string) => Promise<unknown>
    /** 获取技能统计 */
    getSkillStats: (skillId: string) => Promise<unknown>
    /** 导出技能 */
    exportSkill: (skillId: string) => Promise<unknown>

    // --- 系统管理接口 ---
    /** 获取系统信息 */
    getSystemInfo: () => Promise<unknown>
    /** 获取磁盘使用情况 */
    getDiskUsage: () => Promise<unknown>
    /** 重启应用 */
    restartApp: () => Promise<unknown>
    /** 检查更新 */
    checkForUpdates: () => Promise<unknown>
    /** 获取环境变量 */
    getEnvVars: () => Promise<unknown>
    /** 获取应用日志 */
    getAppLogs: (params?: unknown) => Promise<unknown>
    /** 清空应用日志 */
    clearAppLogs: () => Promise<unknown>
    /** 获取模型 catalog（全部模型 + 元数据，来源 LiteLLM） */
    getConfigModels: () => Promise<unknown>
    /** 获取 chat 槽候选模型与用户当前选择 */
    getChatModels: () => Promise<unknown>
    /** 保存用户选择的 chat 模型 */
    setChatModel: (modelId: string) => Promise<unknown>
    /** 获取 Agent 列表 */
    getAgents: () => Promise<unknown>
    /** 获取 Agent 详情 */
    getAgent: (agentId: string) => Promise<unknown>
    /** Fork 系统 Agent */
    forkAgent: (systemAgentId: string, data: { name?: string; description?: string }) => Promise<unknown>
    /** 更新 Agent */
    updateAgent: (agentId: string, data: Record<string, unknown>) => Promise<unknown>
    /** 删除 Agent */
    deleteAgent: (agentId: string) => Promise<unknown>
    /** 获取用户技能列表 */
    getUserSkills: () => Promise<unknown>
  }

  // MemPalace 插件
  mempalace: {
    /** 检查安装状态 */
    getStatus: () => Promise<{ installed: boolean; runtimeDir: string }>
    /** 安装 MemPalace（异步，通过 on('install:progress') 接收进度） */
    install: () => Promise<{ success: boolean; error?: string }>
    /** 监听安装进度 */
    onInstallProgress: (cb: (msg: string) => void) => () => void
    /** 分页列出记忆 */
    list: (params?: { wing?: string; room?: string; limit?: number; offset?: number }) => Promise<{
      drawers: Array<{ drawer_id: string; wing: string; room: string; content_preview: string }>
      total: number; offset: number; limit: number; error?: string
    }>
    /** 语义搜索记忆 */
    search: (params: { query: string; limit?: number; wing?: string; room?: string }) => Promise<{
      results: Array<{ text: string; wing: string; room: string; similarity: number; drawer_id: string }>
      error?: string
    }>
    /** 删除单条记忆 */
    delete: (drawerId: string) => Promise<{ success: boolean; error?: string }>
    /** 清空全部记忆 */
    clear: () => Promise<{ success: boolean; deleted: number; error?: string }>
    /** 监听清空进度 */
    onClearProgress: (cb: (p: { deleted: number }) => void) => () => void
    /** 卸载 MemPalace（删除 Python 运行时，不删除记忆数据） */
    uninstall: () => Promise<{ success: boolean; error?: string }>
  }

  // 工作空间
  workspace: {
    /** 获取当前工作空间目录 */
    getDir: () => Promise<string>
    /** 验证并设置工作空间目录 */
    setDir: (dirPath: string) => Promise<string>
    /** 打开目录选择对话框，返回选中的目录路径，取消则返回 null */
    selectDir: (currentPath?: string) => Promise<string | null>
    /** 用户保存工作空间路径后调用，使节点重连并上报新路径，无需重启应用 */
    notifyChanged: (newDirPath?: string) => Promise<void>
    /** 确保工作空间目录及基本子结构存在 */
    ensureDir: (dirPath: string) => Promise<string>
    /** 确保 thread 目录结构存在（workspace/uploads/outputs） */
    ensureThreadDir: (threadId: string) => Promise<{
      root: string
      workspace: string
      uploads: string
      outputs: string
    }>
    /** 会话重命名后触发目录归档 */
    sessionRenamed: (threadId: string, newTitle: string) => Promise<boolean>
  }

  // 本地技能管理
  skills: {
    /** 列出本地已安装技能 */
    listLocalInstalled: () => Promise<unknown[]>
    /** 获取已安装技能列表（别名，兼容旧代码） */
    getInstalledSkills: () => Promise<unknown>
    /** 从目录安装技能（需含 skill.json） */
    installFromDirectory: (sourceDir: string) => Promise<{
      success: boolean
      skillId?: string
      error?: string
    }>
    /** 从外部目录导入技能（仅含 SKILL.md 的知识型技能，复制后自动注册） */
    importDirectory: (sourceDir: string) => Promise<{
      success: boolean
      skillId?: string
    }>
    /** 安装技能（别名，兼容旧代码） */
    installSkill: (params: unknown) => Promise<{
      success: boolean
      data?: unknown
      error?: string
    }>
    /** 卸载本地技能 */
    uninstallLocal: (skillId: string) => Promise<{
      success: boolean
      error?: string
    }>
    /** 卸载技能（别名，兼容旧代码） */
    uninstallSkill: (skillId: string) => Promise<{
      success: boolean
      error?: string
    }>
    /** 本地执行技能 */
    executeLocal: (params: {
      skillId: string
      params: Record<string, unknown>
      timeoutMs?: number
    }) => Promise<unknown>
    /** 启用/禁用技能 */
    setEnabled: (skillId: string, enabled: boolean) => Promise<boolean>
    /** 启用技能（别名，兼容旧代码） */
    enableSkill: (skillId: string) => Promise<boolean>
    /** 禁用技能（别名，兼容旧代码） */
    disableSkill: (skillId: string) => Promise<boolean>
    /** 更新技能配置 */
    updateSkillConfig: (skillId: string, config: unknown) => Promise<unknown>
    /** 获取技能详情 */
    getSkillDetail: (skillId: string) => Promise<{
      manifest: unknown
      indexEntry: unknown
    }>
    /** 从单文件脚本安装技能 */
    installFromScript: (filePath: string, meta?: {
      name?: string
      description?: string
    }) => Promise<{
      success: boolean
      skillId?: string
      error?: string
    }>
    /** 手动刷新：重新扫描本地技能目录并上报到 Gateway */
    refresh: () => Promise<{ success: boolean; count: number }>
    /** 获取技能所在目录的绝对路径 */
    getSkillDir: (skillId: string) => Promise<string>
  }

  // 设置管理
  settings: {
    /** 同步记忆注入开关到主进程缓存 */
    updateMemoryInjection: (config: {
      injectPersonalMemory?: boolean
      injectWorkMemory?: boolean
    }) => Promise<void>
  }

  // 认证 Token 安全存储（主进程 DPAPI 加密）
  auth: {
    /** 保存 refreshToken 到主进程加密存储 */
    saveRefreshToken: (token: string) => Promise<void>
    /** 从主进程获取 refreshToken */
    getRefreshToken: () => Promise<string | null>
    /** 清除主进程中的 refreshToken */
    clearRefreshToken: () => Promise<void>
    /** 通过主进程刷新 accessToken */
    refreshAccessToken: () => Promise<{ accessToken: string; refreshToken?: string }>
    /** 主进程自动刷新 token 成功后通知渲染进程同步内存状态 */
    onTokenRefreshed: (callback: (accessToken: string) => void) => () => void
    /** 主进程检测到 token 失效且刷新失败时通知渲染进程 */
    onTokenExpired: (callback: () => void) => () => void
  }

  // 客户端 Agent Runtime
  agentRuntime: {
    /** 获取 Feature Flags */
    getFeatureFlags: () => Promise<unknown>
    /** 设置 Feature Flags */
    setFeatureFlags: (flags: Record<string, boolean>) => Promise<unknown>
    /** 是否启用 */
    isEnabled: () => Promise<boolean>
    /** 创建 Agent 实例 */
    createInstance: (agentDef?: unknown) => Promise<{ ok: boolean; instanceId?: string; error?: string }>
    /** 通过 agentId 创建实例（DefinitionStore） */
    createInstanceById: (agentId: string) => Promise<{ ok: boolean; instanceId?: string; error?: string }>
    /** DefinitionStore 同步状态 */
    getDefinitionSyncStatus: () => Promise<{
      lastSyncAt: string | null
      isSyncing: boolean
      lastError: string | null
      lastResult: { synced: number; failed: number } | null
    }>
    syncUserAgentDefinitions: () => Promise<{ ok: boolean; synced?: number; failed?: number; error?: string }>
    listCachedAgentDefinitions: () => Promise<
      Array<{
        agentId: string
        version: number
        syncedAt: string
        name: string
        sourceType: string
        definitionBytes: number
      }>
    >
    removeCachedAgentDefinition: (agentId: string) => Promise<boolean>
    clearCachedAgentsOlderThan: (cutoffIso: string) => Promise<number>
    clearAllCachedAgentDefinitions: () => Promise<{ ok: boolean }>
    refreshCachedAgentDefinition: (agentId: string) => Promise<{ ok: boolean; error?: string }>
    /** 发送消息 */
    prompt: (instanceId: string, message: string) => Promise<{ ok: boolean; error?: string }>
    /** 中止 Agent */
    abort: (instanceId: string) => Promise<{ ok: boolean }>
    /** 销毁实例 */
    destroy: (instanceId: string) => Promise<{ ok: boolean }>
    /** 获取所有实例 */
    getInstances: () => Promise<Array<{ id: string; definitionId: string; state: string }>>
    /** 按定义 ID 聚合运行时快照（DetailPanel 运行状态） */
    getLifecycleSnapshot: (definitionId: string) => Promise<{
      definitionId: string
      instanceCount: number
      runningCount: number
      anyRunning: boolean
      runningSinceMs: number | null
      totalTurns: number
      totalInputTokens: number
      totalOutputTokens: number
      subAgentsRunning: number
    }>
    /** 监听 Agent Runtime 事件 */
    onEvent: (callback: (event: unknown) => void) => () => void
    /** [P3] 发送命令到主进程 Agent Runtime（新协议） */
    sendCommand: (command: unknown) => Promise<unknown>
    /** [P3] 监听特定类型的 Agent Runtime 事件 */
    onEventType: (eventType: string, handler: (event: unknown) => void) => () => void
    /** [P3] 检查新协议是否可用 */
    isAvailable: () => Promise<boolean>
    /** 本地 SQLite 存储占用与表行数 */
    getLocalStorageStats: () => Promise<{
      dbPath: string
      fileSizeBytes: number
      tableRowCounts: Record<string, number>
      conversationCount: number
      messageCount: number
      backupDir: string
      backupCount: number
      latestBackupAt: string | null
    }>
    /** 导出会话与消息为 JSON Lines */
    exportLocalDataJSONL: () => Promise<string>
    /** 删除 content_json 无法解析的消息行 */
    clearMalformedMessages: () => Promise<number>
    /** 列出本地 SQLite 自动备份（按时间降序） */
    listDatabaseBackups: () => Promise<Array<{
      fileName: string
      filePath: string
      sizeBytes: number
      modifiedAt: string
    }>>
    /** 立即创建本地 SQLite 备份 */
    createDatabaseBackup: () => Promise<{
      ok: boolean
      fileName?: string
      filePath?: string
      sizeBytes?: number
      modifiedAt?: string
      error?: string
    }>
    /** 从指定备份恢复聊天记录（会重建 Agent Runtime） */
    restoreDatabaseFromBackup: (backupFileName: string) => Promise<{
      ok: boolean
      conversationCount?: number
      messageCount?: number
      error?: string
    }>
    /** 从最新备份恢复聊天记录 */
    restoreDatabaseFromLatestBackup: () => Promise<{
      ok: boolean
      conversationCount?: number
      messageCount?: number
      backupFileName?: string
      error?: string
    }>
    /** 删除指定备份文件 */
    deleteDatabaseBackup: (backupFileName: string) => Promise<{
      ok: boolean
      error?: string
    }>
  }
  /** 语音通话 API */
  voice: {
    sendCommand: (command: unknown) => Promise<unknown>
    sendAudioChunk: (callId: string, samples: Float32Array) => void
    onEvent: (callback: (event: unknown) => void) => () => void
  }
  /** 宠物模式 API */
  pet: PetElectronAPI
  /** 文件预览独立窗口（可拖出主窗口） */
  filePreview: {
    open: (payload: {
      fileName: string
      fileId?: string
      filePath?: string
      userId?: string
      startLine?: number
      endLine?: number
      mdBasePath?: string
      editablePath?: string
    }) => Promise<{ ok: boolean }>
    close: () => Promise<{ ok: boolean }>
    getPayload: () => Promise<{
      fileName: string
      fileId?: string
      filePath?: string
      userId?: string
      startLine?: number
      endLine?: number
      mdBasePath?: string
      editablePath?: string
    } | null>
    onPayloadUpdated: (
      callback: (payload: {
        fileName: string
        fileId?: string
        filePath?: string
        userId?: string
        startLine?: number
        endLine?: number
        mdBasePath?: string
        editablePath?: string
      }) => void,
    ) => () => void
  }
  /** 插件中心 API */
  plugins: {
    cloak_browser: {
      getStatus: () => Promise<{ installed: boolean; version?: string; exePath?: string }>
      install: () => Promise<{ success: boolean; error?: string }>
      uninstall: () => Promise<{ success: boolean; error?: string }>
      cancel: () => Promise<{ success: boolean }>
      onProgress: (callback: (payload: {
        phase: 'checking' | 'downloading' | 'extracting' | 'done' | 'skipped' | 'error' | 'cancelled'
        percent?: number
        downloadedBytes?: number
        totalBytes?: number
        version?: string
        error?: string
        mirror?: string
      }) => void) => () => void
    }
  }

  // 工作空间 Git 版本管理 (VCS)
  vcs: {
    ensureInit: () => Promise<{ ok: boolean }>
    commit: (opts?: { message?: string }) => Promise<{ success: boolean; data?: unknown }>
    log: (opts?: { limit?: number; offset?: number }) => Promise<{ success: boolean; data?: unknown }>
    statusDiff: (opts?: { baseOid?: string }) => Promise<{ success: boolean; data?: unknown }>
    diff: (opts: { fromOid: string; toOid: string; withHunks?: boolean }) => Promise<{ success: boolean; data?: unknown }>
    diffFile: (opts: { fromOid: string; toOid: string; filepath: string }) => Promise<{ success: boolean; data?: unknown }>
    readFileAt: (opts: { oid: string; filepath: string }) => Promise<{ success: boolean; data?: unknown }>
    rollback: (opts: { oid: string }) => Promise<{ success: boolean; data?: unknown }>
    revertFile: (opts: { oid: string; filepath: string }) => Promise<{ success: boolean; data?: unknown }>
    findCommitByConversation: (opts: { conversationId: string }) => Promise<{ success: boolean; data?: unknown }>
  }
}

/**
 * 创建事件监听器移除函数
 */
function createEventListener(channel: string, callback: (...args: unknown[]) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
    callback(...args)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * 暴露给渲染进程的 API
 */
const electronAPI: ElectronAPI = {
  // 通用事件监听
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, listener)
  },
  off: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, callback as (...args: unknown[]) => void)
  },

  // 文件操作 API
  file: {
    list: (dirPath: string) => ipcRenderer.invoke('file:list', dirPath),
    read: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
    readAsBase64: (filePath: string) => ipcRenderer.invoke('file:readAsBase64', filePath),
    write: (filePath: string, content: string) => ipcRenderer.invoke('file:write', filePath, content),
    move: (sourcePath: string, destPath: string) =>
      ipcRenderer.invoke('file:move', sourcePath, destPath),
    copy: (sourcePath: string, destPath: string) =>
      ipcRenderer.invoke('file:copy', sourcePath, destPath),
    delete: (filePath: string) => ipcRenderer.invoke('file:delete', filePath),
    createDir: (dirPath: string) => ipcRenderer.invoke('file:createDir', dirPath),
    exists: (filePath: string) => ipcRenderer.invoke('file:exists', filePath),
    getInfo: (filePath: string) => ipcRenderer.invoke('file:getInfo', filePath),
    search: (dirPath: string, pattern: string, options?: unknown) =>
      ipcRenderer.invoke('file:search', dirPath, pattern, options),
  },

  // 系统信息 API
  system: {
    getInfo: () => ipcRenderer.invoke('system:getInfo'),
    getDiskInfo: () => ipcRenderer.invoke('system:getDiskInfo'),
    getProcessList: () => ipcRenderer.invoke('system:getProcessList'),
    killProcess: (pid: number) => ipcRenderer.invoke('system:killProcess', pid),
    launchApp: (appPath: string, args?: string[]) =>
      ipcRenderer.invoke('system:launchApp', appPath, args),
    executeCommand: (command: string) => ipcRenderer.invoke('system:executeCommand', command),
    getUserPaths: () => ipcRenderer.invoke('system:getUserPaths'),
  },

  usage: {
    query: (query: { from: number; to: number; groupBy: 'hour' | 'day' }) =>
      ipcRenderer.invoke('usage:query', query),
    latency: () => ipcRenderer.invoke('usage:latency'),
  },

  news: {
    latest: () => ipcRenderer.invoke('news:latest'),
    refresh: () => ipcRenderer.invoke('news:refresh'),
  },

  dashboardFeed: {
    latest: () => ipcRenderer.invoke('dashboard-feed:latest'),
    refresh: () => ipcRenderer.invoke('dashboard-feed:refresh'),
    setActive: (feedId: string) => ipcRenderer.invoke('dashboard-feed:set-active', feedId),
  },

  // 窗口操作 API
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    getCursorClientPos: () =>
      ipcRenderer.invoke('window:getCursorClientPos') as Promise<{
        x: number
        y: number
        inside: boolean
      } | null>,
  },

  notifyDesktop: (title: string, body: string) =>
    ipcRenderer.invoke('notify:desktop', { title, body }) as Promise<void>,

  // 本地 LLM Provider 配置（按能力槽）
  provider: {
    getConfig: () => ipcRenderer.invoke('provider:getConfig') as Promise<ProviderSlotsConfigView>,
    setConfig: (cfg: ProviderSlotsConfigView | LocalProviderConfigView) =>
      ipcRenderer.invoke('provider:setConfig', cfg) as Promise<ProviderSlotsConfigView>,
    listModels: (slot: CapabilitySlot) =>
      ipcRenderer.invoke('provider:listModels', slot) as Promise<{
        success: boolean
        data?: ListedModel[]
        error?: string
      }>,
    testConnection: (slot: CapabilitySlot) =>
      ipcRenderer.invoke('provider:testConnection', slot) as Promise<ProviderTestResult>,
  },

  splash: {
    shouldSkip: () =>
      process.argv.includes('--skip-splash')
      || process.argv.includes('--test-mode')
      || process.argv.includes('--startup-launched')
      || process.env.LUMII_SKIP_SPLASH === '1',
  },

  // 应用操作 API
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getServerConfig: () => ipcRenderer.invoke('app:getServerConfig') as Promise<{ apiUrl: string; gatewayUrl: string }>,
    updateServerConfig: (config: Partial<{ gatewayUrl: string; apiUrl: string }>) => ipcRenderer.invoke('app:updateServerConfig', config) as Promise<void>,
    quit: () => ipcRenderer.send('app:quit'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    showItemInFolder: (filePath: string) => ipcRenderer.invoke('app:showItemInFolder', filePath),
    openLogFile: () =>
      ipcRenderer.invoke('app:openLogFile') as Promise<{ success: boolean; path?: string; error?: string }>,
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    getOpenAtLogin: () => ipcRenderer.invoke('app:getOpenAtLogin'),
    setOpenAtLogin: (enable: boolean) => ipcRenderer.invoke('app:setOpenAtLogin', enable),
    resetAllData: () => ipcRenderer.invoke('app:resetAllData'),
    getCodingDevEnvInfo: () => ipcRenderer.invoke('app:getCodingDevEnvInfo'),
    detectCodingDevTools: () => ipcRenderer.invoke('app:detectCodingDevTools'),
    installCodingDevTool: (toolId: string) => ipcRenderer.invoke('app:installCodingDevTool', toolId),
    setCodingDevAcpWorkspace: (dirPath: string | undefined) =>
      ipcRenderer.invoke('app:setCodingDevAcpWorkspace', dirPath),
    listCodingDevProjects: () => ipcRenderer.invoke('app:listCodingDevProjects'),
    createCodingDevProject: (name: string) =>
      ipcRenderer.invoke('app:createCodingDevProject', name),
    openCodingDevProject: (name: string, targetPath: string) =>
      ipcRenderer.invoke('app:openCodingDevProject', name, targetPath),
    removeCodingDevProject: (name: string) =>
      ipcRenderer.invoke('app:removeCodingDevProject', name),
    setCodingDevActiveProject: (name: string) =>
      ipcRenderer.invoke('app:setCodingDevActiveProject', name),
  },

  // 对话框 API
  dialog: {
    showOpenDialog: (options: Electron.OpenDialogOptions) =>
      ipcRenderer.invoke('dialog:showOpenDialog', options) as Promise<Electron.OpenDialogReturnValue>,
    showSaveDialog: (options: Electron.SaveDialogOptions) =>
      ipcRenderer.invoke('dialog:showSaveDialog', options) as Promise<Electron.SaveDialogReturnValue>,
    showMessageBox: (options: Electron.MessageBoxOptions) =>
      ipcRenderer.invoke('dialog:showMessageBox', options) as Promise<Electron.MessageBoxReturnValue>,
  },

  // 剪贴板 API
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:readText'),
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
    writeFiles: (filePaths: string[]) => ipcRenderer.invoke('clipboard:writeFiles', filePaths),
  },

  // 自动更新 API
  updater: {
    getState: () => ipcRenderer.invoke('updater:getState'),
    getConfig: () => ipcRenderer.invoke('updater:getConfig'),
    updateConfig: (config: Partial<UpdaterConfig>) =>
      ipcRenderer.invoke('updater:updateConfig', config),
    checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
    downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
    installUpdate: () => ipcRenderer.invoke('updater:installUpdate'),
    startAutoCheck: () => ipcRenderer.invoke('updater:startAutoCheck'),
    stopAutoCheck: () => ipcRenderer.invoke('updater:stopAutoCheck'),
    onStateChange: (callback: (state: UpdateState) => void) =>
      createEventListener('updater:state-change', callback as (...args: unknown[]) => void),
  },

  // API Server HTTP 调用
  api: {
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

    // --- 记忆管理接口 ---
    getUserMemory: () =>
      ipcRenderer.invoke('api:getUserMemory'),
    updateUserMemory: (content: string) =>
      ipcRenderer.invoke('api:updateUserMemory', content),

    // --- AI 灵魂接口 ---
    getSoulContent: () =>
      ipcRenderer.invoke('api:getSoulContent'),
    updateSoulContent: (content: string) =>
      ipcRenderer.invoke('api:updateSoulContent', content),

    // --- 技能运行时 + 节点列表 + 文件上传 ---
    listAllSkills: () =>
      ipcRenderer.invoke('api:listAllSkills'),
    listNodes: () =>
      ipcRenderer.invoke('api:listNodes'),
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

    // --- 技能管理接口（API Server） ---
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

    // --- Agent 管理接口 ---
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
  },

  // MemPalace 插件
  mempalace: {
    getStatus: () => ipcRenderer.invoke('plugin:mempalace:status'),
    install: () => ipcRenderer.invoke('plugin:mempalace:install'),
    onInstallProgress: (cb: (msg: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, msg: string) => cb(msg)
      ipcRenderer.on('plugin:mempalace:install:progress', handler)
      return () => ipcRenderer.removeListener('plugin:mempalace:install:progress', handler)
    },
    list: (params?: object) => ipcRenderer.invoke('plugin:mempalace:list', params),
    search: (params: object) => ipcRenderer.invoke('plugin:mempalace:search', params),
    delete: (drawerId: string) => ipcRenderer.invoke('plugin:mempalace:delete', drawerId),
    clear: () => ipcRenderer.invoke('plugin:mempalace:clear'),
    onClearProgress: (cb: (p: { deleted: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, p: { deleted: number }) => cb(p)
      ipcRenderer.on('plugin:mempalace:clear:progress', handler)
      return () => ipcRenderer.removeListener('plugin:mempalace:clear:progress', handler)
    },
    uninstall: () => ipcRenderer.invoke('plugin:mempalace:uninstall'),
  },

  // 工作空间 API
  workspace: {
    getDir: () => ipcRenderer.invoke('workspace:getDir'),
    setDir: (dirPath: string) => ipcRenderer.invoke('workspace:setDir', dirPath),
    selectDir: (currentPath?: string) => ipcRenderer.invoke('workspace:selectDir', currentPath),
    /** 用户保存工作空间路径后调用，使节点重连并上报新路径，无需重启应用 */
    notifyChanged: (newDirPath?: string) => ipcRenderer.invoke('workspace:notifyChanged', newDirPath),
    ensureDir: (dirPath: string) => ipcRenderer.invoke('workspace:ensureDir', dirPath),
    ensureThreadDir: (threadId: string) => ipcRenderer.invoke('workspace:ensureThreadDir', threadId),
    sessionRenamed: (threadId: string, newTitle: string) =>
      ipcRenderer.invoke('workspace:sessionRenamed', threadId, newTitle),
  },

  // 本地技能管理 API
  skills: {
    listLocalInstalled: () =>
      ipcRenderer.invoke('skills:listLocalInstalled'),
    getInstalledSkills: () =>
      ipcRenderer.invoke('skills:listLocalInstalled'),
    installFromDirectory: (sourceDir: string) =>
      ipcRenderer.invoke('skills:installFromDirectory', sourceDir),
    importDirectory: (sourceDir: string) =>
      ipcRenderer.invoke('skills:importDirectory', sourceDir),
    installSkill: (params: unknown) =>
      ipcRenderer.invoke('skills:installFromDirectory', params),
    uninstallLocal: (skillId: string) =>
      ipcRenderer.invoke('skills:uninstallLocal', skillId),
    uninstallSkill: (skillId: string) =>
      ipcRenderer.invoke('skills:uninstallLocal', skillId),
    executeLocal: (params: {
      skillId: string
      params: Record<string, unknown>
      timeoutMs?: number
    }) => ipcRenderer.invoke('skills:executeLocal', params),
    setEnabled: (skillId: string, enabled: boolean) =>
      ipcRenderer.invoke('skills:setEnabled', skillId, enabled),
    enableSkill: (skillId: string) =>
      ipcRenderer.invoke('skills:setEnabled', skillId, true),
    disableSkill: (skillId: string) =>
      ipcRenderer.invoke('skills:setEnabled', skillId, false),
    updateSkillConfig: (skillId: string, config: unknown) =>
      ipcRenderer.invoke('skills:updateConfig', skillId, config),
    getSkillDetail: (skillId: string) =>
      ipcRenderer.invoke('skills:getSkillDetail', skillId),
    installFromScript: (filePath: string, meta?: {
      name?: string
      description?: string
    }) => ipcRenderer.invoke('skills:installFromScript', filePath, meta),
    refresh: () => ipcRenderer.invoke('skills:refresh'),
    getSkillDir: (skillId: string) => ipcRenderer.invoke('skills:getSkillDir', skillId),
  },

  // 认证 Token 安全存储 API
  auth: {
    saveRefreshToken: (token: string) =>
      ipcRenderer.invoke('auth:saveRefreshToken', token),
    getRefreshToken: () =>
      ipcRenderer.invoke('auth:getRefreshToken'),
    clearRefreshToken: () =>
      ipcRenderer.invoke('auth:clearRefreshToken'),
    refreshAccessToken: () =>
      ipcRenderer.invoke('auth:refreshAccessToken'),
    onTokenRefreshed: (callback: (accessToken: string) => void) =>
      createEventListener('auth:token-refreshed', callback as (...args: unknown[]) => void),
    onTokenExpired: (callback: () => void) =>
      createEventListener('auth:token-expired', callback as (...args: unknown[]) => void),
  },

  // 客户端 Agent Runtime API（全部经 agent-runtime:command，与 M08 Preload 审计一致）
  agentRuntime: (() => {
    const send = (command: unknown) => ipcRenderer.invoke('agent-runtime:command', command)
    return {
      getFeatureFlags: () => send({ type: 'runtime:featureFlags:get' }),
      setFeatureFlags: (flags: Record<string, boolean>) =>
        send({ type: 'runtime:featureFlags:set', flags }),
      isEnabled: () => send({ type: 'runtime:enabled' }),
      createInstance: (agentDef?: unknown) =>
        send({ type: 'agentInstance:create', agentDef }),
      createInstanceById: (agentId: string) =>
        send({ type: 'agentInstance:createById', agentId }),
      getDefinitionSyncStatus: () => send({ type: 'agentDefinition:syncStatus' }),
      syncUserAgentDefinitions: () => send({ type: 'agentDefinition:syncUserAgents' }),
      listCachedAgentDefinitions: () => send({ type: 'agentDefinition:cacheList' }),
      removeCachedAgentDefinition: (agentId: string) =>
        send({ type: 'agentDefinition:cacheRemove', agentId }),
      clearCachedAgentsOlderThan: (cutoffIso: string) =>
        send({ type: 'agentDefinition:cacheClearOlder', cutoffIso }),
      clearAllCachedAgentDefinitions: () =>
        send({ type: 'agentDefinition:cacheClearAll' }),
      refreshCachedAgentDefinition: (agentId: string) =>
        send({ type: 'agentDefinition:cacheRefresh', agentId }),
      prompt: (instanceId: string, message: string) =>
        send({ type: 'agentInstance:prompt', instanceId, message }),
      abort: (instanceId: string) =>
        send({ type: 'agentInstance:abort', instanceId }),
      destroy: (instanceId: string) =>
        send({ type: 'agentInstance:destroy', instanceId }),
      getInstances: () => send({ type: 'agentInstance:list' }),
      getLifecycleSnapshot: (definitionId: string) =>
        send({ type: 'agentInstance:lifecycleSnapshot', definitionId }),
      onEvent: (callback: (event: unknown) => void) => {
        const listenerCountBefore = ipcRenderer.listenerCount('agent-runtime:event')
        console.log('[Preload] onEvent 注册 agent-runtime:event, 注册前监听器数量:', listenerCountBefore, new Error('stack').stack?.split('\n').slice(1, 4).join(' | '))
        const unsub = createEventListener('agent-runtime:event', (evt: unknown) => {
          const listenerCount = ipcRenderer.listenerCount('agent-runtime:event')
          const evtType = evt && typeof evt === 'object' && 'type' in evt ? (evt as { type: string }).type : 'unknown'
          if (evtType === 'conversation:message:new' || evtType === 'agent:idle' || evtType === 'agent:turn:start') {
            console.log(`[Preload] onEvent 分发 type=${evtType} 当前监听器数量=${listenerCount}`)
          }
          callback(evt)
        })
        return () => {
          console.log('[Preload] onEvent 注销 agent-runtime:event')
          unsub()
        }
      },
      sendCommand: send,
      onEventType: (eventType: string, handler: (event: unknown) => void) => {
        const listenerCountBefore = ipcRenderer.listenerCount('agent-runtime:event')
        console.log('[Preload] onEventType 注册 agent-runtime:event, eventType:', eventType, '注册前监听器数量:', listenerCountBefore, new Error('stack').stack?.split('\n').slice(1, 4).join(' | '))
        const listener = (_ipcEvt: Electron.IpcRendererEvent, evt: unknown) => {
          if (evt && typeof evt === 'object' && 'type' in evt && (evt as { type: string }).type === eventType) {
            handler(evt)
          }
        }
        ipcRenderer.on('agent-runtime:event', listener)
        return () => {
          console.log('[Preload] onEventType 注销 agent-runtime:event, eventType:', eventType)
          ipcRenderer.removeListener('agent-runtime:event', listener)
        }
      },
      isAvailable: () =>
        send({ type: 'runtime:ping' }).then(() => true).catch(() => false),
      getLocalStorageStats: () => send({ type: 'storage:stats' }),
      exportLocalDataJSONL: () => send({ type: 'storage:exportJsonl' }),
      clearMalformedMessages: () => send({ type: 'storage:clearMalformed' }),
      listDatabaseBackups: () => send({ type: 'storage:listBackups' }),
      createDatabaseBackup: () => send({ type: 'storage:createBackup' }),
      restoreDatabaseFromBackup: (backupFileName: string) =>
        send({ type: 'storage:restoreBackup', backupFileName }),
      restoreDatabaseFromLatestBackup: () => send({ type: 'storage:restoreLatestBackup' }),
      deleteDatabaseBackup: (backupFileName: string) =>
        send({ type: 'storage:deleteBackup', backupFileName }),
    }
  })(),

  // 设置管理（记忆注入等需主进程感知的项）
  settings: {
    /** 同步记忆注入开关到主进程缓存 */
    updateMemoryInjection: (config: {
      injectPersonalMemory?: boolean
      injectWorkMemory?: boolean
    }): Promise<void> => ipcRenderer.invoke('settings:updateMemoryInjection', config),
  },

  // 语音通话 API（voice:event 经单路复用，避免设置页多面板叠加触发 MaxListenersExceeded）
  voice: {
    /** 发送语音命令（invoke 模式，有响应） */
    sendCommand: (command: unknown): Promise<unknown> =>
      ipcRenderer.invoke('voice:command', command),
    /** 发送 PCM 音频帧（单向高频，无响应） */
    sendAudioChunk: (callId: string, samples: Float32Array): void => {
      const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
      ipcRenderer.send('voice:audio:chunk', callId, buf)
    },
    /** 订阅语音事件，返回取消订阅函数（单路 IPC，避免 MaxListenersExceeded） */
    onEvent: (callback: (event: unknown) => void): () => void => {
      return subscribeVoiceEvent(callback)
    },
  },

  // 宠物模式 API
  pet: petApi,
  filePreview: {
    open: (payload) => ipcRenderer.invoke('file-preview:open', payload),
    close: () => ipcRenderer.invoke('file-preview:close'),
    getPayload: () => ipcRenderer.invoke('file-preview:get-payload'),
    onPayloadUpdated: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: Parameters<typeof callback>[0],
      ) => callback(payload)
      ipcRenderer.on('file-preview:payload-updated', listener)
      return () => {
        ipcRenderer.removeListener('file-preview:payload-updated', listener)
      }
    },
  },
  /** 插件中心 API */

  // 插件中心 API
  plugins: {
    cloak_browser: {
      getStatus: () => ipcRenderer.invoke('plugin:cloak-browser:status'),
      install: () => ipcRenderer.invoke('plugin:cloak-browser:install'),
      uninstall: () => ipcRenderer.invoke('plugin:cloak-browser:uninstall'),
      cancel: () => ipcRenderer.invoke('plugin:cloak-browser:cancel'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onProgress: (callback: (payload: any) => void): () => void => {
        return createEventListener('cloak-browser-progress', (payload: unknown) => {
          callback(payload)
        })
      },
    },
  },

  // 工作空间 Git 版本管理 (VCS)
  vcs: {
    ensureInit: () => ipcRenderer.invoke('vcs:ensureInit'),
    commit: (opts?: { message?: string }) => ipcRenderer.invoke('vcs:commit', opts),
    log: (opts?: { limit?: number; offset?: number }) => ipcRenderer.invoke('vcs:log', opts),
    statusDiff: (opts?: { baseOid?: string }) => ipcRenderer.invoke('vcs:statusDiff', opts),
    diff: (opts: { fromOid: string; toOid: string; withHunks?: boolean }) => ipcRenderer.invoke('vcs:diff', opts),
    diffFile: (opts: { fromOid: string; toOid: string; filepath: string }) =>
      ipcRenderer.invoke('vcs:diffFile', opts),
    readFileAt: (opts: { oid: string; filepath: string }) => ipcRenderer.invoke('vcs:readFileAt', opts),
    rollback: (opts: { oid: string }) => ipcRenderer.invoke('vcs:rollback', opts),
    revertFile: (opts: { oid: string; filepath: string }) => ipcRenderer.invoke('vcs:revertFile', opts),
    findCommitByConversation: (opts: { conversationId: string }) => ipcRenderer.invoke('vcs:findCommitByConversation', opts),
  },
}

// 通过 contextBridge 安全地暴露 API
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// === 微信(iLink)渠道 API ===
contextBridge.exposeInMainWorld('weixinService', {
  /** 初始化微信登录流程，返回二维码 data URL */
  startLogin: (): Promise<string> => ipcRenderer.invoke('weixin:startLogin'),
  /** 登出微信 */
  logout: (): Promise<void> => ipcRenderer.invoke('weixin:logout'),
  /** 获取当前登录状态 */
  getStatus: (): Promise<string> => ipcRenderer.invoke('weixin:getStatus'),
  /** 获取当前会话信息 */
  getSession: (): Promise<unknown> => ipcRenderer.invoke('weixin:getSession'),

  /** 监听登录状态变化事件，返回取消监听函数 */
  onStatusChange: (callback: (status: string, session?: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string, session: unknown) => callback(status, session)
    ipcRenderer.on('weixin:statusChange', handler)
    return () => ipcRenderer.removeListener('weixin:statusChange', handler)
  },
  /** 监听二维码事件，返回取消监听函数 */
  onQrcode: (callback: (dataUrl: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, dataUrl: string) => callback(dataUrl)
    ipcRenderer.on('weixin:qrcode', handler)
    return () => ipcRenderer.removeListener('weixin:qrcode', handler)
  },
  /** 监听错误事件，返回取消监听函数 */
  onError: (callback: (message: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('weixin:error', handler)
    return () => ipcRenderer.removeListener('weixin:error', handler)
  },
  /** 移除指定通道的所有监听器 */
  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(`weixin:${channel}`)
  },
})

// === 企业微信(AI Bot)渠道 API ===
contextBridge.exposeInMainWorld('wecomService', {
  /** 发起扫码接入 */
  startLogin: (): Promise<void> => ipcRenderer.invoke('wecom:startLogin'),
  /** 断开并清除本地凭证 */
  logout: (): Promise<void> => ipcRenderer.invoke('wecom:logout'),
  /** 获取当前连接状态 */
  getStatus: (): Promise<string> => ipcRenderer.invoke('wecom:getStatus'),
  /** 获取会话摘要（不含 secret） */
  getSession: (): Promise<unknown> => ipcRenderer.invoke('wecom:getSession'),

  onStatusChange: (callback: (status: string, session?: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string, session: unknown) =>
      callback(status, session)
    ipcRenderer.on('wecom:statusChange', handler)
    return () => ipcRenderer.removeListener('wecom:statusChange', handler)
  },
  onQrcode: (callback: (dataUrl: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, dataUrl: string) => callback(dataUrl)
    ipcRenderer.on('wecom:qrcode', handler)
    return () => ipcRenderer.removeListener('wecom:qrcode', handler)
  },
  onError: (callback: (message: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('wecom:error', handler)
    return () => ipcRenderer.removeListener('wecom:error', handler)
  },
})

// === 飞书渠道 API ===
contextBridge.exposeInMainWorld('feishuService', {
  startLogin: (): Promise<void> => ipcRenderer.invoke('feishu:startLogin'),
  logout: (): Promise<void> => ipcRenderer.invoke('feishu:logout'),
  getStatus: (): Promise<string> => ipcRenderer.invoke('feishu:getStatus'),
  getSession: (): Promise<unknown> => ipcRenderer.invoke('feishu:getSession'),

  onStatusChange: (callback: (status: string, session?: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string, session: unknown) =>
      callback(status, session)
    ipcRenderer.on('feishu:statusChange', handler)
    return () => ipcRenderer.removeListener('feishu:statusChange', handler)
  },
  onQrcode: (callback: (dataUrl: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, dataUrl: string) => callback(dataUrl)
    ipcRenderer.on('feishu:qrcode', handler)
    return () => ipcRenderer.removeListener('feishu:qrcode', handler)
  },
  onError: (callback: (message: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('feishu:error', handler)
    return () => ipcRenderer.removeListener('feishu:error', handler)
  },
})

log.info('预加载脚本执行完成，API 已暴露')

// 为 TypeScript 类型声明
declare global {
  interface Window {
    electronAPI: ElectronAPI
    weixinService: {
      startLogin: () => Promise<string>
      logout: () => Promise<void>
      getStatus: () => Promise<string>
      getSession: () => Promise<unknown>
      onStatusChange: (callback: (status: string, session?: unknown) => void) => (() => void)
      onQrcode: (callback: (dataUrl: string) => void) => (() => void)
      onError: (callback: (message: string) => void) => (() => void)
      removeAllListeners: (channel: string) => void
    }
    wecomService: {
      startLogin: () => Promise<void>
      logout: () => Promise<void>
      getStatus: () => Promise<string>
      getSession: () => Promise<unknown>
      onStatusChange: (callback: (status: string, session?: unknown) => void) => (() => void)
      onQrcode: (callback: (dataUrl: string) => void) => (() => void)
      onError: (callback: (message: string) => void) => (() => void)
    }
    feishuService: {
      startLogin: () => Promise<void>
      logout: () => Promise<void>
      getStatus: () => Promise<string>
      getSession: () => Promise<unknown>
      onStatusChange: (callback: (status: string, session?: unknown) => void) => (() => void)
      onQrcode: (callback: (dataUrl: string) => void) => (() => void)
      onError: (callback: (message: string) => void) => (() => void)
    }
  }
}
