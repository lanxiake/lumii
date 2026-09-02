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
  // eslint-disable-next-line no-console
  process.stderr?.write?.(`Uncaught exception: ${err.stack ?? err.message}\n`)
  process.exit(1)
})

import { execSync, spawn, execFile as _execFile } from 'child_process'
import { promisify as _promisify } from 'util'
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, screen, Notification } from 'electron'
import {
  registerLocalMediaSchemePrivileged,
  registerLocalMediaProtocolHandler,
  setLocalMediaWorkspaceCwdGetter,
} from './local-media-protocol'
import { join, extname, basename, dirname } from 'path'
import { promises as fs, existsSync, readdirSync } from 'fs'
import { TrayManager } from './tray-manager'
import { initializeTray } from './tray/tray-bootstrap'
import { createMainWindow } from './window/main-window'
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
import { SkillWatcher } from './skill-watcher'
import { seedBundledSkills } from './bundled-skills-seeder'
import { startBrowserService, stopBrowserService, getBrowserContext } from './browser-service'
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
  createChannelHub,
  createWeixinReplyContextStore,
  type ChannelHub,
} from './channel/channel-hub-bootstrap'
import { handleChannelList, handleChannelSend } from './channel/channel-service-ipc'
import { resolveWindowsClientDataRoot } from './client-data-root'
import {
  setActiveWorkspaceDirGetter,
  ensureWorkspaceTempLayout,
  resolveRecordingsDir,
} from './workspace-paths'
import {
  createScreenRecordService,
  createRealScreenRecordServiceDeps,
  parseScreenRecordSettings,
  registerScreenRecordIpc,
  type ScreenRecordService,
} from './screen-record'
import { setScreenRecordService, getScreenRecordService as getScreenRecordServiceFromAccessor } from './screen-record/accessor'
import { createNarrateService } from './screen-record/narrate-service'
import { setNarrateService } from './screen-record/narrate-accessor'
import { createBurnSubtitlesService } from './screen-record/burn-subtitles-service'
import { setBurnSubtitlesService } from './screen-record/burn-accessor'
import { clearScreenshotTempDir } from './app-ui-control/screenshot-cleanup'
import { startAppUiControlServer, stopAppUiControlServer } from './app-ui-control/server'
import { resizeImageIfNeeded } from './agent-runtime/image-resizer'
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
import {
  checkMemPalaceInstalled,
  ensureMemPalacePalaceDir,
  getMemPalaceBridge,
  getSoulFilePath,
  readUserMemoryFile,
  setupCloakBrowserIpcHandlers,
  setupMemPalaceIpcHandlers,
  writeUserMemoryFile,
} from './ipc/plugin-ipc'
import { registerAllIpcHandlers } from './ipc/ipc-handlers-registry'
import { registerCodingDevIpcHandlers } from './ipc/coding-dev-ipc'
import { initScriptRuntimes } from './runtime-env'
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
import { resolveClientStateDir, resolvePluginRuntimeDir, resolvePerfLogsDir } from './paths'
import { PerformanceMonitor } from './perf/performance-monitor'
import { createMeasuredHandler } from './perf/performance-ipc'
import { setupPerformanceIpcHandlers } from './ipc/performance-ipc'
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
import { applyWikiEmbeddingEnvDefaults } from './agent-runtime/wiki-embedding-config'
import { applyPluginBootstrapEnvDefaults } from './plugin-bootstrap-config'
import { initPluginDependenciesOnStartup } from './plugin-bootstrap'

/** Wiki 向量检索默认配置（国内镜像 + 启动预下载） */
applyWikiEmbeddingEnvDefaults()
/** 反检测浏览器 / MemPalace 启动预安装默认配置 */
applyPluginBootstrapEnvDefaults()

const _execFileAsync = _promisify(_execFile)

function registerCodingDevHandlers(): void {
  registerCodingDevIpcHandlers({
    getConfigManager: () => configManager,
    getActiveWorkspaceDir: getWorkspaceDir,
    reapplyCodingDevAcpEnv: reapplyCodingDevAcpEnvFromConfig,
  })
}

if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore', windowsHide: true })
  } catch {
  }
}

/** debug 与 createLogger 保持同一开关：仅在 LOG_LEVEL=debug 时输出 */
const isDebugLogEnabled = process.env.LOG_LEVEL === 'debug'

const log = {
  debug: (...args: unknown[]) => {
    if (isDebugLogEnabled) console.log('[Main]', ...args)
  },
  info: (...args: unknown[]) => console.log('[Main]', ...args),
  error: (...args: unknown[]) => console.error('[Main]', ...args),
  warn: (...args: unknown[]) => console.warn('[Main]', ...args),
}

// 全局变量
let mainWindow: BrowserWindow | null = null
let trayManager: TrayManager | null = null
/** 录屏服务单例（主窗创建后初始化） */
let screenRecordService: ScreenRecordService | null = null

/**
 * 获取录屏服务单例（供 bridge / 托盘读取）。
 */
export function getScreenRecordService(): ScreenRecordService | null {
  return getScreenRecordServiceFromAccessor()
}

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
let channelHub: ChannelHub | null = null  // 渠道出站 Hub（list/send）
let agentRuntimeBridge: AgentRuntimeBridge | null = null  // 客户端 Agent Runtime
let voiceCallService: VoiceCallService | null = null  // 语音通话服务
let performanceMonitor: PerformanceMonitor | null = null  // 性能监控（IPC 耗时/内存/启动阶段）
let performanceMonitorTimer: NodeJS.Timeout | null = null  // 周期性内存快照定时器
let isQuitting = false
let isCleaningUp = false // 防止 before-quit 清理期间重复触发

function createWindow(isTestMode: boolean = false, startHidden: boolean = false): Promise<void> {
  return createMainWindow({
    logger: log,
    setMainWindow: (window) => { mainWindow = window },
    isQuitting: () => isQuitting,
    getScreenRecordService: () => screenRecordService,
  }, isTestMode, startHidden)
}

/**
 * 初始化录屏服务（主窗就绪后：desktopCapturer + 写盘 + IPC）。
 */
function initScreenRecordService(): void {
  if (screenRecordService) return
  const deps = createRealScreenRecordServiceDeps({
    getMainWindow: () => mainWindow,
    sendToRenderer: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload)
      }
    },
    readSettingsJson: async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null
      try {
        return await mainWindow.webContents.executeJavaScript(
          `localStorage.getItem('mtbot-assistant-settings')`,
        )
      } catch {
        return null
      }
    },
    requestPersistAlwaysAllow: (value) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('screen-record:persist-always-allow', value)
      }
    },
  })
  const origEmit = deps.emitStatusChanged
  deps.emitStatusChanged = (detail) => {
    origEmit(detail)
    if (detail.ok) {
      trayManager?.updateScreenRecordState(
        detail.status === 'recording',
        detail.elapsedMs ?? 0,
        detail.status === 'paused',
      )
    } else {
      trayManager?.updateScreenRecordState(false, 0, false)
    }
  }
  screenRecordService = createScreenRecordService(deps)
  setScreenRecordService(screenRecordService)
  registerScreenRecordIpc(screenRecordService, mainWindow, performanceMonitor ?? undefined)
  // 旁白/烧录与录屏 IPC 同步挂接，避免启动窗口期 invoke 得到 disabled。
  // TTS 通过闭包惰性读取 voiceCallService，语音服务尚未就绪时会返回明确的 tts_unavailable。
  mountScreenRecordMediaServices()
  log.info('录屏服务已初始化')
}

/**
 * 挂接录屏旁白与字幕烧录服务（可重复调用；TTS 依赖模块级 voiceCallService）。
 */
function mountScreenRecordMediaServices(): void {
  const screenRecordMediaDeps = {
    resolveRecordingsDir,
    readSettings: async () => {
      let json: string | null = null
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          json = await mainWindow.webContents.executeJavaScript(
            `localStorage.getItem('mtbot-assistant-settings')`,
          )
        } catch {
          json = null
        }
      }
      return parseScreenRecordSettings(json)
    },
    generateAudioFile: async (text: string, destDir: string) => {
      if (!voiceCallService) throw new Error('语音服务未初始化，请稍后再试')
      return voiceCallService.generateAudioFile(text, destDir)
    },
  }
  setNarrateService(createNarrateService(screenRecordMediaDeps))
  setBurnSubtitlesService(createBurnSubtitlesService(screenRecordMediaDeps))
  log.info('录屏旁白/烧录服务已挂接')
}

function initTray(): void {
  initializeTray({
    logger: log,
    getMainWindow: () => mainWindow,
    getScreenRecordService: () => screenRecordService,
    setTrayManager: (manager) => { trayManager = manager },
    setQuitting: () => { isQuitting = true },
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
    log.debug(`[SkillWatcher] 技能列表已更新: ${skills.length} 个技能`)
    // watcher 扫的是磁盘，而 skills:listLocalInstalled 读的是 SkillRuntime 的内存索引；
    // 先让运行时重读磁盘，再通知渲染进程，避免前端刷新后仍拿到旧索引。
    void (async () => {
      try {
        await skillRuntime?.reloadExternalSkills()
      } catch (err) {
        log.error('[SkillWatcher] 同步 SkillRuntime 索引失败:', err)
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('skills:updated', skills)
      }
    })()
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
  log.info(`[AgentRuntime] 独立版本地模式（不连接云端 Gateway）`)

  agentRuntimeBridge = new AgentRuntimeBridge({
    // 关闭 Pre-LLM Router：它每轮在主回复前串行做一次独立 LLM 调用（实测 2.5-4.3s），
    // 是首响应慢的主因。技能发现已工具化（skill_list/search/invoke 按需调用），
    // 主 prompt 不再依赖 Router 预筛选，关闭后主 LLM 立即开跑、按需自助路由。
    routerEnabled: false,
    // 灵栖/Lumii 独立版：本地 provider 配置（enabled 时 Agent 走 direct 直连）
    getProviderConfig: () => loadProviderConfig(),
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
    showCronNotification: (title: string, body: string) => {
      log.info(`[AgentRuntime:CronNotify] title="${title}" body="${body.slice(0, 60)}"`)
      showDesktopTaskNotification(title, body)
    },
    sendFeishuMessage: async (text: string) => {
      if (!feishuLoginService) return { ok: false, error: '飞书服务未初始化' }
      return feishuLoginService.pushText(text)
    },
    getChannelRouter: () => channelHub?.router ?? null,
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
    /** skill_invoke 成功加载 SKILL.md 后回调：累计技能使用次数 */
    recordSkillExecution: async (skillIdOrName: string) => {
      if (!skillRuntime) return
      const store = skillRuntime.getSkillStore()
      if (!store) return
      const skillId = store.resolveSkillId(skillIdOrName)
      if (!skillId) return
      try {
        await store.recordExecution(skillId)
      } catch (err) {
        log.warn(`[recordSkillExecution] 更新技能统计失败: skill=${skillIdOrName} err=${err instanceof Error ? err.message : String(err)}`)
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
  setLocalMediaWorkspaceCwdGetter(() => agentRuntimeBridge!.getCwd())
  // 注册 agent-runtime:command IPC handler（必须在 setAgentRuntimeBridgeForIpc 之后）
  installAgentRuntimeCommandIpc(performanceMonitor ?? undefined)
  await agentRuntimeBridge.initialize()
  log.info('客户端 Agent Runtime 初始化完成（新协议 agent-runtime:command）')

  // 初始化语音通话服务
  const voiceServiceStartTime = performance.now()
  const voiceModelManager = new VoiceModelManager()
  const savedVoiceConfig = await loadVoiceEngineConfig()
  voiceCallService = new VoiceCallService(
    mainWindow!,
    (sessionKey, content, audioWavBase64) => submitVoiceTranscript(sessionKey, content, audioWavBase64),
    voiceModelManager,
    savedVoiceConfig,
  )
  registerVoiceIpc(mainWindow!, voiceCallService, voiceModelManager, performanceMonitor ?? undefined)
  performanceMonitor?.recordStartupPhase('voice-service', performance.now() - voiceServiceStartTime)
  // 注入音频 ASR 转录能力到文件导入 IPC
  setAudioTranscribeCallback((base64, mimeType) => voiceCallService!.transcribeAudioBuffer(base64, mimeType))
  log.info('语音通话服务已注册')

  // 语音就绪后重挂一次，确保 generateAudioFile 闭包拿到最新实例（幂等）
  mountScreenRecordMediaServices()

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
/**
 * 设置 IPC 处理器
 */
function setupIpcHandlers(): void {
  log.info('设置 IPC 处理器')

  registerAllIpcHandlers({
    getMainWindow: () => mainWindow,
    getConfigManager: () => configManager,
    getDirectoryManager: () => directoryManager,
    getSystemService: () => systemService,
    getSkillRuntime: () => skillRuntime,
    getSkillWatcher: () => skillWatcher,
    getTrayManager: () => trayManager,
    getWeixinLoginService: () => weixinLoginService,
    getWecomLoginService: () => wecomLoginService,
    getFeishuLoginService: () => feishuLoginService,
    getChannelHub: () => channelHub,
    getAgentRuntimeBridge: () => agentRuntimeBridge,
    getWorkspaceDir,
    reapplyCodingDevAcpEnv: reapplyCodingDevAcpEnvFromConfig,
    setMemoryInjectionSettings: setMemoryInjectionSettingsCache,
    isQuittingGetter: () => isQuitting,
    setIsQuitting: (value: boolean) => { isQuitting = value },
    log,
  })

  // Coding Dev handlers (保留原有的注册方式)
  registerCodingDevHandlers()

  // 技能商店 IPC（SkillNet）
  registerSkillnetStoreHandlers({
    getSkillsDir: () => join(getWorkspaceDir(), 'skills'),
    reloadSkills: async () => {
      await skillRuntime?.reloadExternalSkills()
      await skillWatcher?.refresh()
    },
  })
}

/**
 * 设置 API Server IPC 处理器
 *
 * 提供认证、设备配对、用户自服务等 HTTP API 调用
 */
/**
 * 设置 API Server IPC 处理器
 *
 * 注意：API IPC handlers 已经在 setupIpcHandlers() 中通过 registerAllIpcHandlers 注册
 * 此函数保留为空以保持向后兼容性
 */
function setupApiIpcHandlers(): void {
  log.info('设置 API Server IPC 处理器 (已通过 registerAllIpcHandlers 注册)')
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

  // lumii-local 须在 ready 前注册 privileged scheme
  registerLocalMediaSchemePrivileged()

  // 窗口录制：改用 Windows Graphics Capture，支持被遮挡窗口，减少黑屏
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch(
      'enable-features',
      'AllowWgcDesktopCapturer,AllowWgcScreenCapturer,AllowWgcWindowCapturer',
    )
  }

  // 等待 app ready
  await app.whenReady()

  // Windows 系统通知需要设置 AppUserModelId，否则 Notification 无法显示
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.lumii.app')
  }

  // 初始化文件日志系统（必须在 app.whenReady() 之后）
  fileLogger.initialize()
  registerLocalMediaProtocolHandler()
  // 服务启动时在控制台打印日志文件路径
  log.info('日志文件:', fileLogger.getCurrentLogFilePath())

  // 初始化性能监控（IPC 耗时/慢调用/内存快照），日志与主日志目录同层级下的 perf 子目录
  const perfMemorySnapshotIntervalMs = 60000
  performanceMonitor = new PerformanceMonitor({
    enabled: true,
    ipcSlowThresholdMs: 200,
    memorySnapshotIntervalMs: perfMemorySnapshotIntervalMs,
    maxQueueSize: 200,
    logDir: resolvePerfLogsDir(),
  })
  log.info('性能监控系统已初始化')

  // 周期性捕获内存快照并落盘：flush() 内部有游标保护，重复调用不会重写历史聚合事件；
  // 定时器与 performanceMonitor 生命周期一致，在 performCleanup() 中一并清理
  performanceMonitorTimer = setInterval(() => {
    if (!performanceMonitor) return
    const memoryUsage = process.memoryUsage()
    performanceMonitor.recordMemorySnapshot({
      timestamp: Date.now(),
      kind: 'memory.snapshot',
      mainProcess: {
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        rss: memoryUsage.rss,
      },
      childProcesses: app.getAppMetrics().map(metric => ({
        pid: metric.pid,
        type: metric.type,
        workingSetSize: metric.memory.workingSetSize,
        privateBytes: metric.memory.privateBytes ?? 0,
      })),
    })
    void performanceMonitor.flush().catch(err => {
      log.error('[perfMonitorTimer] 性能日志落盘失败', err)
    })
  }, perfMemorySnapshotIntervalMs)

  log.info('应用已就绪')

  // 检测是否由开机启动触发（--startup-launched 参数由 setLoginItemSettings 注入）
  const isStartupLaunch = process.argv.includes('--startup-launched')
  if (isStartupLaunch) {
    log.info('检测到开机启动，应用将直接最小化到托盘')
  }

  // 先注册 Agent Runtime IPC handler，再加载渲染进程。
  // dev 模式下 renderer 可能在 initAgentRuntime 完成前调用 agent-runtime:command；
  // 提前注册可让调用得到 NOT_READY 并走前端重试，避免 Electron 抛 No handler registered。
  installAgentRuntimeCommandIpc(performanceMonitor ?? undefined)

  // 初始化各模块（开机启动时隐藏窗口，只显示托盘图标）
  // 等待开机画面完整播放后再显示主窗口
  const windowStartTime = performance.now()
  await createWindow(isTestMode, isStartupLaunch)
  performanceMonitor?.recordStartupPhase('window', performance.now() - windowStartTime)

  // App UI 本机控制口（lumii-ui CLI）
  try {
    await startAppUiControlServer({
      getWindow: (target) => (target === 'main' ? mainWindow : null),
      resizeImageIfNeeded,
      getSkillRuntime: () => skillRuntime,
      getSkillWatcher: () => skillWatcher,
      readSettingsJson: async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return null
        try {
          return await mainWindow.webContents.executeJavaScript(
            `localStorage.getItem('mtbot-assistant-settings')`,
          )
        } catch {
          return null
        }
      },
    })
  } catch (err) {
    log.warn('App UI 本机控制口启动失败:', err instanceof Error ? err.message : err)
  }

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
  const screenRecordStartTime = performance.now()
  initScreenRecordService()
  performanceMonitor?.recordStartupPhase('screen-record', performance.now() - screenRecordStartTime)
  setupIpcHandlers()
  if (performanceMonitor) {
    setupPerformanceIpcHandlers(performanceMonitor)
    log.info('性能监控 IPC handlers 已注册')
  }

  // 初始化目录管理器和配置管理器（必须在其他模块之前）
  await directoryManager.initialize()
  configManager = new ConfigManager(directoryManager)
  await configManager.initialize()
  reapplyCodingDevAcpEnvFromConfig()

  // 将搜索配置注入到 process.env（供 Agent Runtime 工具使用）
  const searchConfig = configManager.getSearchConfig()
  if (searchConfig.langSearchApiKey) {
    process.env.LANGSEARCH_API_KEY = searchConfig.langSearchApiKey
  }
  if (searchConfig.searxngBaseUrl) {
    process.env.SEARXNG_BASE_URL = searchConfig.searxngBaseUrl
  }
  log.info('搜索工具配置已加载')

  // 将 ACP 后端选择持久化到 config 目录（而非 %TEMP%），确保重启后不丢失
  {
    const { setBackendSelectionBaseDir } = await import('./coding-dev-backends-stub/backend-selection.js')
    setBackendSelectionBaseDir(directoryManager.getDirectory('config'))
  }
  log.info('目录和配置管理器初始化完成')

  // 录屏/截图临时目录跟随「工作空间目录」设置
  setActiveWorkspaceDirGetter(() => {
    const dataDir = resolveClientStateDir()
    const defaultWorkspace = join(dataDir, 'workspace')
    return configManager?.getAppConfig().workspaceDirectory || defaultWorkspace
  })
  ensureWorkspaceTempLayout()
  // 须在工作空间 getter 挂接后清空，避免清到默认路径而非用户配置的工作空间
  clearScreenshotTempDir()
  log.info('工作空间 temp 布局已确保（temp/recordings、temp/screenshots）')

  // 灵栖/Lumii 独立版：无后端、无登录。
  // 不构造 apiClient / gatewayClient / nodeModeCoordinator / devicePairingService，
  // 这些实例保持 null，相关能力（provider 配置、agents 存储）由本地能力层（阶段 4/5）接管。
  // setupApiIpcHandlers 仍注册（内部 handler 已对 !apiClient 做本地兜底/降级）。
  setupApiIpcHandlers()
  setupMemPalaceIpcHandlers()
  setupCloakBrowserIpcHandlers()

  // 种子内置技能：必须在 initSkillRuntime 之前。
  // SkillRuntime 初始化时会扫描 workspace/skills 并把结果缓存进 LocalSkillStore.index，
  // 若此时目录还是空的，首次 skills:listLocalInstalled 会返回空列表，
  // 用户就只能手动点「刷新」才看得到默认技能。
  const mtbotDataDirForSeed = resolveClientStateDir()
  const seedWorkspaceDir = configManager?.getAppConfig().workspaceDirectory
    || join(mtbotDataDirForSeed, 'workspace')
  await seedBundledSkills(seedWorkspaceDir, mtbotDataDirForSeed)
  log.info('[Main] seedBundledSkills 完成，开始 initSkillRuntime')

  await initSkillRuntime()  // 初始化技能运行时（此时种子文件已就绪）

  // 脚本运行环境：写 node/python shim，缺 Python 时后台下载内置运行时
  await initScriptRuntimes()
  // 反检测浏览器（国内 GitHub 镜像）与 MemPalace（清华 PyPI）后台预安装，不阻塞启动
  initPluginDependenciesOnStartup()
  log.info('[Main] initScriptRuntimes + 插件预安装已触发，开始 initSkillWatcher')

  await initSkillWatcher()  // 初始化技能监控器（此时种子文件已就绪）
  log.info('[Main] initSkillWatcher 完成，开始 initUpdaterService')
  initUpdaterService()
  log.info('[Main] initUpdaterService 完成，开始 initAgentRuntime')

  // 初始化客户端 Agent Runtime（Feature Flag 默认关闭，需手动启用）
  const agentRuntimeStartTime = performance.now()
  await initAgentRuntime()
  performanceMonitor?.recordStartupPhase('agent-runtime', performance.now() - agentRuntimeStartTime)
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
  const weixinReplyContextStore = createWeixinReplyContextStore(resolveWindowsClientDataRoot())
  const weixinChannelAdapter = new WeixinChannelAdapter(
    weixinLoginService,
    agentRuntimeBridge!,
    weixinAcpBackendManager,
    weixinReplyContextStore,
  )
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

  // 装配渠道出站 Hub（Agent channel_list/send + cron 同源）
  channelHub = createChannelHub({
    feishu: feishuLoginService,
    weixin: weixinLoginService,
    wecom: wecomLoginService,
    dataRoot: resolveWindowsClientDataRoot(),
    weixinStore: weixinReplyContextStore,
  })
  weixinChannelAdapter.setReplyContextStore(channelHub.weixinStore)
  log.info('渠道出站 Hub 已装配')
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
    // 录屏进行中：flush finalize，避免坏文件
    if (screenRecordService) {
      await screenRecordService.flushBeforeQuit()
    }

    // 销毁宠物模式窗口（透明置顶窗口，需在主窗口关闭前释放 GPU 资源）
    disposePetModeIpc()

    await skillWatcher?.stop()
    await stopAppUiControlServer()
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

    // 性能监控：停止周期快照定时器，把内存里尚未落盘的事件写完后再销毁流
    if (performanceMonitorTimer) {
      clearInterval(performanceMonitorTimer)
      performanceMonitorTimer = null
    }
    if (performanceMonitor) {
      await performanceMonitor.flush()
      performanceMonitor.cleanOldLogs()
      performanceMonitor.destroy()
    }

    updaterService?.destroy()
    trayManager?.destroy()
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
