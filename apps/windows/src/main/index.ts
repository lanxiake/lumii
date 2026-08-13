/**
 * MtBot Assistant - Windows 客户端主进程入口
 *
 * 职责：
 * - 创建和管理应用窗口
 * - 管理系统托盘
 * - 与 Gateway 建立 WebSocket 连接
 * - 处理 IPC 通信
 */

/**
 * 全局 EPIPE 错误保护
 *
 * 当父进程终端关闭后，stdout/stderr 管道断开，
 * Node.js 的 SyncWriteStream.writeSync 会抛出 EPIPE 同步异常，
 * 导致 Electron 弹出 "A JavaScript error occurred in the main process" 崩溃对话框。
 *
 * 此处通过 uncaughtException 过滤 EPIPE 错误，仅静默忽略管道断开，
 * 其他未捕获异常仍正常传播。
 */
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
    return
  }
  remoteLogShipper?.ship({ level: 'error', event: 'uncaught_exception', message: err.stack ?? err.message })
  // eslint-disable-next-line no-console
  process.stderr?.write?.(`Uncaught exception: ${err.stack ?? err.message}\n`)
  process.exit(1)
})

import { execSync, spawn } from 'child_process'
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, clipboard, screen, Notification } from 'electron'
import { join, extname, basename, dirname } from 'path'
import { promises as fs, existsSync, readdirSync } from 'fs'
import { TrayManager } from './tray-manager'
import { getAppIconPath } from './asset-paths'
import { SystemService } from './system-service'
import { queryUsage, type UsageQuery } from './usage-store'
import { flushToolUsage } from './tool-usage-store'
import { readNewsSnapshot } from './news-store'
import { NEWS_PIPELINE_TASK_TEXT, NEWS_PIPELINE_SYSTEM_PROMPT } from './seed-cron-jobs'
import {
  readActiveDashboardFeedSnapshot,
  setActiveDashboardFeedId,
} from './dashboard-feed-store'
import { getLatency } from './provider-latency'
import { UpdaterService, setupUpdaterIpcHandlers } from './updater-service'
import { ClientSkillRuntime } from './skill-runtime'
import { wrapSingleFile } from './skill-wrapper'
import {
  loadProviderConfig,
  loadProviderSlotsConfig,
  saveProviderConfig,
  saveProviderSlotsConfig,
  loadSlotConfig,
  applyImageSlotToDrawEnv,
  isCapabilitySlot,
  type LocalProviderConfigView,
  type ProviderSlotsConfigView,
  type CapabilitySlot,
} from './provider-config'
import { listProviderModels, testProviderConnection } from './provider-probe'
import {
  listAgents,
  getAgentRecord,
  listUserAgentRecords,
  forkAgentRecord,
  updateAgentRecord,
  deleteAgentRecord,
} from './agents-repo'
import {
  validateUrl,
  validatePid,
  securityUtils,
  SecurityError,
} from './security-utils'
import { fileLogger } from './file-logger'
import { createWindowsLogShipper, type RemoteLogShipper } from './remote-log-shipper'
import { SkillWatcher } from './skill-watcher'
import { seedBundledSkills } from './bundled-skills-seeder'
import { startBrowserService, stopBrowserService, getBrowserContext } from './browser-service'
import os from 'os'
import { loadServerConfig, type ServerConfig } from './server-config'
import { directoryManager } from './directory-manager'
import { ConfigManager } from './config-manager'

import { WeixinLoginService } from './weixin-login-service'
import { WeixinChannelAdapter } from './channel/adapters/weixin-channel-adapter'
import { WecomLoginService } from './wecom-login-service'
import { WecomChannelAdapter } from './channel/adapters/wecom-channel-adapter'
import { FeishuLoginService } from './feishu-login-service'
import { FeishuChannelAdapter } from './channel/adapters/feishu-channel-adapter'
import { AcpBackendManager } from './channel/acp-backend-manager'
import {
  AgentRuntimeBridge,
  installAgentRuntimeCommandIpc,
  setAgentRuntimeBridgeForIpc,
  setWeixinBindingManagerForIpc,
  setAudioTranscribeCallback,
  setIpcMainWindow,
  getAcpBackendManager,
  getSessionKeyForInstance,
  invalidateAgentInstancesForProviderChange,
} from './agent-runtime'
import { submitVoiceTranscript } from './ipc/agent-runtime-ipc.js'
import { VoiceModelManager } from './voice/model-manager.js'
import { VoiceCallService } from './voice/voice-service.js'
import { registerVoiceIpc } from './voice/voice-ipc.js'
import { loadVoiceEngineConfig } from './voice/voice-config-store.js'
import { getWorkspaceVcs, resetWorkspaceVcs } from './workspace-vcs/vcs-snapshot'
import { getProjectGitStatus } from './project-git/project-git-status'
import { findBuiltInAgent, mapApiRecordToAgentDefinition } from '@mtbot/agent-runtime'
import {
  applyCodingDevAcpEnvToProcess,
  buildCodingDevEnvInfo,
  defaultWorkspaceFallback,
  resolveCodingDevAcpWorkspacePath,
} from './coding-dev-env.js'
import {
  detectLocalAcpTool,
  isPrimaryLocalAcpToolId,
  listLocalAcpToolsMetadata,
  needsWindowsShell,
} from './coding-dev-cli-detect.js'
import {
  installLocalAcpTool,
  previewUninstallLocalAcpTool,
  uninstallLocalAcpTool,
} from './coding-dev-cli-install.js'
import {
  createProject,
  openExistingProject,
  removeProject,
  reconcileProjectsWithDisk,
} from './coding-dev-projects.js'
import { resolveClientStateDir, resolvePluginRuntimeDir } from './paths'
import { registerSkillnetStoreHandlers } from './skillnet-store'
import { SkillEvolutionEngine } from './skill-evolution/index'
import {
  registerPetModeIpc,
  switchPetMode,
  isPetMode,
  isPetForceIgnore,
  disablePetForceIgnore,
  disposePetModeIpc,
} from './pet/pet-mode-ipc'
import { registerFilePreviewWindowIpc } from './file-preview/preview-window-ipc'

if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore', windowsHide: true })
  } catch {
  }
}

const log = {
  info: (...args: unknown[]) => console.log('[Main]', ...args),
  error: (...args: unknown[]) => {
    console.error('[Main]', ...args)
    remoteLogShipper?.ship({ level: 'error', event: 'main_error', message: args.map(String).join(' ') })
  },
  warn: (...args: unknown[]) => {
    console.warn('[Main]', ...args)
    remoteLogShipper?.ship({ level: 'warn', event: 'main_warn', message: args.map(String).join(' ') })
  },
}

/**
 * 服务器配置
 * 优先级：环境变量 > 配置文件 > 默认值
 */
let serverConfig: ServerConfig | null = null

async function getServerConfig(): Promise<ServerConfig> {
  if (!serverConfig) {
    serverConfig = await loadServerConfig()
    const { loadDrawConfig } = await import('./draw-config.js')
    await loadDrawConfig()
    // 用户在设置里配置的 image 槽优先生效
    applyImageSlotToDrawEnv()
  }
  return serverConfig
}

// 全局变量
let mainWindow: BrowserWindow | null = null
let trayManager: TrayManager | null = null
let remoteLogShipper: RemoteLogShipper | null = null

/**
 * 桌面任务通知：优先使用 Electron 系统通知；仅在不可用或失败时回退到托盘气球，避免同一事件出现两个弹窗。
 * 窗口未聚焦时仍任务栏闪烁。
 *
 * @param title - 通知标题
 * @param body - 正文（宜简短）
 */
function showDesktopTaskNotification(title: string, body: string): void {
  log.info(`[DesktopNotify] title="${title}" body="${body.slice(0, 80)}"`)
  let usedElectron = false
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title,
        body,
        silent: false,
        timeoutType: 'never',
        urgency: 'critical',
      })
      n.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.focus()
        }
      })
      n.show()
      usedElectron = true
    }
  } catch (err) {
    log.warn('[DesktopNotify] Electron Notification 失败:', err)
  }
  if (!usedElectron) {
    trayManager?.showNotification(title, body)
  }
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
    trayManager?.flashWindow(mainWindow)
    mainWindow.once('focus', () => trayManager?.stopFlash(mainWindow!))
  }
}
// 灵栖/Lumii 独立版：无网关、无后端、无设备配对，相关运行时实例已删除。
let systemService: SystemService | null = null
let updaterService: UpdaterService | null = null
let skillRuntime: ClientSkillRuntime | null = null
let skillWatcher: SkillWatcher | null = null
let configManager: ConfigManager | null = null

let weixinLoginService: WeixinLoginService | null = null  // 微信(iLink)登录服务
let wecomLoginService: WecomLoginService | null = null  // 企业微信 AI Bot 扫码服务
let feishuLoginService: FeishuLoginService | null = null  // 飞书扫码服务
let agentRuntimeBridge: AgentRuntimeBridge | null = null  // 客户端 Agent Runtime
let voiceCallService: VoiceCallService | null = null  // 语音通话服务
let isQuitting = false
let isCleaningUp = false // 防止 before-quit 清理期间重复触发

/**
 * 根据屏幕分辨率动态计算窗口大小
 * 
 * 规则：
 * - 窗口宽度 = 屏幕宽度的 70%（最小 800，最大 1400）
 * - 窗口高度 = 屏幕高度的 80%（最小 600，最大 900）
 * - 使用主显示器的工作区域大小（排除任务栏）
 * 
 * @returns 计算后的窗口宽度和高度
 */
function calculateWindowSize(): { width: number; height: number } {
  try {
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize
    
    // 计算窗口宽度：屏幕宽度的 70%，限制在 800-1400 之间
    const calculatedWidth = Math.floor(screenWidth * 0.7)
    const width = Math.min(Math.max(calculatedWidth, 800), 1400)
    
    // 计算窗口高度：屏幕高度的 80%，限制在 600-900 之间
    const calculatedHeight = Math.floor(screenHeight * 0.8)
    const height = Math.min(Math.max(calculatedHeight, 600), 900)
    
    log.info(`屏幕分辨率: ${screenWidth}x${screenHeight}, 计算窗口大小: ${width}x${height}`)
    
    return { width, height }
  } catch (error) {
    // 如果获取屏幕信息失败，使用默认值
    log.warn('获取屏幕信息失败，使用默认窗口大小', error)
    return { width: 800, height: 700 }
  }
}

/**
 * 创建主窗口
 */
/**
 * 配置 Content Security Policy
 * 允许连接到配置的 Gateway 地址和 API Server 地址
 */
async function setupContentSecurityPolicy(window: BrowserWindow): Promise<void> {
  // 完全禁用 CSP 检查（用于消除 YouTube、gsap 等外部资源的限制）
  // Electron 应用运行在受信任的环境中，无需 CSP 限制
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders || {}

    // 移除所有 CSP 相关头部
    delete responseHeaders['Content-Security-Policy']
    delete responseHeaders['content-security-policy']
    delete responseHeaders['Content-Security-Policy-Report-Only']
    delete responseHeaders['content-security-policy-report-only']

    callback({ responseHeaders })
  })
}

function createWindow(isTestMode: boolean = false, startHidden: boolean = false): Promise<void> {
  log.info('创建主窗口', { isTestMode, startHidden })

  // 动态计算窗口大小
  const { width, height } = calculateWindowSize()

  const extraArgs = [
    ...(isTestMode ? ['--test-mode'] : []),
    // 托盘静默启动时跳过主窗口内开机画面
    ...(startHidden ? ['--skip-splash'] : []),
  ]

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 700,
    minHeight: 600,
    frame: false, // 无边框窗口
    transparent: false,
    resizable: true,
    show: false, // 初始不显示，等待 ready-to-show（此时 early-splash 已在绘海报/视频）
    backgroundColor: '#e8f2fa', // 与开机画面柔和冰蓝白底色一致，避免出窗瞬间闪深色
    icon: getAppIconPath(), // 窗口 / 任务栏圆形图标（与产品 Logo 一致）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // 需要关闭 sandbox 以支持 node 模块
      webviewTag: true, // 允许 <webview> 用于 HTML 文件沙箱预览
      // 开机动画带声自动播放
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: extraArgs,
    },
  })

  const readyToShow = new Promise<void>((resolve) => {
    mainWindow!.once('ready-to-show', () => {
      log.info('主窗口 ready-to-show')
      resolve()
    })
  })

  // 窗口显示时确保 webContents 获得焦点（修复无边框窗口输入问题）
  mainWindow.on('show', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus()
        mainWindow.webContents.focus()
      }
    }, 100)
  })

  // 关闭窗口时隐藏而不是退出
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
      log.info('窗口已隐藏到托盘')
    }
  })
  mainWindow.on('closed', () => {
    setIpcMainWindow(null)
  })

  // 配置 Content Security Policy，允许连接到 Gateway
  setupContentSecurityPolicy(mainWindow)
  // 将主窗口引用注入 ACP 事件推送层
  setIpcMainWindow(mainWindow)

  // 渲染进程诊断：把渲染层 console / 崩溃 / 加载失败转写到文件日志。
  // 生产环境默认无 DevTools，渲染层报错原本不可见（表现为黑屏），此处使其可追踪。
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = `[Renderer:console] ${message}`
    if (level >= 3) log.error(tag, `(${sourceId}:${line})`)
    else if (level === 2) log.warn(tag)
    else log.info(tag)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error(`[Renderer] 渲染进程崩溃 reason=${details.reason} exitCode=${details.exitCode}`)
  })
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error(`[Renderer] preload 脚本错误 path=${preloadPath} error=${error?.message}`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log.error(`[Renderer] 页面加载失败 code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
  })

  /**
   * 原生右键菜单：对选中文本提供"复制"，输入框内额外提供剪切/粘贴/全选。
   * 覆盖文件预览、聊天记录、输入框等所有可选文本区域，复制走系统级最可靠。
   */
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.trim().length > 0
    const isEditable = params.isEditable
    if (!hasSelection && !isEditable) return

    const template: Electron.MenuItemConstructorOptions[] = []
    if (isEditable && params.editFlags.canCut) {
      template.push({ label: '剪切', role: 'cut' })
    }
    if (hasSelection && params.editFlags.canCopy) {
      template.push({ label: '复制', role: 'copy' })
    }
    if (isEditable && params.editFlags.canPaste) {
      template.push({ label: '粘贴', role: 'paste' })
    }
    if (isEditable && params.editFlags.canSelectAll) {
      if (template.length > 0) template.push({ type: 'separator' })
      template.push({ label: '全选', role: 'selectAll' })
    }
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: mainWindow! })
  })

  // 加载渲染进程页面（与开机画面并行）
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL

    // dev 模式：renderer dev server 可能还没完全 ready，加载失败时自动重试
    let retryCount = 0
    const maxRetries = 10
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDesc) => {
      if (retryCount < maxRetries && errorCode === -102) { // ERR_CONNECTION_REFUSED
        retryCount++
        log.info(`等待 renderer dev server 就绪... (${retryCount}/${maxRetries})`)
        setTimeout(() => {
          mainWindow?.loadURL(rendererUrl)
        }, 1000)
      }
    })
    mainWindow.loadURL(rendererUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    if (isTestMode) {
      // 测试模式：添加查询参数到URL
      const htmlPath = join(__dirname, '../renderer/index.html')
      mainWindow.loadURL(`file://${htmlPath}?test-mode=true`)
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  return (async () => {
    if (startHidden) {
      await readyToShow
      log.info('开机启动模式：窗口已就绪，隐藏到托盘（不显示）')
      return
    }

    await readyToShow
    log.info('窗口准备就绪，显示并聚焦（开机画面在主窗口内全屏播放）')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })()
}

/**
 * 初始化系统托盘
 */
function initTray(): void {
  log.info('初始化系统托盘')

  trayManager = new TrayManager({
    onShowWindow: () => {
      mainWindow?.show()
      mainWindow?.focus()
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
    onOpenSettings: () => {
      // 显示并聚焦主窗口
      mainWindow?.show()
      mainWindow?.focus()
      // 通过 IPC 通知渲染进程导航到设置页面
      mainWindow?.webContents.send('navigate-to-settings')
    },
    onTogglePetMode: () => {
      const next = isPetMode() ? 'desktop' : 'pet'
      // 托盘/设置页状态同步由 onModeChanged 统一处理，无需在此重复
      void switchPetMode(next)
    },
    onDisableForceIgnore: () => {
      disablePetForceIgnore()
      trayManager?.updateForceIgnore(isPetForceIgnore())
    },
  })
}

/**
 * 初始化系统服务
 */
function initSystemService(): void {
  log.info('初始化系统服务')
  systemService = new SystemService()
}

/**
 * 初始化技能运行时
 */
async function initSkillRuntime(): Promise<void> {
  log.info('初始化技能运行时')

  // 创建技能运行时实例
  skillRuntime = new ClientSkillRuntime()

  // 设置 SystemService 引用
  if (systemService) {
    skillRuntime.setSystemService(systemService)
  }

  // 设置确认对话框处理器
  skillRuntime.setConfirmHandler(async (skillName: string, params: Record<string, unknown>) => {
    if (!mainWindow) {
      return false
    }

    mainWindow.show()
    mainWindow.focus()

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '技能执行确认',
      message: `技能 "${skillName}" 请求执行以下操作：`,
      detail: JSON.stringify(params, null, 2),
      buttons: ['取消', '允许'],
      defaultId: 0,
      cancelId: 0,
    })

    return result.response === 1
  })

  // 初始化技能运行时
  // 优先使用 ConfigManager 中的工作空间目录（主进程直接读取，无竞态条件）
  const mtbotDataDir = resolveClientStateDir()
  const defaultWorkspaceBase = join(mtbotDataDir, 'workspace')
  const configuredWorkspace = configManager?.getAppConfig().workspaceDirectory
  const skillsBaseDir = configuredWorkspace || defaultWorkspaceBase
  const skillsDir = join(skillsBaseDir, 'skills')
  // 技能执行日志写入客户端数据根下 logs/skills/，与 DirectoryManager 规划一致
  const skillLogsDir = join(mtbotDataDir, 'logs', 'skills')
  await skillRuntime.initialize(skillsDir, false, skillLogsDir)

  log.info('技能运行时初始化完成')
}

/**
 * 初始化技能监控器
 */
async function initSkillWatcher(): Promise<void> {
  log.info('初始化技能监控器')

  // 与 seedBundledSkills 保持一致：优先 configManager，回退到客户端数据根下 workspace/
  const mtbotDataDir = resolveClientStateDir()
  const workspaceDir = configManager?.getAppConfig().workspaceDirectory
    || join(mtbotDataDir, 'workspace')

  // 创建技能监控器实例
  skillWatcher = new SkillWatcher(workspaceDir)

  // 设置本地技能变更回调（Agent 在客户端执行，无需上报网关）
  skillWatcher.setOnSkillsChanged((skills) => {
    log.info(`[SkillWatcher] 技能列表已更新: ${skills.length} 个技能`)
    // 通知渲染进程技能列表已变更
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('skills:updated', skills)
    }
  })

  // 启动监控器（start 内部会执行初始扫描，初始化技能索引）
  await skillWatcher.start()

  log.info('技能监控器初始化完成')
}

/**
 * 初始化自动更新服务
 */
function initUpdaterService(): void {
  log.info('初始化自动更新服务')

  updaterService = new UpdaterService({
    autoCheck: false, // 发布渠道未配置前禁用，避免请求不存在的仓库
    checkInterval: 4 * 60 * 60 * 1000, // 4小时检查一次
    autoDownload: false,
    autoInstall: false,
    allowPrerelease: false,
  })

  // 设置主窗口引用
  if (mainWindow) {
    updaterService.setMainWindow(mainWindow)
  }

  // 设置 IPC 处理器
  setupUpdaterIpcHandlers(updaterService)

  // 生产环境下启动自动检查
  if (process.env.NODE_ENV !== 'development') {
    updaterService.startAutoCheck()
  }
}

/**
 * 初始化客户端 Agent Runtime
 *
 * Feature Flag 默认关闭，需在设置中手动启用。
 * 初始化过程仅注册 IPC handlers 和创建 bridge 实例。
 */
async function initAgentRuntime(): Promise<void> {
  log.info('初始化客户端 Agent Runtime')

  const config = await getServerConfig()
  // 独立版无云端 Gateway；保留本地占位 URL 供遗留接口兼容，不打印网关地址
  const rawGatewayUrl = config.gatewayUrl ?? 'http://127.0.0.1:18789'
  const gatewayUrl = rawGatewayUrl.replace(/^ws(s?):\/\//, 'http$1://')
  log.info(`[AgentRuntime] 独立版本地模式（不连接云端 Gateway）`)

  agentRuntimeBridge = new AgentRuntimeBridge({
    gatewayUrl,
    // 关闭 Pre-LLM Router：它每轮在主回复前串行做一次独立 LLM 调用（实测 2.5-4.3s），
    // 是首响应慢的主因。技能发现已工具化（skill_list/search/invoke 按需调用），
    // 主 prompt 不再依赖 Router 预筛选，关闭后主 LLM 立即开跑、按需自助路由。
    routerEnabled: false,
    // 灵栖/Lumii 独立版：本地 provider 配置（enabled 时 Agent 走 direct 直连）
    getProviderConfig: () => loadProviderConfig(),
    // 灵栖/Lumii 独立版：无网关、无设备配对，LLM 走本地 provider direct 直连，无需认证 token
    getAuthToken: async () => '',
    getDeviceId: () => undefined,
    getWindow: () => mainWindow,
    getCwd: () => {
      const appConfig = configManager?.getAppConfig()
      return appConfig?.workspaceDirectory ?? directoryManager.getDirectory('workspace')
    },
    getSkills: async () => {
      if (!skillRuntime) return []
      const installed = await skillRuntime.listLocalInstalled()
      const skillStore = skillRuntime.getSkillStore()
      // 读取系统自动推断的激活范围（来自历史调用统计，无需用户配置）
      const autoScopeMap = skillStore?.getAutoScopeMap() ?? new Map()
      const { parseSkillMdFrontmatter, parseSkillRequires, hasBinary } = await import('./skill-md-frontmatter.js')

      const results: Array<{
        id: string
        name: string
        description: string
        location: string
        whenToUse?: string
        executable?: boolean
        activationScope?: "always" | "contextual" | "on_demand"
      }> = []

      const EXECUTABLE_ENTRIES = ['run.ts', 'run.js', 'run.py', 'run.sh', 'run.ps1']

      for (const s of installed) {
        if (!s.enabled || !s.description) continue

        const skillDir = skillStore?.getSkillDirectory(s.id)
        const location = skillDir
          ? join(skillDir, 'SKILL.md')
          : s.category
            ? `skills/${s.category}/${s.dirName}/SKILL.md`
            : `skills/${s.dirName}/SKILL.md`

        let description = s.description!
        let whenToUse: string | undefined
        let activationScope: "always" | "contextual" | "on_demand" | undefined

        // 硬过滤：读取 SKILL.md 解析 requires；同时取完整 description / when_to_use / activation_scope 供系统提示词使用
        if (skillDir) {
          try {
            const content = await fs.readFile(location, 'utf-8')
            const fm = parseSkillMdFrontmatter(content)
            const requires = parseSkillRequires(fm.metadata)

            if (fm.description?.trim()) {
              description = fm.description.trim()
            }
            if (fm.whenToUse?.trim()) {
              whenToUse = fm.whenToUse.trim()
            }
            if (fm.activationScope) {
              activationScope = fm.activationScope
            }

            // bins：所有列出的二进制必须存在
            if (requires?.bins?.length) {
              if (!requires.bins.every((b) => hasBinary(b))) {
                log.info(`[getSkills] 技能 "${s.name}" 被过滤：缺少必要二进制 bins=${requires.bins.join(',')}`)
                continue
              }
            }

            // anyBins：至少一个存在
            if (requires?.anyBins?.length) {
              if (!requires.anyBins.some((b) => hasBinary(b))) {
                log.info(`[getSkills] 技能 "${s.name}" 被过滤：anyBins 中无可用二进制 anyBins=${requires.anyBins.join(',')}`)
                continue
              }
            }
          } catch {
            // 读取/解析失败：降级保留此技能，不因解析错误误删
          }
        }

        // 检测是否为 executable 技能（有可执行入口文件）
        const executable = skillDir
          ? EXECUTABLE_ENTRIES.some((f) => existsSync(join(skillDir, f)))
          : false

        // 优先用 frontmatter 手动配置，否则用系统自动推断的范围（修复 #5：日志区分来源）
        const autoScope = autoScopeMap.get(s.id)
        const effectiveScope = activationScope ?? autoScope
        if (effectiveScope && effectiveScope !== 'contextual') {
          const source = activationScope ? 'manual(frontmatter)' : 'auto(data-driven)'
          log.info(`[getSkills] "${s.name}" scope=${effectiveScope} source=${source}`)
        }

        const entry: typeof results[number] = { id: s.id, name: s.name, description, location }
        if (whenToUse) entry.whenToUse = whenToUse
        if (executable) entry.executable = true
        if (effectiveScope) entry.activationScope = effectiveScope
        results.push(entry)
      }

      log.info(`[getSkills] 返回 ${results.length}/${installed.length} 个技能（已过滤依赖不满足项，${results.filter(r => r.executable).length} 个 executable）`)
      return results
    },
    updateSkillAutoScope: async (deltas) => {
      const store = skillRuntime?.getSkillStore()
      if (!store) return
      await store.updateAutoScopeBatch(deltas)
    },
    getCustomAgents: async () => {
      // 灵栖/Lumii：从本地 agents 仓库读取用户自建 Agent（注入系统提示词多 Agent 段）
      return listUserAgentRecords()
        .filter((a) => a.isEnabled !== false)
        .map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          emoji: a.identity?.emoji,
        }))
    },
    /** 独立版无跨设备概念，返回空列表 */
    getUserDevices: async () => [],
    /** 获取用户 SOUL 内容（从本地文件 ~/.lumii/data/soul.md 读取） */
    getSoulContent: async () => {
      try {
        const p = getSoulFilePath()
        if (!existsSync(p)) return undefined
        const content = await fs.readFile(p, 'utf-8')
        return content.trim() || undefined
      } catch {
        return undefined
      }
    },
    /** 读取用户记忆（用于 profile_memory / memory_search 工具，本地文件 ~/.lumii/data/user-memory.md） */
    getUserMemory: async () => readUserMemoryFile(),
    /** MemPalace 语义搜索（用于 memory_search 工具优先路径） */
    searchMempalace: async (query: string, limit?: number) => {
      try {
        const installed = await checkMemPalaceInstalled()
        if (!installed) return null
        await ensureMemPalacePalaceDir()
        const bridge = getMemPalaceBridge()
        return await bridge.searchDrawers({ query, limit: limit ?? 10 })
      } catch (err) {
        log.warn(`[MemPalace] 搜索失败: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },
    /** 按 drawer_id 读取记忆宫殿归档原文（memory_read 工具） */
    readMempalaceDrawer: async (drawerId: string) => {
      try {
        const installed = await checkMemPalaceInstalled()
        if (!installed) return null
        await ensureMemPalacePalaceDir()
        const bridge = getMemPalaceBridge()
        const detail = await bridge.getDrawer(drawerId)
        if (!detail?.drawer_id || !detail.content) return null
        return {
          drawer_id: detail.drawer_id,
          content: detail.content,
          wing: detail.wing,
          room: detail.room,
          metadata: detail.metadata,
        }
      } catch (err) {
        log.warn(`[MemPalace] 读取 drawer 失败: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },
    /** 读取记忆注入开关（从渲染进程 localStorage 同步） */
    getMemoryInjectionSettings: async () => {
      if (memoryInjectionSettingsCache) {
        return memoryInjectionSettingsCache
      }
      const settings = await getRendererSettings()
      const memory = settings?.memory
      const resolved = {
        injectPersonalMemory: memory?.injectPersonalMemory !== false,
        injectWorkMemory: memory?.injectWorkMemory !== false,
      }
      memoryInjectionSettingsCache = resolved
      return resolved
    },
    /**
     * 段原文归档进 MemPalace（诉求 A · 宫殿互引）。
     * MemPalace 3.5.x 的 mempalace_add_drawer 仅接受 wing/room/content/source_file/added_by，
     * 不接受 drawer_id/metadata；drawer_id 由 Python 侧 make_drawer_id_from_content 生成并返回。
     * 同一 (wing, room, content) 重复归档幂等。返回值优先用 Python 的 drawer_id，否则回退本地 ID。
     * 未安装/失败返回 undefined（runtime 降级，仅保留原文回溯不互引）。
     */
    archiveMempalaceDrawer: async (params) => {
      try {
        const installed = await checkMemPalaceInstalled()
        if (!installed) return undefined
        await ensureMemPalacePalaceDir()
        const bridge = getMemPalaceBridge()
        const segmentId = params.metadata?.segmentId
        const result = (await bridge.callTool('mempalace_add_drawer', {
          content: params.content,
          wing: params.wing,
          room: params.room,
          added_by: 'mtbot-windows',
          // 3.5.x 无 metadata 参数，用 source_file 保留段溯源
          ...(segmentId != null ? { source_file: `segment:${String(segmentId)}` } : {}),
        })) as { drawer_id?: string; id?: string } | null
        return { drawerId: result?.drawer_id ?? result?.id ?? params.drawerId }
      } catch (err) {
        log.warn(`[MemPalace] 段归档失败: ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      }
    },
    /** 更新用户记忆（用于 profile_memory 工具，写入本地文件 ~/.lumii/data/user-memory.md） */
    updateUserMemory: async (content: string) => writeUserMemoryFile(content),
    /** 更新用户 SOUL 内容（写入本地文件 ~/.lumii/data/soul.md） */
    updateSoulContent: async (content: string) => {
      try {
        const p = getSoulFilePath()
        await fs.mkdir(dirname(p), { recursive: true })
        await fs.writeFile(p, content, 'utf-8')
        return { updatedAt: new Date().toISOString() }
      } catch {
        return undefined
      }
    },
    fetchAgentDefinitionById: async (id: string) => {
      const built = findBuiltInAgent(id)
      if (built) return built
      // 灵栖/Lumii：从本地 agents 仓库解析用户 Agent 定义
      const rec = getAgentRecord(id)
      if (!rec) return undefined
      return mapApiRecordToAgentDefinition(rec as unknown as Record<string, unknown>)
    },
    fetchAgentDefinitionsFromApi: async () => {
      // 灵栖/Lumii：从本地 agents 仓库返回全部 Agent 定义
      return listAgents().agents.map((a) => mapApiRecordToAgentDefinition(a as unknown as Record<string, unknown>))
    },
    callGateway: async (_method: string, _params?: unknown) => {
      // 灵栖/Lumii 独立版：无网关，Agent 运行时不应发起网关调用
      throw new Error('独立版不支持网关连接')
    },
    showCronNotification: (title: string, body: string) => {
      log.info(`[AgentRuntime:CronNotify] title="${title}" body="${body.slice(0, 60)}"`)
      showDesktopTaskNotification(title, body)
    },
    sendWeixinMessage: async ({ text, filePath }) => {
      try {
        if (!weixinLoginService) {
          return { ok: false, error: '微信服务未初始化' }
        }
        // bridge 内部已检查 currentWeixinCtx 非空才会调用此回调，直接从 bridge 获取
        const weixinCtx = agentRuntimeBridge?.getCurrentWeixinCtx()
        if (!weixinCtx) {
          return { ok: false, error: '没有活跃的微信会话上下文，请先在微信发送一条消息' }
        }
        const { channelUserId, contextToken, botToken, ilinkBaseUrl } = weixinCtx
        log.info(`[sendWeixinMessage] ctx: channelUserId=${channelUserId} contextToken=${contextToken ? '有' : '无'} botToken=${botToken ? '有' : '无'} ilinkBaseUrl=${ilinkBaseUrl ?? '默认'}`)
        if (filePath) {
          const fileName = filePath.split(/[\\/]/).pop() ?? filePath
          // 先发文字说明（如果有），再发文件
          if (text) {
            await weixinLoginService.sendTextReply(channelUserId, text, contextToken, botToken, ilinkBaseUrl)
          }
          const ok = await weixinLoginService.sendMediaReply(channelUserId, filePath, fileName, contextToken, botToken, ilinkBaseUrl)
          log.info(`[sendWeixinMessage] 文件发送 ok=${ok} channelUserId=${channelUserId} file=${fileName}`)
          return { ok, error: ok ? undefined : '文件发送失败，请查看主进程日志' }
        }
        if (text) {
          const ok = await weixinLoginService.sendTextReply(channelUserId, text, contextToken, botToken, ilinkBaseUrl)
          log.info(`[sendWeixinMessage] 文本发送 ok=${ok} channelUserId=${channelUserId}`)
          return { ok }
        }
        return { ok: false, error: '未提供 text 或 mediaUrl 参数' }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error(`[sendWeixinMessage] 异常: ${msg}`)
        return { ok: false, error: `发送异常: ${msg}` }
      }
    },
    sendFeishuMessage: async (text: string) => {
      if (!feishuLoginService) return { ok: false, error: '飞书服务未初始化' }
      return feishuLoginService.pushText(text)
    },
    generateVoiceFile: async (
      text: string,
      opts?: { speaker?: string; speed?: number },
    ) => {
      if (!voiceCallService) throw new Error('语音通话服务未初始化')
      const workspaceDir = getWorkspaceDir()
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const destDir = join(workspaceDir, 'uploads', dateStr)
      return voiceCallService.generateAudioFile(text, destDir, opts)
    },
    /** 执行本地 executable 技能（由 execute_skill 工具调用） */
    executeSkill: async (skillId: string, params: Record<string, unknown>) => {
      if (!skillRuntime) {
        return { success: false, error: 'SkillRuntime 未初始化', executionTimeMs: 0 }
      }
      const { randomUUID } = await import('node:crypto')
      const result = await skillRuntime.executeSkill({
        requestId: randomUUID(),
        skillId,
        params,
        requireConfirm: false, // 工具层已由 needsPermission 控制确认，跳过二次弹窗
        timeoutMs: 120000,
        runMode: 'local',
      })
      return {
        success: result.success,
        result: result.result,
        error: result.error?.message,
        executionTimeMs: result.executionTimeMs,
      }
    },
    onConversationEnd: (convId: string, assistantText: string) => {
      void (async () => {
        try {
          const installed = await checkMemPalaceInstalled()
          if (!installed) return
          await ensureMemPalacePalaceDir()
          const bridge = getMemPalaceBridge()
          await bridge.callTool('mempalace_add_drawer', {
            wing: 'conversations',
            room: convId,
            content: assistantText,
            added_by: 'mtbot-windows',
          })
          log.info(`[MemPalace] 记忆已写入 convId=${convId} len=${assistantText.length}`)
        } catch (err) {
          log.warn(`[MemPalace] 记忆写入失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      })()
    },
    setAcpBackend: async (backendId: string) => {
      try {
        const mgr = getAcpBackendManager()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await mgr.setBackend(backendId as any, 'user-global', 'local-user')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    forkAgent: async (systemAgentId: string, data: { name?: string; description?: string }) => {
      try {
        const rec = forkAgentRecord(systemAgentId, data)
        return { ok: true, agentId: rec.id }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    updateAgent: async (agentId: string, data: Record<string, unknown>) => {
      try {
        updateAgentRecord(agentId, data)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    deleteAgent: async (agentId: string) => {
      try {
        deleteAgentRecord(agentId)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    getBrowserContext: () => getBrowserContext(),
  })

  // 先挂接 Bridge，再注册 IPC handler，确保 handler 注册时 bridge 已就绪
  setAgentRuntimeBridgeForIpc(agentRuntimeBridge)
  // 注册 agent-runtime:command IPC handler（必须在 setAgentRuntimeBridgeForIpc 之后）
  installAgentRuntimeCommandIpc()
  await agentRuntimeBridge.initialize()
  log.info('客户端 Agent Runtime 初始化完成（新协议 agent-runtime:command）')

  // 初始化语音通话服务
  const voiceModelManager = new VoiceModelManager()
  const savedVoiceConfig = await loadVoiceEngineConfig()
  voiceCallService = new VoiceCallService(
    mainWindow!,
    (sessionKey, content, audioWavBase64) => submitVoiceTranscript(sessionKey, content, audioWavBase64),
    voiceModelManager,
    savedVoiceConfig,
  )
  registerVoiceIpc(mainWindow!, voiceCallService, voiceModelManager)
  // 注入音频 ASR 转录能力到文件导入 IPC
  setAudioTranscribeCallback((base64, mimeType) => voiceCallService!.transcribeAudioBuffer(base64, mimeType))
  log.info('语音通话服务已注册')

  // 启动后 5s 异步预热语音引擎（不阻塞启动，模型就绪时静默完成）
  setTimeout(() => {
    const ttsProvider = voiceCallService!.getConfig().tts.provider
    if (voiceModelManager.areRequiredModelsReady(ttsProvider)) {
      voiceCallService!.ensureInitialized().catch((e) => {
        log.warn(`语音引擎预热失败（非致命）: ${e.message}`)
      })
    }
  }, 5000)


  // ── 技能自进化引擎（已关闭）──
  // 代码保留，但暂不启用，效果不太好。移除了以下内容：
  // - 初始化 SkillEvolutionEngine 实例
  // - bridge.setSkillEvolutionEngine(engine) 注册
  // - 事件监听（improvement_ready, inject_message）
  // 如需恢复，取消下方注释并确保 user-dialog.ts / conversation-observer.ts 依赖完整。
  /*
  const skillEvolutionEngine = new SkillEvolutionEngine((prompt, instanceId) => agentRuntimeBridge!.callLLM(prompt, instanceId))
  agentRuntimeBridge.setSkillEvolutionEngine(skillEvolutionEngine)
  skillEvolutionEngine.on('improvement_ready', (evt: { type: string; skillName: string; naturalLanguageDiff: string }) => {
    log.info(`[SkillEvolution] 改进方案已生成: skillName=${evt.skillName}`)
  })
  skillEvolutionEngine.on('inject_message', (evt: { instanceId: string; text: string }) => {
    const sessionKey = getSessionKeyForInstance(evt.instanceId)
    if (!sessionKey) return
    const msgId = `skill-evo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    try {
      agentRuntimeBridge?.conversationRepo?.saveMessage?.({
        id: msgId,
        conversationId: sessionKey,
        role: 'assistant',
        contentJson: { type: 'text', text: evt.text },
      })
    } catch (err) {
      log.warn(`[SkillEvolution] inject_message 持久化失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-runtime:event', {
        type: 'conversation:message:new',
        sessionKey,
        message: {
          id: msgId,
          role: 'assistant',
          content: [{ type: 'text', text: evt.text }],
          timestamp: Date.now(),
        },
      })
    }
  })
  log.info('[SkillEvolution] 技能自进化引擎已启动')
  */
}

/**
 * 从渲染进程的 localStorage 读取设置
 *
 * 通过 webContents.executeJavaScript 同步读取渲染进程存储的设置。
 * 由于主进程在初始化时可能还没有渲染进程就绪，需要容错处理。
 */
/** 记忆注入开关主进程缓存（避免 executeJavaScript 失败时始终回退为「全开」） */
let memoryInjectionSettingsCache: {
  injectPersonalMemory: boolean
  injectWorkMemory: boolean
} | null = null

/**
 * 同步记忆注入开关到主进程缓存（渲染进程切换时 IPC 调用）
 */
function setMemoryInjectionSettingsCache(settings: {
  injectPersonalMemory?: boolean
  injectWorkMemory?: boolean
}): void {
  memoryInjectionSettingsCache = {
    injectPersonalMemory: settings.injectPersonalMemory !== false,
    injectWorkMemory: settings.injectWorkMemory !== false,
  }
}

async function getRendererSettings(): Promise<{
  workspace?: { directory?: string }
  memory?: { injectPersonalMemory?: boolean; injectWorkMemory?: boolean }
} | null> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null
  }
  try {
    const json = await mainWindow.webContents.executeJavaScript(
      `localStorage.getItem('mtbot-assistant-settings')`
    )
    if (json) {
      return JSON.parse(json)
    }
  } catch {
    // 渲染进程可能还没准备好
  }
  return null
}

/**
 * 获取当前工作空间目录
 *
 * 从 localStorage 同步的设置中读取工作空间路径，
 * 为空则返回默认的 userData 目录。
 */
function getWorkspaceDir(): string {
  const mtbotDataDir = resolveClientStateDir()
  return configManager?.getAppConfig().workspaceDirectory || join(mtbotDataDir, 'workspace')
}

/**
 * 根据当前用户配置将开发类 ACP 的 MTBOT_*_ACP_CWD 写入当前进程环境（子进程可继承）。
 */
function reapplyCodingDevAcpEnvFromConfig(): void {
  if (!configManager) return
  // 使用 directoryManager 获取根目录，确保一致性
  const mtbotDataDir = directoryManager ? directoryManager.getDirectories().root : resolveClientStateDir()
  const fallback = defaultWorkspaceFallback(mtbotDataDir)
  const resolved = resolveCodingDevAcpWorkspacePath({
    appConfig: configManager.getAppConfig(),
    defaultWorkspaceFallback: fallback,
  })
  applyCodingDevAcpEnvToProcess(resolved)
  log.info('[coding-dev] 已应用 ACP 工作区环境变量:', resolved)
}

/**
 * 设置 IPC 处理器
 */
function setupIpcHandlers(): void {
  log.info('设置 IPC 处理器')

  // === 记忆注入开关（主进程缓存，供 Agent 每轮 prompt 读取）===
  ipcMain.handle(
    'settings:updateMemoryInjection',
    async (_event, payload: { injectPersonalMemory?: boolean; injectWorkMemory?: boolean }) => {
      if (!payload || typeof payload !== 'object') return
      setMemoryInjectionSettingsCache(payload)
    },
  )

  // === 工作空间 ===

  /**
   * 解析当前生效的工作空间根目录：优先用户在设置页配置的 workspaceDirectory，
   * 否则回退到数据根目录下的默认 workspace/。
   * 所有依赖“工作空间根”的子路径（projects、skills 等）必须经此函数派生，
   * 不能直接读 directoryManager 的固定路径，否则用户切换数据/工作空间目录后会失联。
   */
  function resolveActiveWorkspaceDir(): string {
    const mtbotDataDir = resolveClientStateDir()
    const defaultWorkspace = join(mtbotDataDir, 'workspace')
    const configured = configManager?.getAppConfig().workspaceDirectory
    return configured || defaultWorkspace
  }

  ipcMain.handle('workspace:getDir', async () => {
    return resolveActiveWorkspaceDir().replace(/\\/g, '/')
  })

  ipcMain.handle('workspace:setDir', async (_event, dirPath: string) => {
    if (typeof dirPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    // 空字符串表示恢复默认
    if (dirPath !== '') {
      // 验证目录是否存在
      try {
        const stat = await fs.stat(dirPath)
        if (!stat.isDirectory()) {
          throw new Error('指定路径不是目录')
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('目录不存在', { cause: err })
        }
        throw err
      }
    }

    const mtbotDataDir = resolveClientStateDir()
    const defaultWorkspace = join(mtbotDataDir, 'workspace')
    const resolved = dirPath !== '' ? dirPath : defaultWorkspace
    // 与 notifyChanged 对齐：校验通过后立即写入主进程权威配置
    if (configManager) {
      await configManager.updateAppConfig({
        workspaceDirectory: resolved !== defaultWorkspace ? resolved : undefined,
      })
    }
    reapplyCodingDevAcpEnvFromConfig()
    return (resolved).replace(/\\/g, '/')
  })

  /**
   * 工作空间路径已变更（用户保存设置后调用），立即重连节点使新路径生效
   * @param newDirPath 新路径；空字符串表示恢复默认路径
   */
  ipcMain.handle('workspace:notifyChanged', async (_event, newDirPath?: string) => {
    const mtbotDataDir = resolveClientStateDir()
    const defaultWorkspace = join(mtbotDataDir, 'workspace')
    const resolved =
      newDirPath !== undefined && newDirPath !== ''
        ? newDirPath
        : defaultWorkspace

    // 同步保存到 ConfigManager（主进程权威来源）
    if (configManager) {
      await configManager.updateAppConfig({ workspaceDirectory: resolved !== defaultWorkspace ? resolved : undefined })
    }
    reapplyCodingDevAcpEnvFromConfig()
    // 灵栖/Lumii 独立版：无网关/节点连接，工作空间变更仅更新本地配置，Agent 运行时通过 getCwd 读取新路径
  })

  ipcMain.handle('workspace:selectDir', async (_event, currentPath?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择工作空间目录',
      defaultPath: currentPath,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择此文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('workspace:ensureDir', async (_event, dirPath: string) => {
    if (typeof dirPath !== 'string' || dirPath.length === 0) {
      throw new Error('路径必须是非空字符串')
    }
    // 确保工作空间根目录及标准子目录结构存在
    await fs.mkdir(dirPath, { recursive: true })
    await directoryManager.ensureWorkspaceSubDirs(dirPath)
    // 将工作空间路径加入安全白名单，允许文件操作访问
    securityUtils.addAllowedBasePath(dirPath)
    return dirPath
  })

  /**
   * 会话重命名后，将“未归类/threadId”自动归档到任务目录。
   */
  ipcMain.handle('workspace:sessionRenamed', async (_event, threadId: string, newTitle: string) => {
    if (typeof threadId !== 'string' || threadId.trim().length === 0) {
      throw new Error('threadId 必须是非空字符串')
    }
    if (typeof newTitle !== 'string' || newTitle.trim().length === 0) {
      throw new Error('newTitle 必须是非空字符串')
    }
    await directoryManager.renameTaskDirectory(threadId.trim(), newTitle.trim())
    return true
  })

  /**
   * 确保 thread 目录存在，供父/子 Agent 共享 workspace。
   */
  ipcMain.handle('workspace:ensureThreadDir', async (_event, threadId: string) => {
    if (typeof threadId !== 'string' || threadId.trim().length === 0) {
      throw new Error('threadId 必须是非空字符串')
    }
    const dirs = await directoryManager.ensureThreadDirectories(threadId)
    securityUtils.addAllowedBasePath(dirs.root)
    return {
      root: dirs.root.replace(/\\/g, '/'),
      workspace: dirs.workspace.replace(/\\/g, '/'),
      uploads: dirs.uploads.replace(/\\/g, '/'),
      outputs: dirs.outputs.replace(/\\/g, '/'),
    }
  })

  // === 工作空间 Git 版本管理 (VCS) ===
  function vcsWarn(msg: string) { log.warn(`[VCS-IPC] ${msg}`) }

  ipcMain.handle('vcs:ensureInit', async () => {
    const repo = getWorkspaceVcs(getWorkspaceDir())
    await repo.ensureInitialized()
    return { ok: true }
  })

  ipcMain.handle('vcs:commit', async (_event, opts?: { message?: string }) => {
    try {
      const repo = getWorkspaceVcs(getWorkspaceDir())
      const commit = await repo.commit({
        author: 'user',
        message: opts?.message || '手动保存版本',
      })
      return { success: true, data: commit }
    } catch (err) {
      vcsWarn(`commit 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:log', async (_event, opts?: { limit?: number; offset?: number }) => {
    try {
      const repo = getWorkspaceVcs(getWorkspaceDir())
      const entries = await repo.log(opts)
      return { success: true, data: entries }
    } catch (err) {
      vcsWarn(`log 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:statusDiff', async (_event, opts?: { baseOid?: string }) => {
    try {
      const repo = getWorkspaceVcs(getWorkspaceDir())
      const diff = await repo.statusDiff(opts?.baseOid)
      return { success: true, data: diff }
    } catch (err) {
      vcsWarn(`statusDiff 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:diff', async (_event, opts: { fromOid: string; toOid: string; withHunks?: boolean }) => {
    try {
      const repo = getWorkspaceVcs(getWorkspaceDir())
      const diff = await repo.diffCommits(opts.fromOid, opts.toOid, { withHunks: opts.withHunks })
      return { success: true, data: diff }
    } catch (err) {
      vcsWarn(`diff 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'vcs:diffFile',
    async (_event, opts: { fromOid: string; toOid: string; filepath: string }) => {
      try {
        const repo = getWorkspaceVcs(getWorkspaceDir())
        const entry = await repo.diffFile(opts.fromOid, opts.toOid, opts.filepath)
        return { success: true, data: entry }
      } catch (err) {
        vcsWarn(`diffFile 失败: ${err instanceof Error ? err.message : String(err)}`)
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle('vcs:readFileAt', async (_event, opts: { oid: string; filepath: string }) => {
    try {
      const repo = getWorkspaceVcs(getWorkspaceDir())
      const content = await repo.readFileAt(opts.oid, opts.filepath)
      return { success: true, data: content }
    } catch (err) {
      vcsWarn(`readFileAt 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:rollback', async (_event, opts: { oid: string }) => {
    try {
      const repo = getWorkspaceVcs(getWorkspaceDir())
      const result = await repo.rollbackTo(opts.oid)
      log.info(`[VCS-IPC] 回滚完成，恢复至 oid=${result.restoredOid.slice(0, 8)}`)
      return { success: true, data: result }
    } catch (err) {
      vcsWarn(`rollback 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:revertFile', async (_event, opts: { oid: string; filepath: string }) => {
    try {
      const repo = getWorkspaceVcs(getWorkspaceDir())
      const result = await repo.revertFile(opts.oid, opts.filepath)
      log.info(`[VCS-IPC] 单文件撤销完成 ${opts.filepath} → ${(opts.oid || 'HEAD').slice(0, 8)}`)
      return { success: true, data: result }
    } catch (err) {
      vcsWarn(`revertFile 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:findCommitByConversation', async (_event, opts: { conversationId: string }) => {
    try {
      const repo = getWorkspaceVcs(getWorkspaceDir())
      const commit = await repo.findCommitByConversation(opts.conversationId)
      return { success: true, data: commit }
    } catch (err) {
      vcsWarn(`findCommitByConversation 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // === 微信(iLink)渠道 ===
  ipcMain.handle('weixin:startLogin', async () => {
    if (!weixinLoginService) return null
    return weixinLoginService.startLogin()
  })
  
  ipcMain.handle('weixin:logout', async () => {
    if (!weixinLoginService) return
    return weixinLoginService.logout()
  })
  
  ipcMain.handle('weixin:getStatus', () => {
    return weixinLoginService?.getStatus() ?? 'idle'
  })
  
  ipcMain.handle('weixin:getSession', async () => {
    return weixinLoginService?.getSession() ?? null
  })

  // === 企业微信(AI Bot)渠道 ===
  ipcMain.handle('wecom:startLogin', async () => {
    if (!wecomLoginService) return null
    return wecomLoginService.startLogin()
  })

  ipcMain.handle('wecom:logout', async () => {
    if (!wecomLoginService) return
    return wecomLoginService.logout()
  })

  ipcMain.handle('wecom:getStatus', () => {
    return wecomLoginService?.getStatus() ?? 'idle'
  })

  ipcMain.handle('wecom:getSession', () => {
    return wecomLoginService?.getSessionPublic() ?? null
  })

  // === 飞书渠道 ===
  ipcMain.handle('feishu:startLogin', async () => {
    if (!feishuLoginService) return null
    return feishuLoginService.startLogin()
  })

  ipcMain.handle('feishu:logout', async () => {
    if (!feishuLoginService) return
    return feishuLoginService.logout()
  })

  ipcMain.handle('feishu:getStatus', () => {
    return feishuLoginService?.getStatus() ?? 'idle'
  })

  ipcMain.handle('feishu:getSession', () => {
    return feishuLoginService?.getSessionPublic() ?? null
  })
  
  // === 窗口控制 ===
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.on('window:close', () => mainWindow?.hide())
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)

  /**
   * 光标相对内容区坐标（供边缘光效使用）。
   * 标题栏 `-webkit-app-region: drag` 会吞掉 DOM mousemove，必须走主进程 screen API。
   */
  ipcMain.handle('window:getCursorClientPos', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    if (!win || win.isDestroyed()) return null
    const point = screen.getCursorScreenPoint()
    const bounds = win.getContentBounds()
    const x = point.x - bounds.x
    const y = point.y - bounds.y
    return {
      x,
      y,
      inside:
        point.x >= bounds.x
        && point.y >= bounds.y
        && point.x < bounds.x + bounds.width
        && point.y < bounds.y + bounds.height,
    }
  })

  /** 渲染进程请求桌面通知（如 Agent 回合结束且窗口在后台） */
  ipcMain.handle('notify:desktop', async (_event, payload: { title?: string; body?: string }) => {
    const title = typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : 'MtBot'
    const body = typeof payload?.body === 'string' ? payload.body : ''
    showDesktopTaskNotification(title, body)
  })

  // === 文件操作 ===
  // 注意：文件操作的路径验证已在 SystemService 中实现
  ipcMain.handle('file:list', async (_event, dirPath: string) => {
    if (typeof dirPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return systemService?.listDirectory(dirPath)
  })

  ipcMain.handle('file:read', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return systemService?.readFile(filePath)
  })

  // 读取文件为 Base64 (用于图片附件)
  ipcMain.handle('file:readAsBase64', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }

    log.info(`[File] 读取文件为 Base64: ${filePath}`)

    // 获取文件扩展名和 MIME 类型
    const ext = extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.csv': 'text/csv',
      '.json': 'application/json',
      '.xml': 'text/xml',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.log': 'text/plain',
      '.ts': 'text/plain',
      '.tsx': 'text/plain',
      '.js': 'text/plain',
      '.jsx': 'text/plain',
      '.py': 'text/plain',
      '.yaml': 'text/plain',
      '.yml': 'text/plain',
      '.toml': 'text/plain',
      '.ini': 'text/plain',
      '.cfg': 'text/plain',
      '.sh': 'text/plain',
      '.bat': 'text/plain',
      '.css': 'text/plain',
      '.sql': 'text/plain',
      '.rs': 'text/plain',
      '.go': 'text/plain',
      '.java': 'text/plain',
      '.c': 'text/plain',
      '.cpp': 'text/plain',
      '.h': 'text/plain',
    }
    const mimeType = mimeTypes[ext] || 'application/octet-stream'

    // 验证文件大小 (限制 10MB)
    const stats = await fs.stat(filePath)
    if (stats.size > 10 * 1024 * 1024) {
      throw new Error('文件大小超出限制 (最大 10MB)')
    }

    // 读取文件内容
    const buffer = await fs.readFile(filePath)
    const content = buffer.toString('base64')

    log.info(`[File] 文件读取成功: ${filePath}, 大小: ${stats.size} 字节`)

    return {
      content,
      mimeType,
      size: stats.size,
      fileName: filePath.split(/[/\\]/).pop() || 'file',
    }
  })

  ipcMain.handle('file:write', async (_event, filePath: string, content: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    if (typeof content !== 'string') {
      throw new Error('内容必须是字符串')
    }
    // 限制写入内容大小
    if (content.length > 10 * 1024 * 1024) {
      throw new Error('写入内容超出大小限制 (10MB)')
    }
    return systemService?.writeFile(filePath, content)
  })

  ipcMain.handle('file:move', async (_event, sourcePath: string, destPath: string) => {
    if (typeof sourcePath !== 'string' || typeof destPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return systemService?.moveFile(sourcePath, destPath)
  })

  ipcMain.handle('file:copy', async (_event, sourcePath: string, destPath: string) => {
    if (typeof sourcePath !== 'string' || typeof destPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return systemService?.copyFile(sourcePath, destPath)
  })

  ipcMain.handle('file:delete', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return systemService?.deleteFile(filePath)
  })

  ipcMain.handle('file:createDir', async (_event, dirPath: string) => {
    if (typeof dirPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return systemService?.createDirectory(dirPath)
  })

  ipcMain.handle('file:exists', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return systemService?.exists(filePath)
  })

  ipcMain.handle('file:getInfo', async (_event, filePath: string) => {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    return systemService?.getFileInfo(filePath)
  })

  ipcMain.handle('file:search', async (_event, dirPath: string, pattern: string, options?: unknown) => {
    if (typeof dirPath !== 'string') {
      throw new Error('路径必须是字符串')
    }
    // 类型筛选可传空 pattern（由 extensions 驱动）；关键词 pattern 放宽上限
    if (typeof pattern !== 'string' || pattern.length > 500) {
      throw new Error('搜索模式无效')
    }
    return systemService?.searchFiles(
      dirPath,
      pattern,
      options as {
        recursive?: boolean
        maxResults?: number
        extensions?: readonly string[]
        skipDirs?: readonly string[]
      },
    )
  })

  // === 系统信息 ===
  ipcMain.handle('system:getInfo', () => {
    return systemService?.getSystemInfo()
  })

  ipcMain.handle('system:getDiskInfo', async () => {
    return systemService?.getDiskInfo()
  })

  ipcMain.handle('system:getProcessList', async () => {
    return systemService?.getProcessList()
  })

  ipcMain.handle('system:killProcess', async (_event, pid: number) => {
    // PID 验证在 SystemService 中实现
    const safePid = validatePid(pid)
    return systemService?.killProcess(safePid)
  })

  ipcMain.handle('system:launchApp', async (_event, appPath: string, args?: string[]) => {
    if (typeof appPath !== 'string') {
      throw new Error('应用路径必须是字符串')
    }
    if (args !== undefined && !Array.isArray(args)) {
      throw new Error('参数必须是数组')
    }
    // 验证参数数组
    if (args && args.some((arg) => typeof arg !== 'string')) {
      throw new Error('所有参数必须是字符串')
    }
    systemService?.launchApplication(appPath, args)
  })

  ipcMain.handle('system:executeCommand', async (_event, command: string) => {
    if (typeof command !== 'string') {
      throw new Error('命令必须是字符串')
    }
    if (command.length > 1000) {
      throw new Error('命令过长')
    }
    return systemService?.executeCommand(command)
  })

  ipcMain.handle('system:getUserPaths', () => {
    return systemService?.getUserPaths()
  })

  // === 服务器配置 ===
  ipcMain.handle('app:getServerConfig', async () => {
    const config = await getServerConfig()
    return config
  })

  ipcMain.handle('app:updateServerConfig', async (_event, config: Partial<{ gatewayUrl: string; apiUrl: string }>) => {
    if (!configManager) {
      throw new Error('ConfigManager 未初始化')
    }
    await configManager.updateServerConfig(config)
  })

  ipcMain.handle('app:getCodingDevEnvInfo', async () => {
    if (!configManager) {
      throw new Error('ConfigManager 未初始化')
    }
    const mtbotDataDir = resolveClientStateDir()
    const fb = defaultWorkspaceFallback(mtbotDataDir)
    return buildCodingDevEnvInfo({
      appConfig: configManager.getAppConfig(),
      defaultWorkspaceFallback: fb,
    })
  })

  /** 获取本机 ACP 工具元数据（名称、链接、安装命令）— 同步读取，无版本探测 */
  ipcMain.handle('app:listCodingDevToolsMetadata', () => {
    return listLocalAcpToolsMetadata()
  })

  /** 探测单个本机 ACP 工具是否已安装，并返回版本信息 */
  ipcMain.handle('app:detectCodingDevTool', async (_event, toolId: string) => {
    if (!isPrimaryLocalAcpToolId(toolId)) {
      throw new Error(`未知工具 ID: ${toolId}`)
    }
    return detectLocalAcpTool(toolId)
  })

  ipcMain.handle('app:installCodingDevTool', async (_event, toolId: string) => {
    return installLocalAcpTool(toolId)
  })

  /** 卸载本机 ACP CLI（执行官方白名单卸载命令或手动移除文档化路径） */
  ipcMain.handle('app:uninstallCodingDevTool', async (_event, toolId: string) => {
    return uninstallLocalAcpTool(toolId)
  })

  /** 卸载前预览：将要执行的命令与风险提示（不执行） */
  ipcMain.handle('app:previewUninstallCodingDevTool', async (_event, toolId: string) => {
    return previewUninstallLocalAcpTool(toolId)
  })

  /** 触发 CLI 登录流程（如 cursor 的 agent login，打开浏览器 OAuth） */
  ipcMain.handle('app:loginCodingDevTool', async (_event, toolId: string) => {
    if (!isPrimaryLocalAcpToolId(toolId)) {
      throw new Error(`未知工具 ID: ${toolId}`)
    }
    const status = await detectLocalAcpTool(toolId)
    if (!status.installed || !status.resolvedPath) {
      throw new Error(`${status.label} 未安装`)
    }
    // cursor: agent login 打开浏览器，等待用户完成授权
    // 其他 CLI 同样逻辑，按需扩展
    const loginArgs: Record<string, string[]> = {
      cursor: ['login'],
      claude: ['login'],
      codex: ['auth', 'login'],
      opencode: ['login'],
    }
    const args = loginArgs[toolId]
    if (!args) {
      throw new Error(`${status.label} 暂不支持客户端一键登录，请在命令行手动执行`)
    }
    return new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const useShell = needsWindowsShell(status.resolvedPath!)
      const child = spawn(status.resolvedPath!, args, {
        windowsHide: false, // 显示窗口，让用户看到登录进度
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (buf: Buffer) => {
        stdout += buf.toString('utf8')
      })
      child.stderr?.on('data', (buf: Buffer) => {
        stderr += buf.toString('utf8')
      })
      child.on('error', (err) => {
        reject(err)
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, message: '登录成功' })
        } else {
          const err = stderr || stdout || `退出码 ${code}`
          resolve({ success: false, message: `登录失败：${err.slice(0, 300)}` })
        }
      })
    })
  })

  ipcMain.handle('app:setCodingDevAcpWorkspace', async (_event, dirPath: string | undefined) => {
    if (!configManager) {
      throw new Error('ConfigManager 未初始化')
    }
    const trimmed = typeof dirPath === 'string' ? dirPath.trim() : ''
    if (trimmed) {
      try {
        const stat = await fs.stat(trimmed)
        if (!stat.isDirectory()) {
          throw new Error('指定路径不是目录')
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('目录不存在', { cause: err })
        }
        throw err
      }
    }
    await configManager.updateAppConfig({
      codingDevAcpWorkspace: trimmed || undefined,
    })
    reapplyCodingDevAcpEnvFromConfig()
  })

  // === ACP 项目管理 ===
  ipcMain.handle('app:listCodingDevProjects', async () => {
    if (!configManager || !directoryManager) throw new Error('未初始化')
    const cfg = configManager.getAppConfig()
    const projectsDir = join(resolveActiveWorkspaceDir(), 'projects')
    const reconciled = await reconcileProjectsWithDisk({
      projectsDir,
      existing: cfg.codingDevProjects ?? [],
      activeProject: cfg.codingDevActiveProject,
    })
    if (reconciled.changed) {
      await configManager.updateAppConfig({
        codingDevProjects: reconciled.projects,
        codingDevActiveProject: reconciled.activeProject,
      })
      reapplyCodingDevAcpEnvFromConfig()
    }
    return {
      projects: reconciled.projects,
      activeProject: reconciled.activeProject,
    }
  })

  ipcMain.handle('app:createCodingDevProject', async (_event, name: string) => {
    if (!configManager || !directoryManager) throw new Error('未初始化')
    const projectsDir = join(resolveActiveWorkspaceDir(), 'projects')
    const existing = configManager.getAppConfig().codingDevProjects ?? []
    const projects = await createProject({ projectsDir, name: String(name ?? ''), existing })
    const activeProject = projects[projects.length - 1]?.name
    await configManager.updateAppConfig({ codingDevProjects: projects, codingDevActiveProject: activeProject })
    reapplyCodingDevAcpEnvFromConfig()
    return { projects, activeProject }
  })

  ipcMain.handle('app:openCodingDevProject', async (_event, name: string, targetPath: string) => {
    if (!configManager || !directoryManager) throw new Error('未初始化')
    const projectsDir = join(resolveActiveWorkspaceDir(), 'projects')
    const existing = configManager.getAppConfig().codingDevProjects ?? []
    const projects = await openExistingProject({
      projectsDir,
      name: String(name ?? ''),
      targetPath: String(targetPath ?? ''),
      existing,
    })
    const activeProject = projects[projects.length - 1]?.name
    await configManager.updateAppConfig({ codingDevProjects: projects, codingDevActiveProject: activeProject })
    reapplyCodingDevAcpEnvFromConfig()
    return { projects, activeProject }
  })

  ipcMain.handle('app:removeCodingDevProject', async (_event, name: string) => {
    if (!configManager || !directoryManager) throw new Error('未初始化')
    const projectsDir = join(resolveActiveWorkspaceDir(), 'projects')
    const cfg = configManager.getAppConfig()
    const existing = cfg.codingDevProjects ?? []
    const projects = await removeProject({ projectsDir, name: String(name ?? ''), existing })
    // 若移除的是活动项目，活动项目回退到列表首个（或清空）
    const activeProject =
      cfg.codingDevActiveProject && projects.some((p) => p.name === cfg.codingDevActiveProject)
        ? cfg.codingDevActiveProject
        : projects[0]?.name
    await configManager.updateAppConfig({ codingDevProjects: projects, codingDevActiveProject: activeProject })
    reapplyCodingDevAcpEnvFromConfig()
    return { projects, activeProject }
  })

  ipcMain.handle('app:setCodingDevActiveProject', async (_event, name: string) => {
    if (!configManager) throw new Error('ConfigManager 未初始化')
    const trimmed = typeof name === 'string' ? name.trim() : ''
    const projects = configManager.getAppConfig().codingDevProjects ?? []
    if (trimmed && !projects.some((p) => p.name === trimmed)) {
      throw new Error(`项目「${trimmed}」不存在`)
    }
    await configManager.updateAppConfig({ codingDevActiveProject: trimmed || undefined })
    reapplyCodingDevAcpEnvFromConfig()
    return { projects, activeProject: trimmed || undefined }
  })

  ipcMain.handle('app:getProjectGitStatus', async (_event, projectName: string) => {
    if (!configManager) throw new Error('ConfigManager 未初始化')
    const projects = configManager.getAppConfig().codingDevProjects ?? []
    const project = projects.find((p) => p.name === projectName)
    if (!project) return { available: false, isRepo: false, files: [] }
    return getProjectGitStatus(project.realPath)
  })

  // === 应用操作 ===
  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.on('app:quit', () => {
    isQuitting = true
    app.quit()
  })
  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    // 验证 URL 安全性
    const safeUrl = validateUrl(url, { allowedProtocols: ['http:', 'https:'] })
    return shell.openExternal(safeUrl)
  })

  ipcMain.handle('app:showItemInFolder', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) {
      throw new Error('文件路径无效')
    }
    shell.showItemInFolder(filePath)
  })

  /**
   * 在资源管理器中打开当前应用日志文件（便于用户排查问题）
   */
  ipcMain.handle('app:openLogFile', async () => {
    const logFile = fileLogger.getCurrentLogFilePath()
    if (logFile && existsSync(logFile)) {
      shell.showItemInFolder(logFile)
      return { success: true, path: logFile }
    }
    const logDir = fileLogger.getLogDir()
    if (logDir && existsSync(logDir)) {
      await shell.openPath(logDir)
      return { success: true, path: logDir }
    }
    return { success: false, error: '未找到日志文件' }
  })

  // === 对话框 ===
  ipcMain.handle('dialog:showOpenDialog', async (_event, options: Electron.OpenDialogOptions) => {
    return dialog.showOpenDialog(mainWindow!, options)
  })

  ipcMain.handle('dialog:showSaveDialog', async (_event, options: Electron.SaveDialogOptions) => {
    return dialog.showSaveDialog(mainWindow!, options)
  })

  ipcMain.handle('dialog:showMessageBox', async (_event, options: Electron.MessageBoxOptions) => {
    return dialog.showMessageBox(mainWindow!, options)
  })

  // === 剪贴板 ===
  ipcMain.handle('clipboard:readText', () => {
    return clipboard.readText()
  })

  ipcMain.handle('clipboard:writeText', (_event, text: string) => {
    if (typeof text !== 'string') {
      throw new Error('文本必须是字符串')
    }
    // 限制剪贴板写入大小
    if (text.length > 10 * 1024 * 1024) {
      throw new Error('文本超出大小限制 (10MB)')
    }
    clipboard.writeText(text)
  })

  /**
   * 将文件对象（而非路径文本）写入系统剪贴板，可在资源管理器/聊天框直接粘贴出文件。
   * Electron 的 clipboard 不直接支持 Windows 的 CF_HDROP，故用 PowerShell Set-Clipboard -LiteralPath。
   * 路径通过 execFile 参数数组传入（非拼接命令行），避免命令注入。
   */
  ipcMain.handle('clipboard:writeFiles', async (_event, filePaths: string[]) => {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error('文件路径列表不能为空')
    }
    const paths = filePaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    if (paths.length === 0) {
      throw new Error('文件路径列表不能为空')
    }
    // 校验文件均存在，避免把无效路径写进剪贴板
    for (const p of paths) {
      if (!existsSync(p)) {
        throw new Error(`文件不存在: ${p}`)
      }
    }
    if (process.platform === 'win32') {
      // -LiteralPath 接收数组：逐个作为独立参数传入，PowerShell 不做通配符/转义解释
      await _execFileAsync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard', '-LiteralPath', ...paths],
        { timeout: 15000, windowsHide: true },
      )
      return
    }
    if (process.platform === 'darwin') {
      const fileList = paths.map((p) => `POSIX file "${p.replace(/"/g, '\\"')}"`).join(', ')
      await _execFileAsync(
        'osascript',
        ['-e', `set the clipboard to {${fileList}}`],
        { timeout: 15000 },
      )
      return
    }
    // 其余平台无统一的文件剪贴板机制，退化为写入路径文本
    clipboard.writeText(paths.join('\n'))
  })


  // ========== 本地技能管理 IPC 处理器 ==========

  /**
   * 列出本地已安装技能
   */
  ipcMain.handle('skills:listLocalInstalled', async () => {
    if (!skillRuntime) {
      log.warn('[Skills IPC] 技能运行时未初始化，返回空列表')
      return { success: true, data: [] }
    }
    log.info('[Skills IPC] 列出本地已安装技能')
    const result = await skillRuntime.listLocalInstalled()
    log.info('[Skills IPC] 返回本地技能列表', { count: result.length, skills: result })
    return { success: true, data: result }
  })

  /**
   * 从目录安装技能
   */
  ipcMain.handle('skills:installFromDirectory', async (_event, sourceDir: string) => {
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
      throw new Error('无效的源目录路径')
    }
    log.info('[Skills IPC] 从目录安装技能', { sourceDir })
    return skillRuntime.installFromDirectory(sourceDir)
  })

  /**
   * 从外部目录导入技能（仅含 SKILL.md 的知识型技能）
   * 将源目录复制到 skillsDir，然后触发 scanAndRegister 自动注册
   */
  ipcMain.handle('skills:importDirectory', async (_event, sourceDir: string) => {
    if (!skillRuntime || !skillWatcher) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
      throw new Error('无效的源目录路径')
    }

    const dirName = basename(sourceDir)
    const skillsDir = join(getWorkspaceDir(), 'skills')
    const targetDir = join(skillsDir, dirName)

    log.info('[Skills IPC] 导入技能目录', { sourceDir, targetDir })

    // 如果目标已存在则先删除（覆盖更新）
    try {
      await fs.access(targetDir)
      await fs.rm(targetDir, { recursive: true, force: true })
    } catch {
      // 目标不存在，正常继续
    }

    // 递归复制目录
    await fs.cp(sourceDir, targetDir, { recursive: true })

    // 触发扫描注册
    await skillRuntime.reloadExternalSkills()
    const skills = await skillWatcher.refresh()

    log.info('[Skills IPC] 技能目录导入完成', { dirName, totalSkills: skills.length })
    return { success: true, skillId: dirName }
  })

  /**
   * 卸载本地技能
   */
  ipcMain.handle('skills:uninstallLocal', async (_event, skillId: string) => {
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new Error('无效的技能 ID')
    }
    log.info('[Skills IPC] 卸载本地技能', { skillId })
    const result = await skillRuntime.uninstallLocal(skillId)
    // 卸载后重新扫描并上报
    skillWatcher?.refresh().catch((err) => log.warn('[Skills IPC] 卸载后刷新失败:', err))
    return result
  })

  /**
   * 本地执行技能
   */
  ipcMain.handle('skills:executeLocal', async (_event, params: {
    skillId: string
    params: Record<string, unknown>
    timeoutMs?: number
  }) => {
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof params.skillId !== 'string' || params.skillId.length === 0) {
      throw new Error('无效的技能 ID')
    }
    log.info('[Skills IPC] 本地执行技能', { skillId: params.skillId })
    return skillRuntime.executeSkill({
      requestId: `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      skillId: params.skillId,
      params: params.params ?? {},
      requireConfirm: false,
      timeoutMs: params.timeoutMs ?? 120_000,
      runMode: 'local',
    })
  })

  /**
   * 启用/禁用技能
   */
  ipcMain.handle('skills:setEnabled', async (_event, skillId: string, enabled: boolean) => {
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new Error('无效的技能 ID')
    }
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled 必须为布尔值')
    }
    log.info('[Skills IPC] 设置技能启用状态', { skillId, enabled })
    const result = await skillRuntime.setLocalEnabled(skillId, enabled)
    // 启用/禁用后重新扫描并上报
    skillWatcher?.refresh().catch((err) => log.warn('[Skills IPC] 状态变更后刷新失败:', err))
    return result
  })

  /**
   * 获取技能详情
   */
  ipcMain.handle('skills:getSkillDetail', async (_event, skillId: string) => {
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new Error('无效的技能 ID')
    }
    log.info('[Skills IPC] 获取技能详情', { skillId })
    return skillRuntime.getSkillDetail(skillId)
  })

  /**
   * 手动刷新技能列表：重新扫描本地技能目录并上报到 Gateway
   */
  ipcMain.handle('skills:refresh', async () => {
    if (!skillWatcher) {
      throw new Error('技能监控器未初始化')
    }
    log.info('[Skills IPC] 手动触发技能刷新')
    // 先同步本地索引与运行时，再执行 watcher 扫描上报，避免“上报数量已更新但列表未更新”。
    if (skillRuntime) {
      await skillRuntime.reloadExternalSkills()
    }
    const skills = await skillWatcher.refresh()
    return { success: true, count: skills.length }
  })

  /**
   * 获取技能所在目录的绝对路径
   */
  ipcMain.handle('skills:getSkillDir', async (_event, skillId: string) => {
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new Error('无效的技能 ID')
    }
    const skillsDir = join(getWorkspaceDir(), 'skills')
    return join(skillsDir, skillId)
  })

  /**
   * 从单文件脚本安装技能（自动包装 + 安装）
   */
  ipcMain.handle('skills:installFromScript', async (_event, filePath: string, meta?: {
    name?: string
    description?: string
  }) => {
    if (!skillRuntime) {
      throw new Error('技能运行时未初始化')
    }
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('无效的文件路径')
    }
    log.info('[Skills IPC] 从脚本安装技能', { filePath, meta })

    // 先包装为技能目录
    const skillsDir = join(getWorkspaceDir(), 'skills', '.wrap-temp')
    const wrapResult = await wrapSingleFile({
      filePath,
      outputDir: skillsDir,
      meta,
    })

    if (!wrapResult.success || !wrapResult.skillDir) {
      return { success: false, error: wrapResult.error ?? '包装失败' }
    }

    // 再通过 installFromDirectory 安装
    const installResult = await skillRuntime.installFromDirectory(wrapResult.skillDir)

    // 清理临时目录
    try {
      await fs.rm(wrapResult.skillDir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结果
    }

    return installResult
  })

  // ========== 技能商店 IPC（SkillNet）==========
  registerSkillnetStoreHandlers({
    getSkillsDir: () => join(getWorkspaceDir(), 'skills'),
    reloadSkills: async () => {
      await skillRuntime?.reloadExternalSkills()
      await skillWatcher?.refresh()
    },
  })
}

/**
 * 将 resources / 环境变量中的本地占位配置同步到运行时。
 * 独立版不依赖云端 Gateway / api-server；仅保留本地配置加载。
 */
async function syncRuntimeServerConfig(): Promise<void> {
  const resourcesConfig = await loadServerConfig()
  serverConfig = resourcesConfig
}

/**
 * 设置 API Server IPC 处理器
 *
 * 提供认证、设备配对、用户自服务等 HTTP API 调用
 */
function setupApiIpcHandlers(): void {
  log.info('设置 API Server IPC 处理器')


  // --- AI 灵魂 / 个人记忆（本地文件，返回渲染层期望的 {success, data} 形态） ---
  ipcMain.handle('api:getSoulContent', async () => {
    try {
      const p = getSoulFilePath()
      const content = existsSync(p) ? await fs.readFile(p, 'utf-8') : ''
      const updatedAt = existsSync(p) ? (await fs.stat(p)).mtime.toISOString() : new Date(0).toISOString()
      return { success: true, data: { content, updatedAt } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('api:updateSoulContent', async (_event, content: string) => {
    try {
      const p = getSoulFilePath()
      await fs.mkdir(dirname(p), { recursive: true })
      await fs.writeFile(p, content ?? '', 'utf-8')
      return { success: true, data: { updatedAt: new Date().toISOString() } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('api:getUserMemory', async () => {
    const mem = await readUserMemoryFile()
    return { success: true, data: mem ?? { content: '', updatedAt: new Date(0).toISOString() } }
  })

  ipcMain.handle('api:updateUserMemory', async (_event, content: string) => {
    const result = await writeUserMemoryFile(content ?? '')
    if (!result) return { success: false, error: '写入个人记忆失败' }
    return { success: true, data: result }
  })

  // === 本地 LLM Provider 配置（灵栖/Lumii：按能力槽 chat/vision/image） ===
  ipcMain.handle('provider:getConfig', async () => loadProviderSlotsConfig())

  ipcMain.handle('provider:setConfig', async (_event, cfg: ProviderSlotsConfigView | LocalProviderConfigView) => {
    if (!cfg || typeof cfg !== 'object') throw new Error('无效的 provider 配置')
    // 兼容旧单槽：无 chat/vision/image 字段时视为 chat
    if ('chat' in cfg || 'vision' in cfg || 'image' in cfg) {
      const slots = cfg as ProviderSlotsConfigView
      saveProviderSlotsConfig({
        chat: slots.chat ?? loadSlotConfig('chat'),
        vision: slots.vision ?? loadSlotConfig('vision'),
        image: slots.image ?? loadSlotConfig('image'),
      })
      applyImageSlotToDrawEnv()
    } else {
      saveProviderConfig(cfg as LocalProviderConfigView)
    }
    // 配置变更后销毁旧实例，避免继续走创建时快照的 Gateway/旧凭据
    invalidateAgentInstancesForProviderChange()
    return loadProviderSlotsConfig()
  })

  ipcMain.handle('provider:listModels', async (_event, slot: CapabilitySlot, draftCfg?: LocalProviderConfigView) => {
    if (!isCapabilitySlot(slot)) throw new Error(`无效能力槽: ${slot}`)
    const cfg = draftCfg ?? loadSlotConfig(slot)
    const models = await listProviderModels(cfg)
    return { success: true, data: models }
  })

  ipcMain.handle('provider:testConnection', async (_event, slot: CapabilitySlot, draftCfg?: LocalProviderConfigView) => {
    if (!isCapabilitySlot(slot)) throw new Error(`无效能力槽: ${slot}`)
    const cfg = draftCfg ?? loadSlotConfig(slot)
    return testProviderConnection(slot, cfg)
  })

  // === 本地用量查询（Task 4.3）===
  ipcMain.handle('usage:query', async (_e, query: UsageQuery) => {
    try {
      return { success: true, data: await queryUsage(query) }
    } catch (error) {
      console.error('[IPC] usage:query 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // === 服务商首字节延迟（Task 4.4）===
  ipcMain.handle('usage:latency', () => ({ success: true, data: getLatency() }))

  // === 概览页资讯（数据由「资讯抓取与综述」定时任务写入 ~/.lumii/news/latest.json）===
  ipcMain.handle('news:latest', async () => {
    try {
      return { success: true, data: await readNewsSnapshot() }
    } catch (error) {
      console.error('[IPC] news:latest 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })


  // === Dashboard 通用 feed（资讯只是默认 feed，后续工作流可替换其内容）===
  ipcMain.handle('dashboard-feed:latest', async () => {
    try {
      return { success: true, data: await readActiveDashboardFeedSnapshot() }
    } catch (error) {
      console.error('[IPC] dashboard-feed:latest 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 手动「立即抓取」：与定时任务走同一条 Agent 驱动路径，复用相同的固定 sessionKey，
   * 两者在会话列表里是同一个会话，用户能看到 Agent 具体搜索/调用工具的完整过程。
   */
  ipcMain.handle('dashboard-feed:refresh', async () => {
    try {
      if (!agentRuntimeBridge) throw new Error('Agent Runtime 未就绪')
      const convId = 'cron:news-pipeline'
      agentRuntimeBridge.ensureConversationExists(convId, '定时任务 · 资讯抓取与综述')
      const instanceId = await agentRuntimeBridge.createInstanceById('assistant', convId, convId)
      try {
        await agentRuntimeBridge.prompt(instanceId, `${NEWS_PIPELINE_SYSTEM_PROMPT}\n\n---\n\n${NEWS_PIPELINE_TASK_TEXT}`)
      } finally {
        agentRuntimeBridge.destroy(instanceId)
      }
      return { success: true, data: { snapshot: await readActiveDashboardFeedSnapshot() } }
    } catch (error) {
      console.error('[IPC] dashboard-feed:refresh 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('dashboard-feed:set-active', async (_event, feedId: string) => {
    try {
      await setActiveDashboardFeedId(feedId)
      return { success: true, data: await readActiveDashboardFeedSnapshot() }
    } catch (error) {
      console.error('[IPC] dashboard-feed:set-active 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // === 开机启动 ===
  ipcMain.handle('app:getOpenAtLogin', async () => {
    const loginItemSettings = app.getLoginItemSettings()
    log.info('获取开机启动状态:', loginItemSettings.openAtLogin)
    return loginItemSettings.openAtLogin
  })

  ipcMain.handle('app:setOpenAtLogin', async (_event, enable: boolean) => {
    if (typeof enable !== 'boolean') {
      throw new Error('参数必须为布尔值')
    }
    log.info('设置开机启动:', enable)
    app.setLoginItemSettings({
      openAtLogin: enable,
      // 开机启动时携带参数，用于检测是否由系统自动启动（隐藏到托盘）
      args: enable ? ['--startup-launched'] : [],
    })
    return app.getLoginItemSettings().openAtLogin
  })


  // === 灵栖/Lumii 独立版：无后端，云端配置/技能/节点接口降级为本地空返回 ===

  ipcMain.handle('api:listAllSkills', async () => {
    return { success: true, data: { skills: [], total: 0 } }
  })

  ipcMain.handle('api:listNodes', async () => {
    return { success: true, data: { nodes: [] } }
  })

  ipcMain.handle('api:uploadSkillFile', async () => {
    return { success: false, error: '独立版不支持技能文件上传' }
  })

  // --- Agent 管理接口 ---

  /**
   * 获取 Agent 列表
   */
  ipcMain.handle('api:getAgents', async () => {
    return { success: true, data: listAgents() }
  })

  /**
   * 获取用户有效模型提供商列表（聊天模型选择器）
   * 独立版：直接用本地模型映射，返回扁平结构（与 LiteLLM catalog 一致）
   */
  ipcMain.handle('api:getConfigModels', async () => {
    const mapping = agentRuntimeBridge?.getModelMapping() ?? {}
    const modelIds = [...new Set(Object.values(mapping))]
    return { success: true, data: modelIds.map((id) => ({ id, label: id })) }
  })

  /**
   * 获取 chat 槽候选模型与用户当前选择
   */
  ipcMain.handle('api:getChatModels', async () => {
    return { success: true, data: { candidates: [], selected: '' } }
  })

  /**
   * 保存用户选择的 chat 模型（独立版无后端，noop）
   */
  ipcMain.handle('api:setChatModel', async () => {
    return { success: true }
  })

  /**
   * 获取 Agent 详情
   */
  ipcMain.handle('api:getAgent', async (_event, agentId: string) => {
    const agent = getAgentRecord(agentId)
    if (!agent) return { success: false, error: `Agent 不存在: ${agentId}` }
    return { success: true, data: agent }
  })

  /**
   * Fork 系统/任意 Agent 为用户 Agent（本地存储）
   */
  ipcMain.handle('api:forkAgent', async (_event, systemAgentId: string, data: { name?: string; description?: string }) => {
    try {
      return { success: true, data: forkAgentRecord(systemAgentId, data) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 更新用户 Agent（本地存储）
   */
  ipcMain.handle('api:updateAgent', async (_event, agentId: string, data: Record<string, unknown>) => {
    try {
      return { success: true, data: updateAgentRecord(agentId, data) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 删除用户 Agent（本地存储）
   */
  ipcMain.handle('api:deleteAgent', async (_event, agentId: string) => {
    try {
      deleteAgentRecord(agentId)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 获取用户技能列表（独立版无后端，返回空）
   */
  ipcMain.handle('api:getUserSkills', async () => {
    return { success: true, data: [] }
  })

  log.info('API Server IPC 处理器设置完成')
}

// ============================================================================
// MemPalace 插件 IPC
// ============================================================================

import { execFile as _execFile } from 'child_process'
import { promisify as _promisify } from 'util'
import { MemPalaceMcpBridge } from './mempalace-mcp-client'
import {
  PYPI_MIRROR,
  ensureBundledPython,
  getBundledPythonExe,
  getBundledSitePackages,
  getPythonRuntimeDir,
  hasPackage as hasPythonPackage,
} from './python-env'
import { initScriptRuntimes } from './runtime-env'

const _execFileAsync = _promisify(_execFile)

/**
 * MemPalace 复用公共内置 Python 运行时（见 python-env.ts）。
 * 运行时目录与旧版一致（~/.lumii/runtimes/python-embed），已装用户不必重下。
 */
function getMemPalaceRuntimeDir(): string {
  return getPythonRuntimeDir()
}

function getMemPalacePythonExe(): string {
  return getBundledPythonExe()
}

function getMemPalacePalaceDir(): string {
  return join(resolveClientStateDir(), 'memory', 'palace')
}

/** 检测 site-packages 中是否已有 mempalace 包（快速路径） */
function hasMemPalacePackage(): boolean {
  return hasPythonPackage('mempalace')
}

function getSoulFilePath(): string {
  return join(resolveClientStateDir(), 'data', 'soul.md')
}

function getUserMemoryFilePath(): string {
  return join(resolveClientStateDir(), 'data', 'user-memory.md')
}

async function readUserMemoryFile(): Promise<{ content: string; updatedAt: string } | undefined> {
  try {
    const p = getUserMemoryFilePath()
    if (!existsSync(p)) return undefined
    const content = await fs.readFile(p, 'utf-8')
    const stat = await fs.stat(p)
    return { content, updatedAt: stat.mtime.toISOString() }
  } catch {
    return undefined
  }
}

async function writeUserMemoryFile(content: string): Promise<{ updatedAt: string } | undefined> {
  try {
    const p = getUserMemoryFilePath()
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, content, 'utf-8')
    return { updatedAt: new Date().toISOString() }
  } catch {
    return undefined
  }
}

let _mempalaceBridge: MemPalaceMcpBridge | null = null
function getMemPalaceBridge(): MemPalaceMcpBridge {
  if (!_mempalaceBridge) {
    _mempalaceBridge = new MemPalaceMcpBridge(getMemPalacePythonExe(), getMemPalacePalaceDir())
  }
  return _mempalaceBridge
}

async function checkMemPalaceInstalled(): Promise<boolean> {
  const runtimeDir = getMemPalaceRuntimeDir()
  const pythonExe = getMemPalacePythonExe()
  if (!existsSync(pythonExe)) return false
  if (!hasMemPalacePackage()) return false
  try {
    await _execFileAsync(pythonExe, ['-c', 'import mempalace'], {
      timeout: 30000,
      cwd: runtimeDir,
      env: { ...process.env, PYTHONHOME: runtimeDir },
    })
    return true
  } catch (err) {
    log.warn('[MemPalace] import 验证失败:', err instanceof Error ? err.message : err)
    return false
  }
}

async function ensureMemPalacePalaceDir(): Promise<void> {
  const palaceDir = getMemPalacePalaceDir()
  if (!existsSync(palaceDir)) {
    await fs.mkdir(palaceDir, { recursive: true })
    log.info('[MemPalace] 已创建 palace 目录:', palaceDir)
  }
}

function setupMemPalaceIpcHandlers(): void {
  log.info('设置 MemPalace IPC 处理器')

  ipcMain.handle('plugin:mempalace:status', async () => {
    const installed = await checkMemPalaceInstalled()
    return { installed, runtimeDir: getMemPalaceRuntimeDir() }
  })

  ipcMain.handle('plugin:mempalace:install', async (_event) => {
    const sendProgress = (msg: string) => {
      _event.sender.send('plugin:mempalace:install:progress', msg)
    }

    try {
      // Python 运行时由公共模块保证（已装则秒过），这里只负责装 mempalace 包
      const pythonExe = await ensureBundledPython(sendProgress)
      const sitePackagesDir = getBundledSitePackages()

      sendProgress('正在安装 mempalace...')
      await _execFileAsync(pythonExe, [
        '-m', 'pip', 'install', 'mempalace',
        '--no-warn-script-location',
        '--target', sitePackagesDir,
        '-i', PYPI_MIRROR,
      ], { timeout: 300000, windowsHide: true })

      sendProgress('正在验证安装...')
      await _execFileAsync(pythonExe, ['-c', 'import mempalace; print("ok")'], {
        timeout: 30000,
        cwd: getPythonRuntimeDir(),
        env: { ...process.env, PYTHONHOME: getPythonRuntimeDir() },
      })

      log.info('[MemPalace] 安装完成')
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('[MemPalace] 安装失败:', message)
      return { success: false, error: message }
    }
  })

  // ---- 记忆可视化 IPC ----

  ipcMain.handle('plugin:mempalace:list', async (_event, params?: {
    wing?: string; room?: string; limit?: number; offset?: number
  }) => {
    if (!await checkMemPalaceInstalled()) return { error: 'not_installed' }
    try {
      await ensureMemPalacePalaceDir()
      const bridge = getMemPalaceBridge()
      return await bridge.listDrawers(params ?? {})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('[MemPalace] list 失败:', message)
      return { error: 'process_failed', message }
    }
  })

  ipcMain.handle('plugin:mempalace:search', async (_event, params: {
    query: string; limit?: number; wing?: string; room?: string
  }) => {
    if (!await checkMemPalaceInstalled()) return { error: 'not_installed' }
    try {
      const bridge = getMemPalaceBridge()
      const results = await bridge.searchDrawers(params)
      return { results }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('[MemPalace] search 失败:', message)
      return { error: 'process_failed', message }
    }
  })

  ipcMain.handle('plugin:mempalace:delete', async (_event, drawerId: string) => {
    if (!await checkMemPalaceInstalled()) return { success: false, error: 'not_installed' }
    try {
      const bridge = getMemPalaceBridge()
      await bridge.deleteDrawer(drawerId)
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('[MemPalace] delete 失败:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('plugin:mempalace:clear', async (_event) => {
    if (!await checkMemPalaceInstalled()) return { success: false, error: 'not_installed' }
    try {
      const bridge = getMemPalaceBridge()
      let deleted = 0
      while (true) {
        const page = await bridge.listDrawers({ limit: 100, offset: 0 })
        if (!page.drawers || page.drawers.length === 0) break
        for (const drawer of page.drawers) {
          await bridge.deleteDrawer(drawer.drawer_id)
          deleted++
          if (deleted % 10 === 0) {
            _event.sender.send('plugin:mempalace:clear:progress', { deleted })
          }
        }
      }
      return { success: true, deleted }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('[MemPalace] clear 失败:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('plugin:mempalace:uninstall', async () => {
    try {
      // 先停止 MCP 进程
      if (_mempalaceBridge) {
        _mempalaceBridge.stop()
        _mempalaceBridge = null
      }
      const runtimeDir = getMemPalaceRuntimeDir()
      if (existsSync(runtimeDir)) {
        await fs.rm(runtimeDir, { recursive: true, force: true })
        log.info('[MemPalace] 已删除运行时目录:', runtimeDir)
      }
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('[MemPalace] 卸载失败:', message)
      return { success: false, error: message }
    }
  })
}

function setupCloakBrowserIpcHandlers(): void {
  log.info('设置 CloakBrowser IPC 处理器')

  // 持有当前安装任务的 AbortController，用于取消下载
  let installAbortController: AbortController | null = null

  ipcMain.handle('plugin:cloak-browser:status', async () => {
    try {
      const { exeFilename } = await import('./cloak-browser-downloader.js')
      const cloakDir = join(os.homedir(), '.cloakbrowser')
      if (!existsSync(cloakDir)) return { installed: false }
      const entries = readdirSync(cloakDir).filter((d) => d.startsWith('chromium-'))
      if (entries.length === 0) return { installed: false }
      entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      const latest = entries[0]
      const exePath = join(cloakDir, latest, exeFilename())
      if (!existsSync(exePath)) return { installed: false }
      const version = latest.replace('chromium-', '')
      return { installed: true, version, exePath }
    } catch {
      return { installed: false }
    }
  })

  ipcMain.handle('plugin:cloak-browser:install', async (_event) => {
    try {
      // 若已有安装任务在进行，先取消
      installAbortController?.abort()
      installAbortController = new AbortController()
      const { signal } = installAbortController

      const { ensureCloakBrowser } = await import('./cloak-browser-downloader.js')
      const result = await ensureCloakBrowser(
        (progress) => { _event.sender.send('cloak-browser-progress', progress) },
        signal,
      )
      installAbortController = null
      return { success: result !== null && result !== undefined && (result as string).length > 0 }
    } catch (err) {
      installAbortController = null
      const message = err instanceof Error ? err.message : String(err)
      log.error('[CloakBrowser] 安装失败:', message)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('plugin:cloak-browser:cancel', () => {
    if (installAbortController) {
      log.info('[CloakBrowser] 收到取消指令')
      installAbortController.abort()
      installAbortController = null
    }
    return { success: true }
  })

  ipcMain.handle('plugin:cloak-browser:uninstall', async () => {
    try {
      const cloakDir = join(os.homedir(), '.cloakbrowser')
      if (existsSync(cloakDir)) {
        await fs.rm(cloakDir, { recursive: true, force: true })
        log.info('[CloakBrowser] 已删除目录:', cloakDir)
      }
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('[CloakBrowser] 卸载失败:', message)
      return { success: false, error: message }
    }
  })
}


/**
 * 应用初始化
 */
async function initialize(): Promise<void> {
  log.info('灵栖 Lumii 启动中...')

  // 检查是否在测试模式（用于 E2E 测试）
  const isTestMode = process.argv.includes('--test-mode')

  // 单实例锁定（测试模式下跳过）
  if (!isTestMode) {
    const gotTheLock = app.requestSingleInstanceLock()
    if (!gotTheLock) {
      log.warn('已有实例在运行，退出')
      app.quit()
      return
    }

    // 第二个实例尝试启动时，聚焦到现有窗口
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) {mainWindow.restore()}
        mainWindow.show()
        mainWindow.focus()
      }
    })
  } else {
    log.info('测试模式已启用，跳过单实例锁定')
  }

  // 等待 app ready
  await app.whenReady()

  // Windows 系统通知需要设置 AppUserModelId，否则 Notification 无法显示
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.lumii.app')
  }

  // 初始化文件日志系统（必须在 app.whenReady() 之后）
  fileLogger.initialize()
  // 服务启动时在控制台打印日志文件路径
  log.info('日志文件:', fileLogger.getCurrentLogFilePath())

  // 初始化远程日志上报（error + 关键事件 → 网关 → system_logs）
  remoteLogShipper = createWindowsLogShipper({
    getGatewayUrl: () => {
      if (!serverConfig?.gatewayUrl) return null
      return serverConfig.gatewayUrl.replace(/^ws(s?):\/\//, 'http$1://')
    },
    getAuthToken: () => null,
    getDeviceId: () => undefined,
  })

  log.info('应用已就绪')

  // 检测是否由开机启动触发（--startup-launched 参数由 setLoginItemSettings 注入）
  const isStartupLaunch = process.argv.includes('--startup-launched')
  if (isStartupLaunch) {
    log.info('检测到开机启动，应用将直接最小化到托盘')
  }

  // 先注册 Agent Runtime IPC handler，再加载渲染进程。
  // dev 模式下 renderer 可能在 initAgentRuntime 完成前调用 agent-runtime:command；
  // 提前注册可让调用得到 NOT_READY 并走前端重试，避免 Electron 抛 No handler registered。
  installAgentRuntimeCommandIpc()

  // 初始化各模块（开机启动时隐藏窗口，只显示托盘图标）
  // 等待开机画面完整播放后再显示主窗口
  await createWindow(isTestMode, isStartupLaunch)

  // 注册宠物模式 IPC（独立透明窗口，与 mainWindow 解耦）
  registerPetModeIpc({
    getMainWindow: () => mainWindow,
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    indexHtmlPath: join(__dirname, '../renderer/index.html'),
    onForceIgnoreChanged: (forceIgnore) => {
      trayManager?.updateForceIgnore(forceIgnore)
    },
    onModeChanged: (mode) => {
      // 所有切换路径（托盘/快捷键/控制坞/设置页）统一在此同步托盘文案与设置页状态
      trayManager?.updatePetMode(mode === 'pet')
      trayManager?.updateForceIgnore(isPetForceIgnore())
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pet-mode-changed', mode)
      }
    },
  })

  // 文件预览独立窗口（可拖出主窗口外）
  registerFilePreviewWindowIpc({
    getMainWindow: () => mainWindow,
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    indexHtmlPath: join(__dirname, '../renderer/index.html'),
  })

  initTray()
  initSystemService()
  setupIpcHandlers()

  // 初始化目录管理器和配置管理器（必须在其他模块之前）
  await directoryManager.initialize()
  configManager = new ConfigManager(directoryManager)
  await configManager.initialize()
  reapplyCodingDevAcpEnvFromConfig()
  // 将 ACP 后端选择持久化到 config 目录（而非 %TEMP%），确保重启后不丢失
  {
    const { setBackendSelectionBaseDir } = await import('./coding-dev-backends-stub/backend-selection.js')
    setBackendSelectionBaseDir(directoryManager.getDirectory('config'))
  }
  log.info('目录和配置管理器初始化完成')

  // 灵栖/Lumii 独立版：无后端、无登录。
  // 不构造 apiClient / gatewayClient / nodeModeCoordinator / devicePairingService，
  // 这些实例保持 null，相关能力（provider 配置、agents 存储）由本地能力层（阶段 4/5）接管。
  // setupApiIpcHandlers 仍注册（内部 handler 已对 !apiClient 做本地兜底/降级）。
  setupApiIpcHandlers()
  setupMemPalaceIpcHandlers()
  setupCloakBrowserIpcHandlers()

  await initSkillRuntime()  // 初始化技能运行时

  // 脚本运行环境：写 node/python shim，缺 Python 时后台下载内置运行时
  await initScriptRuntimes()

  // 种子内置技能（必须在 initSkillWatcher 之前，确保文件就绪后再启动监控）
  const mtbotDataDirForSeed = resolveClientStateDir()
  const seedWorkspaceDir = configManager?.getAppConfig().workspaceDirectory
    || join(mtbotDataDirForSeed, 'workspace')
  await seedBundledSkills(seedWorkspaceDir, mtbotDataDirForSeed)
  log.info('[Main] seedBundledSkills 完成，开始 initSkillWatcher')

  await initSkillWatcher()  // 初始化技能监控器（此时种子文件已就绪）
  log.info('[Main] initSkillWatcher 完成，开始 initUpdaterService')
  initUpdaterService()
  log.info('[Main] initUpdaterService 完成，开始 initAgentRuntime')

  // 初始化客户端 Agent Runtime（Feature Flag 默认关闭，需手动启用）
  await initAgentRuntime()
  log.info('[Main] initAgentRuntime 完成')

  // 启动浏览器控制服务（控制用户本机浏览器）
  const browserStarted = await startBrowserService()
  if (browserStarted) {
    log.info('浏览器控制服务已就绪')
  } else {
    log.warn('浏览器控制服务启动失败，browser.* 命令将不可用')
  }

  log.info('灵栖 Lumii 启动完成')

  // 初始化微信(iLink)登录服务
  weixinLoginService = new WeixinLoginService()
  await weixinLoginService.initialize()
  // 注入 SILK ASR 转录回调
  weixinLoginService.silkAsrCallback = (samples, sampleRate) => voiceCallService!.transcribePcm(samples, sampleRate)

  // 微信消息：通过 WeixinChannelAdapter 处理，支持完整斜杠命令集和 ACP 后端路由
  const weixinAcpBackendManager = new AcpBackendManager()
  const weixinChannelAdapter = new WeixinChannelAdapter(weixinLoginService, agentRuntimeBridge!, weixinAcpBackendManager)
  weixinChannelAdapter.startListening()
  setWeixinBindingManagerForIpc(weixinChannelAdapter.bindingManager)

  // 微信状态变化推送到渲染进程
  weixinLoginService.on('statusChange', (status: string, session?: unknown) => {
    mainWindow?.webContents.send('weixin:statusChange', status, session)
  })
  weixinLoginService.on('qrcode', (dataUrl: string) => {
    mainWindow?.webContents.send('weixin:qrcode', dataUrl)
  })
  weixinLoginService.on('error', (message: string) => {
    mainWindow?.webContents.send('weixin:error', message)
  })
  log.info('微信(iLink)服务已初始化')

  // 初始化企业微信 AI Bot 扫码服务
  wecomLoginService = new WecomLoginService()
  await wecomLoginService.initialize()
  const wecomChannelAdapter = new WecomChannelAdapter(wecomLoginService, agentRuntimeBridge!)
  wecomChannelAdapter.startListening()
  wecomLoginService.on('statusChange', (status: string, session?: unknown) => {
    mainWindow?.webContents.send('wecom:statusChange', status, session)
  })
  wecomLoginService.on('qrcode', (dataUrl: string) => {
    mainWindow?.webContents.send('wecom:qrcode', dataUrl)
  })
  wecomLoginService.on('error', (message: string) => {
    mainWindow?.webContents.send('wecom:error', message)
  })
  log.info('企业微信(AI Bot)服务已初始化')

  // 初始化飞书扫码服务
  feishuLoginService = new FeishuLoginService()
  await feishuLoginService.initialize()
  const feishuChannelAdapter = new FeishuChannelAdapter(feishuLoginService, agentRuntimeBridge!)
  feishuChannelAdapter.startListening()
  feishuLoginService.on('statusChange', (status: string, session?: unknown) => {
    mainWindow?.webContents.send('feishu:statusChange', status, session)
  })
  feishuLoginService.on('qrcode', (dataUrl: string) => {
    mainWindow?.webContents.send('feishu:qrcode', dataUrl)
  })
  feishuLoginService.on('error', (message: string) => {
    mainWindow?.webContents.send('feishu:error', message)
  })
  log.info('飞书服务已初始化')
}

// macOS 特殊处理
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow()
  } else {
    mainWindow?.show()
  }
})

// 所有窗口关闭时（非 macOS）
app.on('window-all-closed', () => {
  // Windows/Linux 下不退出，保持托盘运行
  // macOS 下也保持运行
})

/**
 * 执行清理操作（应用退出前）
 * 
 * 注意：Electron 的 before-quit 事件不支持异步等待，
 * 因此使用 event.preventDefault() + 手动 app.quit() 模式。
 */
async function performCleanup(): Promise<void> {
  log.info('开始清理资源...')

  try {
    // 销毁宠物模式窗口（透明置顶窗口，需在主窗口关闭前释放 GPU 资源）
    disposePetModeIpc()

    await skillWatcher?.stop()
    await stopBrowserService()

    // 微信登出清理
    if (weixinLoginService) {
      weixinLoginService.shutdown()
    }

    // 销毁所有 Agent 实例并关闭本地数据库
    // 触发 abort → agent:error 事件 → bridge 删除流式占位行，确保 is_streaming 不残留
    if (agentRuntimeBridge) {
      log.info('[performCleanup] 开始销毁 Agent Runtime Bridge')
      agentRuntimeBridge.destroyAll()
      log.info('[performCleanup] Agent Runtime Bridge 已销毁')
    }

    // 工具调用计数是 debounce 落盘的，退出前补一次，避免丢掉最后几次调用
    await flushToolUsage()

    updaterService?.destroy()
    trayManager?.destroy()
    if (remoteLogShipper) {
      await remoteLogShipper.flush()
      remoteLogShipper.destroy()
    }
    fileLogger.destroy()

    log.info('资源清理完成')
  } catch (error) {
    log.error('清理资源时出错:', error)
  }
}

// 应用退出前清理（使用 preventDefault + 异步清理 + app.exit 强制退出模式）
let cleanupDone = false
app.on('before-quit', (event) => {
  // 清理已完成，允许退出（此分支通常不会到达，因为 finally 调用 app.exit 而非 app.quit）
  if (cleanupDone) {
    return
  }

  // 正在清理中，继续阻止退出（等待 performCleanup 完成后的 app.exit 调用）
  if (isCleaningUp) {
    event.preventDefault()
    return
  }

  // 确保窗口 close 事件不再隐藏窗口（允许退出流程关闭窗口）
  isQuitting = true

  // 阻止立即退出
  event.preventDefault()
  isCleaningUp = true

  log.info('应用即将退出，等待清理完成...')

  // 执行清理，最多等待 8s，超时后强制退出
  const CLEANUP_TIMEOUT = 8000
  Promise.race([
    performCleanup(),
    new Promise<void>((resolve) => setTimeout(() => {
      log.warn('清理超时，强制退出')
      resolve()
    }, CLEANUP_TIMEOUT)),
  ]).finally(() => {
    cleanupDone = true
    isCleaningUp = false
    log.info('清理完成，调用 app.exit(0) 强制退出所有进程')
    // 使用 app.exit(0) 而非 app.quit()：
    // - 跳过再次触发 before-quit 事件，避免循环
    // - 立即终止所有 Electron 子进程（renderer、GPU、网络服务等）
    // - 兜底：如果 app.exit() 5s 内未能终止进程，强制 process.exit()
    const forceKillTimer = setTimeout(() => {
      log.warn('app.exit() 未能在 5s 内终止进程，调用 process.exit(0) 强制终止')
      process.exit(0)
    }, 5000)
    // unref 防止 timer 本身阻止进程退出
    forceKillTimer.unref()
    app.exit(0)
  })
})

// 开发模式下 Ctrl+C 终止 pnpm dev 时，Electron 进程可能收到 SIGINT/SIGTERM。
// Node.js 默认不处理这些信号，Electron 的 before-quit 不会触发，
// 导致 SQLite WAL 文件未 checkpoint，重启后删除操作丢失。
// 这里显式调用 app.quit() 以触发正常退出清理流程（destroyAll -> localDb.close -> WAL checkpoint）
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`收到 ${sig}，触发 app.quit() 以确保数据库正常关闭...`)
    app.quit()
  })
}

// 启动应用
initialize().catch((error) => {
  log.error('启动失败:', error)
  app.quit()
})
