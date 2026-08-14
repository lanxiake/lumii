/**
 * useSettings.types.ts - 设置管理类型定义
 */

/** Gateway 配置 */
export interface GatewayConfig {
  url: string
  token?: string
  deviceId?: string
  autoConnect: boolean
  reconnectInterval: number
  maxReconnectAttempts: number
}

/** 主题配置 */
export interface ThemeConfig {
  /** light/dark/system 为标准模式；ragdoll 为奶油布偶猫治愈浅色主题（原型 UI 方案一） */
  mode: 'light' | 'dark' | 'system' | 'ragdoll'
  primaryColor: string
  fontSize: 'small' | 'medium' | 'large' | 'xlarge'
  enableAnimations: boolean
}

/** 通知配置 */
export interface NotificationConfig {
  enabled: boolean
  soundEnabled: boolean
  showPreview: boolean
  desktopNotification: boolean
}

/** 隐私配置 */
export interface PrivacyConfig {
  sendUsageStats: boolean
  saveChatHistory: boolean
  historyRetentionDays: number
  /** 是否允许 Agent 操作本软件界面（app_screenshot / app_goto / app_act），默认开启 */
  allowAgentAppUiControl: boolean
}

/** 快捷键配置 */
export interface ShortcutConfig {
  sendMessage: string
  newChat: string
  toggleSidebar: string
  openSettings: string
  /** 全局快捷键：显示/隐藏窗口 */
  toggleWindow: string
  /** 全局快捷键：快速聊天 */
  quickChat: string
  /** 全局快捷键：截图 */
  screenshot: string
}

/** 工作空间配置 */
export interface WorkspaceConfig {
  directory: string
}

/** 窗口配置 */
export interface WindowConfig {
  /** 窗口透明度 0~1 */
  opacity: number
  /** 侧边栏宽度（像素） */
  sidebarWidth: number
}

/** 系统配置 */
export interface SystemConfig {
  /** 开机自启 */
  autoStart: boolean
  /** 最小化到托盘 */
  minimizeToTray: boolean
  /**
   * 启动时播放开机动画（默认 true）。
   * 关闭后主窗口直接进入界面；独立预览窗等本就不播放。
   */
  showSplashOnStartup: boolean
}

/** 记忆注入配置（Windows 客户端） */
export interface MemoryConfig {
  /** 是否将个人记忆（user_memory Markdown）注入系统提示词，默认开启 */
  injectPersonalMemory: boolean
  /** 是否将工作记忆（agent_memories SQLite 热记忆）注入系统提示词，默认开启 */
  injectWorkMemory: boolean
}

/** 应用设置 */
export interface AppSettings {
  gateway: GatewayConfig
  theme: ThemeConfig
  notification: NotificationConfig
  privacy: PrivacyConfig
  shortcuts: ShortcutConfig
  workspace: WorkspaceConfig
  window: WindowConfig
  system: SystemConfig
  memory: MemoryConfig
  language: 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR'
  checkUpdateOnStartup: boolean
}
