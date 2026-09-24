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
 * 全局管道错误保护
 *
 * 管道对端消失时会产生一类同族错误：
 * - EPIPE：向已关闭的管道写入（父进程终端关闭后 stdout/stderr 断开，
 *   Node.js 的 SyncWriteStream.writeSync 会同步抛出，导致 Electron 弹出
 *   "A JavaScript error occurred in the main process" 崩溃对话框）；
 * - EOF：写入时对端进程已退出（消息为 "write EOF"，栈在
 *   WriteWrap.onWriteComplete），典型场景是子进程崩溃后主进程仍在写它的 stdin；
 * - ERR_STREAM_DESTROYED：向已销毁的流写入。
 *
 * 三者都不是本进程的缺陷，此处一并静默忽略，其他未捕获异常仍正常传播。
 */
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE' || err.code === 'EOF' || err.code === 'ERR_STREAM_DESTROYED') {
    return
  }
  // eslint-disable-next-line no-console
  process.stderr?.write?.(`Uncaught exception: ${err.stack ?? err.message}\n`)
  process.exit(1)
})

/**
 * node:sqlite 至今仍是实验特性，首次加载就往 stderr 打一条 ExperimentalWarning；
 * 主进程的 stderr 经 Electron 的 console 通道落进 logger，会被记成 ERROR——
 * 每启动一次错误日志就多两行并不存在的「错误」，把真正要看的东西淹掉。
 * 这里只把这一条降级到 DEBUG（主日志仍留痕），其余警告原样放行。
 *
 * 写在 imports 之前是有意的：本文件编译成 CJS 后这段先于所有 require 执行，
 * 因此早于任何模块加载 node:sqlite（同上方 uncaughtException 的写法）。
 */
const originalEmitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('SQLite is an experimental feature')) {
    // eslint-disable-next-line no-console
    console.debug('[Node ExperimentalWarning]', String(warning))
    return
  }
  ;(originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning

import { execSync, execFile as _execFile } from 'child_process'
import { promisify as _promisify } from 'util'
import path from 'path'
import { app, BrowserWindow, dialog } from 'electron'
import qrcode from 'qrcode'
import { showDesktopTaskNotification as showDesktopNotify } from './desktop-notify'
import {
  registerLocalMediaSchemePrivileged,
  registerLocalMediaProtocolHandler,
  setLocalMediaWorkspaceCwdGetter,
} from './local-media-protocol'
import {
  registerPetAssetSchemePrivileged,
  registerPetAssetProtocolHandler,
} from './pet/pet-asset-protocol'
import { join } from 'path'
import { promises as fs, existsSync } from 'fs'
import { TrayManager } from './tray-manager'
import { initializeTray } from './tray/tray-bootstrap'
import { createMainWindow } from './window/main-window'
import { SystemService } from './system-service'
import { flushToolUsage } from './tool-usage-store'
import { normalizePromptStyle, type PromptStyleValue } from '../shared/prompt-style'
import { UpdaterService, setupUpdaterIpcHandlers } from './updater-service'
import { ClientSkillRuntime } from './skill-runtime'
import {
  loadProviderConfig,
} from './provider-config'
import {
  listAgentDefinitions,
  getAgentRecord,
  listUserAgentRecords,
  forkAgentRecord,
  updateAgentRecord,
  deleteAgentRecord,
} from './agents-repo'
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
import { QbotLoginService } from './qbot-login-service'
import { QbotChannelAdapter } from './channel/adapters/qbot-channel-adapter'
import { AcpBackendManager } from './channel/acp-backend-manager'
import {
  createChannelHub,
  createChannelPeerStore,
  createWeixinReplyContextStore,
  type ChannelHub,
} from './channel/channel-hub-bootstrap'
import { resolveWindowsClientDataRoot } from './client-data-root'
import { transcribeVoiceFile } from './channel/media-pipeline'
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
import { notifyAutonomousTurnEnd } from './agent-runtime/autonomous-wiring'
import { initToolEvolutionRuntime } from './agent-runtime/bash-tool-evolution/engine-assembly'
import {
  AgentRuntimeBridge,
  installAgentRuntimeCommandIpc,
  setAgentRuntimeBridgeForIpc,
  setWeixinBindingManagerForIpc,
  setAudioTranscribeCallback,
  getAcpBackendManager,
} from './agent-runtime'
import { submitVoiceTranscript } from './ipc/agent-runtime-ipc.js'
import {
  readSoulFile,
  readUserMemoryFile,
  setupCloakBrowserIpcHandlers,
  writeSoulFile,
  writeUserMemoryFile,
} from './ipc/plugin-ipc'
import { setPalaceBridgeProvider, setupPalaceIpcHandlers } from './ipc/palace-ipc'
import { registerAllIpcHandlers } from './ipc/ipc-handlers-registry'
import { registerCodingDevIpcHandlers } from './ipc/coding-dev-ipc'
import { CloudSyncManager } from './cloud-sync/sync-manager'
import { setCloudSyncManager, setCloudSyncWorkspaceChangedHandler } from './cloud-sync/sync-accessor'
import { SyncScheduler } from './cloud-sync/sync-scheduler'
import { loadCloudSyncConfig } from './cloud-sync/sync-config'
import { initScriptRuntimes } from './runtime-env'
import { VoiceModelManager } from './voice/model-manager.js'
import { VoiceCallService } from './voice/voice-service.js'
import { registerVoiceIpc } from './voice/voice-ipc.js'
import { loadVoiceEngineConfig } from './voice/voice-config-store.js'
import { setChannelAsrReadyChecker } from './channel/channel-voice-asr-hint.js'
import { findBuiltInAgent, mapApiRecordToAgentDefinition, reconcilePersonalMemory } from '@mtbot/agent-runtime'
import {
  applyCodingDevAcpEnvToProcess,
  defaultWorkspaceFallback,
  resolveCodingDevAcpWorkspacePath,
} from './coding-dev-env.js'
import { resolveClientStateDir, resolvePerfLogsDir } from './paths'
import { hasHeadlessFlag } from './platform/feature-probe'
import { PerformanceMonitor } from './perf/performance-monitor'
import { setupPerformanceIpcHandlers } from './ipc/performance-ipc'
import { registerSkillnetStoreHandlers } from './skillnet-store'
import {
  registerPetModeIpc,
  isPetForceIgnore,
  disposePetModeIpc,
} from './pet/pet-mode-ipc'
import { registerFilePreviewWindowIpc } from './file-preview/preview-window-ipc'
import { applyWikiEmbeddingEnvDefaults } from './agent-runtime/wiki-embedding-config'
import { applyPluginBootstrapEnvDefaults } from './plugin-bootstrap-config'
import { initPluginDependenciesOnStartup } from './plugin-bootstrap'

/** Wiki 向量检索默认配置（国内镜像 + 启动预下载） */
applyWikiEmbeddingEnvDefaults()
/** 反检测浏览器启动预安装默认配置 */
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
/** 云同步管理器与调度器（setupIpcHandlers 前创建，setActiveWorkspaceDirGetter 后启动） */
let cloudSyncManager: CloudSyncManager | null = null
let syncScheduler: SyncScheduler | null = null

/**
 * 获取录屏服务单例（供 bridge / 托盘读取）。
 */
export function getScreenRecordService(): ScreenRecordService | null {
  return getScreenRecordServiceFromAccessor()
}

/**
 * 桌面任务通知：统一走 desktop-notify（关上一条、default 超时，避免相同提醒叠层）。
 *
 * @param title - 通知标题
 * @param body - 正文（宜简短）
 * @param convId - 可选；点击后导航到会话
 */
function showDesktopTaskNotification(title: string, body: string, convId?: string): void {
  showDesktopNotify(title, body, convId, {
    log,
    getMainWindow: () => mainWindow,
    showTrayBalloon: (t, b) => trayManager?.showNotification(t, b),
    flashUnfocusedWindow: (win) => {
      trayManager?.flashWindow(win)
      win.once('focus', () => trayManager?.stopFlash(win))
    },
  })
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
let qbotLoginService: QbotLoginService | null = null  // QQ 机器人扫码服务
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
    // 本机注册的项目目录（设置 → 开发 → 项目管理）：纳入文件工具允许范围，
    // 使主助手 / pi 兜底 Agent 可直接读改项目文件（此前只能写脚本绕道 bash）。
    // 只在用户显式注册后扩大边界；外部项目（isExternal）的 realPath 是 workspace 外的真实路径。
    getAllowedRoots: () =>
      (configManager?.getAppConfig().codingDevProjects ?? []).map((p) => p.realPath),
    // 开启自主能力的额外 Agent（除 assistant 外）——来自本机配置，缺省为空表示仅 assistant 参与心跳
    getAutonomousAgents: () => configManager?.getAppConfig().autonomousAgents ?? [],
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
      // 灵栖/Lumii：用户自建 Agent + 常驻专家团队（注入系统提示词多 Agent 段，同时进入 Router 候选）。
      // 常驻专家供主助手经 spawn_agent 委托执行（子实例记忆归属 = 其 definitionId）。
      // 不含 code-dev：ACP 会话型，交接走「转交」流程（见 docs/plans/专项Agent/05-队长制-主助手接团队.md）。
      const delegatableSystemAgentIds = ['system-keeper', 'chronicler', 'info-curator']
      const systemExperts = delegatableSystemAgentIds
        .map((id) => findBuiltInAgent(id))
        .filter((d): d is NonNullable<typeof d> => Boolean(d))
        .map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          whenToUse: d.description,
          sourceType: 'system' as const,
        }))
      // code-dev（灵栖开发）：会话型专家——交接走 propose_dev_handoff 一键转交（F2），
      // 不能用 spawn 委托（ACP 直达是会话级路由，spawn 出来的是 pi 兜底实例、不绑项目）。
      const codeDev = findBuiltInAgent('code-dev')
      if (codeDev) {
        systemExperts.push({
          id: codeDev.id,
          name: codeDev.name,
          description: `${codeDev.description} Session-based specialist: hand it off with the \`propose_dev_handoff\` tool (do NOT spawn it).`,
          whenToUse: codeDev.description,
          sourceType: 'system' as const,
        })
      }
      return [
        ...listUserAgentRecords()
          .filter((a) => a.isEnabled !== false)
          .map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            // 路由信号：用户 Agent 的表单（含「AI 自动填写」）写入，缺失时 Router 只能靠描述
            whenToUse: a.whenToUse,
            triggerExamples: a.triggerExamples,
            category: a.category,
            emoji: a.identity?.emoji,
          })),
        ...systemExperts,
      ]
    },
    /** 独立版无跨设备概念，返回空列表 */
    getUserDevices: async () => [],
    /** 获取用户 SOUL 内容（从本地文件 ~/.lumii/data/soul.md 读取） */
    getSoulContent: async () => {
      try {
        const soul = await readSoulFile()
        if (!soul) return undefined
        return soul.content.trim() || undefined
      } catch {
        return undefined
      }
    },
    /** 读取用户记忆（用于 profile_memory / memory_search 工具，本地文件 ~/.lumii/data/user-memory.md） */
    getUserMemory: async () => readUserMemoryFile(),
    // 记忆宫殿的三个回调（searchPalace / readPalaceDrawer / archivePalaceDrawer）由
    // `AgentRuntimeBridge` 构造期的 withBuiltinPalace 注入（见 agent-runtime/palace-backend.ts）：
    // 实现走自建 SQLite 的 PalaceRepo。这里**刻意不提供**——留一份宿主的备选实现意味着
    // 两处都要维护，而 MemPalace（Python）已于 2026-09-18 整体移除。
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
    /** 读取系统提示词风格（实验功能；从渲染进程 localStorage 同步，缺省 = 简要档） */
    getPromptStyleSettings: async () => {
      if (promptStyleSettingsCache) {
        return promptStyleSettingsCache
      }
      const settings = await getRendererSettings()
      const resolved = {
        style: normalizePromptStyle(settings?.promptStyle?.style),
      }
      promptStyleSettingsCache = resolved
      return resolved
    },
    /**
     * 更新用户记忆（写入本地文件 ~/.lumii/data/user-memory.md）。
     *
     * **对账在写入点做，不在调用方做**（2026-09-18）：条目元数据（`<!--m:id date-->`）
     * 由 harness 独占，但四条写入路径里原先只有 `FileMemoryHandler.appendToUserMemory`
     * 做了对账。定时任务 `companion-memory-deep`（本体是另一个 handler）、模型的
     * `profile_memory` 工具、渲染层 IPC 全都直接写——实测 2026-09-18 12:01 的深度
     * 整理把 9 条条目的身份**一次性抹平**，而这个过程完全无声。
     *
     * 放在这里是因为它是所有路径的必经之路，且对账是**纯 CPU 的字符串处理**
     * （不需要 DB、不需要 LLM），放在最底层没有额外代价。调用方即使已经对过账，
     * 再对一次也是幂等的。
     */
    updateUserMemory: async (content: string) => {
      const previous = (await readUserMemoryFile())?.content ?? ''
      const reconciled = reconcilePersonalMemory(content, previous)
      if (reconciled.removed > 0 || reconciled.added > 0) {
        log.info(
          `[updateUserMemory] 条目对账：新增 ${reconciled.added}、沿用 ${reconciled.kept}、删除 ${reconciled.removed}`,
        )
      }
      return writeUserMemoryFile(reconciled.content)
    },
    /** 更新用户 SOUL 内容（写入本地文件 ~/.lumii/data/soul.md） */
    updateSoulContent: async (content: string) => writeSoulFile(content),
    fetchAgentDefinitionById: async (id: string) => {
      const built = findBuiltInAgent(id)
      if (built) return built
      // 灵栖/Lumii：从本地 agents 仓库解析用户 Agent 定义
      const rec = getAgentRecord(id)
      if (!rec) return undefined
      return mapApiRecordToAgentDefinition(rec as unknown as Record<string, unknown>)
    },
    fetchAgentDefinitionsFromApi: async () => {
      // 灵栖/Lumii：返回全部 Agent 的运行时定义。
      // 必须与上面的 fetchAgentDefinitionById 一致地让系统 Agent 走内置定义：
      // record 往返（systemAgentRecords → mapApiRecordToAgentDefinition）会丢掉
      // memory / tools / maxTurns（详见 listAgentDefinitions 的说明），而这份结果会被
      // 写进 agent_definition_cache 并**优先于内置兜底**被读取，导致运行时配置静默失效。
      return listAgentDefinitions()
    },
    showCronNotification: (title: string, body: string, convId?: string) => {
      log.info(`[AgentRuntime:CronNotify] title="${title}" body="${body.slice(0, 60)}" convId="${convId ?? ''}"`)
      showDesktopTaskNotification(title, body, convId)
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
      // 每轮助手回复的即时归档（wing='conversations'）已由 AgentRuntimeBridge 构造期的
      // withBuiltinPalace 接管（见 agent-runtime/palace-backend.ts）——那个 wrapper 会
      // 先转发本回调（自主进化的轮次结算挂在下面），再写自建宫殿。
      // 2026-09-18 教训（差异 #19）：这条路径原先直连 Python 而不在后端开关里，
      // 换了后端却漏切，旧库当天仍在增长而新检索读不到。
      // 自主进化：回合结束触发满意度评分与目标生成（旁路，失败不影响会话）
      void notifyAutonomousTurnEnd(convId)
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

  // ── VAD 预热必须排在 bridge 初始化之前（2026-09-18 实测，见 onnx-runtime-gate.ts）──
  //
  // sherpa 携带 `onnxruntime.dll` **1.27**，onnxruntime-node 携带同名 **1.14**；
  // Windows 在**已加载模块**里按基名解析，而 sherpa-onnx-c-api.dll 只写裸文件名
  // （二进制确认，无路径）。于是谁先加载，谁决定整个进程用哪个 ONNX Runtime——
  // 而 1.14 加载不了 opset 27 的 VAD 模型，会直接把应用打崩（Exit 4294930435）。
  //
  // 因此：**初始化语音服务后立刻预热 VAD**，抢在 bridge 初始化里任何 E5 之前。
  // bridge 侧还有一道 `waitForSherpa()` 兜底（挂起而非放行），两处一起构成顺序保证。
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
  // 渠道语音失败提示：按 Paraformer 是否已下载分流文案
  setChannelAsrReadyChecker(() => voiceModelManager.isModelDownloaded('asr-paraformer-zh'))
  // 注入音频 ASR 转录能力到文件导入 IPC
  setAudioTranscribeCallback((base64, mimeType) => voiceCallService!.transcribeAudioBuffer(base64, mimeType))
  log.info('语音通话服务已注册')

  // 语音就绪后重挂一次，确保 generateAudioFile 闭包拿到最新实例（幂等）
  mountScreenRecordMediaServices()

  // VAD 预热：**必须先于 bridge 初始化**。不阻塞启动（后台跑），但顺序是硬要求。
  // 失败只记日志——VAD 不可用不该拦住对话（非 micless 通话会再走一次 ensureInitialized）。
  void voiceCallService
    .ensureInitialized()
    .then(() => log.info('语音引擎预热完成（VAD 已占 ONNX 运行时）'))
    .catch((e) => log.warn(`语音引擎预热失败（非致命）: ${e.message}`))

  await agentRuntimeBridge.initialize()
  log.info('客户端 Agent Runtime 初始化完成（新协议 agent-runtime:command）')

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

  // ── bash 命令工具进化引擎 ──
  // 自动挖掘高频 bash 命令 → LLM 草拟参数化工具 → 对话内审批 → 运行时注册。
  // 设计见 docs/design/Agent协作与提示词/2026-09-08-Bash命令工具进化设计.md
  initToolEvolutionRuntime({
    bridge: agentRuntimeBridge!,
    getMainWindow: () => mainWindow,
  })
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

/** 系统提示词风格主进程缓存（避免 executeJavaScript 失败时始终回退为默认档） */
let promptStyleSettingsCache: { style: PromptStyleValue } | null = null

/**
 * 同步系统提示词风格到主进程缓存（渲染进程切换时 IPC 调用；实验功能）
 */
function setPromptStyleSettingsCache(settings: { style?: PromptStyleValue }): void {
  promptStyleSettingsCache = {
    style: normalizePromptStyle(settings.style),
  }
}

async function getRendererSettings(): Promise<{
  workspace?: { directory?: string }
  memory?: { injectPersonalMemory?: boolean; injectWorkMemory?: boolean }
  promptStyle?: { style?: PromptStyleValue }
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
    getQbotLoginService: () => qbotLoginService,
    getChannelHub: () => channelHub,
    getAgentRuntimeBridge: () => agentRuntimeBridge,
    getWorkspaceDir,
    reapplyCodingDevAcpEnv: reapplyCodingDevAcpEnvFromConfig,
    setMemoryInjectionSettings: setMemoryInjectionSettingsCache,
    setPromptStyleSettings: setPromptStyleSettingsCache,
    restartCloudSyncScheduler: (cfg) => { syncScheduler?.start(cfg) },
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
 * 无头模式下打印二维码到终端
 * @param content 二维码要编码的原始内容——必须是登录 URL 本身，
 *   不能传渲染进程用的 data URL（那是「二维码图片」，扫出来是 base64 而非登录链接）
 * @param serviceName 服务名（微信/企微/飞书/QQ）
 */
async function printQrCodeToTerminal(content: string, serviceName: string): Promise<void> {
  try {
    const qr = await qrcode.toString(content, { type: 'terminal', small: true })
    console.log(`\n=== ${serviceName} 登录二维码 ===\n`)
    console.log(qr)
    console.log('\n请用手机扫码登录\n')
  } catch (err) {
    log.error(`[${serviceName}] 打印二维码到终端失败:`, err instanceof Error ? err.message : String(err))
  }
}

/**
 * 无头模式下打印欢迎信息和快速开始指南
 */
function printHeadlessWelcome(): void {
  const { version } = require('../../package.json')
  const dataDir = resolveClientStateDir()

  console.log('\n' + '='.repeat(70))
  console.log('  灵栖 Lumii — 无头模式 (Headless Mode)')
  console.log('  版本:', version)
  console.log('='.repeat(70))
  console.log('\n✅ 服务已启动，控制口就绪')
  console.log('\n📂 数据目录:', dataDir)
  console.log('📋 日志目录:', path.join(dataDir, 'logs'))
  console.log('🔧 配置目录:', path.join(dataDir, 'config'))
  console.log('\n' + '─'.repeat(70))
  console.log('快速开始指南')
  console.log('─'.repeat(70))
  console.log('\n1️⃣  查看服务状态与配置建议')
  console.log('   lumii-ui status')
  console.log('\n2️⃣  配置 AI 模型提供商（必需）')
  console.log('   lumii-ui setup           # 交互式配置向导')
  console.log('\n3️⃣  创建对话会话')
  console.log('   lumii-ui conversation create --title "我的第一个会话"')
  console.log('\n4️⃣  发送消息（--wait 会等到回复并打印正文）')
  console.log('   lumii-ui send --session <会话ID> --text "你好，介绍一下你自己" --wait')
  console.log('\n5️⃣  查看消息历史')
  console.log('   lumii-ui context messages --session <会话ID> --limit 10 --text')
  console.log('\n' + '─'.repeat(70))
  console.log('高级功能')
  console.log('─'.repeat(70))
  console.log('\n🔌 渠道接入（微信/企微/飞书/QQ）')
  console.log('   # 扫码登录后，Agent 可通过渠道接收/回复消息')
  console.log('   # 二维码会自动打印到终端\n')
  console.log('🌐 浏览器控制（需要 Chrome 系浏览器）')
  console.log('   export LUMII_BROWSER_EXECUTABLE=/usr/bin/google-chrome')
  console.log('   export LUMII_BROWSER_NO_SANDBOX=1')
  console.log('   # 重启应用后，Agent 可使用 browser_navigate 等工具\n')
  console.log('🛠️  技能管理')
  console.log('   lumii-ui skill list      # 列出已安装技能')
  console.log('   lumii-ui skill enable    # 启用技能')
  console.log('\n' + '─'.repeat(70))
  console.log('帮助信息')
  console.log('─'.repeat(70))
  console.log('\n💡 查看所有命令')
  console.log('   lumii-ui help')
  console.log('\n💡 查看特定命令帮助')
  console.log('   lumii-ui help <命令名>')
  console.log('\n💡 查看场景化使用指南')
  console.log('   lumii-ui guide           # 按使用场景分类的帮助')
  console.log('\n' + '='.repeat(70) + '\n')
}

/**
 * 应用初始化
 */
async function initialize(): Promise<void> {
  log.info('灵栖 Lumii 启动中...')

  // 检查是否在测试模式（用于 E2E 测试）
  const isTestMode = process.argv.includes('--test-mode')
  // 检查是否在无头模式（不创建窗口/托盘/桌宠/录屏）
  const isHeadless = hasHeadlessFlag()
  if (isHeadless) {
    log.info('无头模式已启用，将跳过 UI 层初始化')
  }

  // 单实例锁定（测试模式下跳过）
  if (!isTestMode) {
    const gotTheLock = app.requestSingleInstanceLock()
    if (!gotTheLock) {
      log.warn('已有实例在运行，退出')
      app.quit()
      return
    }

    // 第二个实例尝试启动时，聚焦到现有窗口（无头模式下跳过）
    app.on('second-instance', () => {
      if (!isHeadless && mainWindow) {
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
  // 用户宠物目录的资源通道（lumii-pet://），同样须在 ready 前注册
  registerPetAssetSchemePrivileged()

  // 窗口录制：改用 Windows Graphics Capture，支持被遮挡窗口，减少黑屏
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch(
      'enable-features',
      'AllowWgcDesktopCapturer,AllowWgcScreenCapturer,AllowWgcWindowCapturer',
    )
  }

  // 禁用 Electron 安全警告（桌面应用运行在受信任的本地环境中）
  // 避免控制台显示 "Electron Security Warning" 和 CSP 相关警告
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

  // 等待 app ready
  await app.whenReady()

  // Windows 系统通知需要设置 AppUserModelId，否则 Notification 无法显示
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.lumii.app')
  }
  // 通知/托盘等处的应用显示名（与 electron-builder productName 一致）
  app.setName('Lumii')

  // 注：设计 §6.2 曾要求 Linux 上调 `app.setDesktopName('lumii.desktop')`，
  // 但该 API **在 Electron 36 里并不存在**（electron.d.ts 中无此声明，实测编译报错）。
  // Linux 桌面关联窗口与启动器图标靠的是 electron-builder 生成的 .desktop 里
  // 的 StartupWMClass 字段（见 electron-builder.json 的 linux.desktop 段），
  // 那一条已在 T2 配好，此处无需再做。

  // 初始化文件日志系统（必须在 app.whenReady() 之后）
  fileLogger.initialize()
  registerLocalMediaProtocolHandler()
  // 用户宠物目录的资源通道（lumii-pet://）。与 lumii-local 同理：
  // scheme 须在 ready 前 registerSchemesAsPrivileged（见上），
  // handler 则须在 ready 后 protocol.handle。
  registerPetAssetProtocolHandler()
  // 服务启动时在控制台打印日志文件路径
  log.info('日志文件:', fileLogger.getCurrentLogFilePath())
  log.info('错误日志文件:', fileLogger.getCurrentErrorLogFilePath())

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
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers,
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
  // 无头模式下跳过窗口创建
  if (!isHeadless) {
    const windowStartTime = performance.now()
    await createWindow(isTestMode, isStartupLaunch)
    performanceMonitor?.recordStartupPhase('window', performance.now() - windowStartTime)
  } else {
    log.info('无头模式：跳过窗口创建')
  }

  // App UI 本机控制口（lumii-ui CLI）
  // 无头模式下 getWindow 返回 null，readSettingsJson 返回 null（无渲染进程）
  try {
    await startAppUiControlServer({
      getWindow: (target) => (target === 'main' ? mainWindow : null),
      resizeImageIfNeeded,
      getSkillRuntime: () => skillRuntime,
      getSkillWatcher: () => skillWatcher,
      // 渠道登录服务可能晚于控制口初始化，这里用 getter 延迟取值
      getChannelLoginServices: () => ({
        weixin: weixinLoginService,
        wecom: wecomLoginService,
        feishu: feishuLoginService,
        qbot: qbotLoginService,
      }),
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

    // 无头模式下打印快速开始指南
    if (isHeadless) {
      printHeadlessWelcome()
    }
  } catch (err) {
    log.warn('App UI 本机控制口启动失败:', err instanceof Error ? err.message : err)
  }

  // 注册宠物模式 IPC（独立透明窗口，与 mainWindow 解耦）
  // 无头模式下跳过桌宠
  if (!isHeadless) {
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
  } else {
    log.info('无头模式：跳过宠物模式 IPC 注册')
  }

  // 文件预览独立窗口（可拖出主窗口外）
  // 无头模式下跳过文件预览窗口
  if (!isHeadless) {
    registerFilePreviewWindowIpc({
      getMainWindow: () => mainWindow,
      preloadPath: join(__dirname, '../preload/index.js'),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      indexHtmlPath: join(__dirname, '../renderer/index.html'),
    })
  } else {
    log.info('无头模式：跳过文件预览窗口 IPC 注册')
  }

  // 无头模式下跳过托盘和录屏初始化
  if (!isHeadless) {
    initTray()
    initSystemService()
    const screenRecordStartTime = performance.now()
    initScreenRecordService()
    performanceMonitor?.recordStartupPhase('screen-record', performance.now() - screenRecordStartTime)
  } else {
    log.info('无头模式：跳过托盘和录屏初始化')
    initSystemService()  // 系统服务保留（非 UI 层）
  }

  // 云同步管理器须在 setupIpcHandlers 前创建，使 registerCloudSyncIpcHandlers 能订阅 status 事件
  cloudSyncManager = new CloudSyncManager()
  setCloudSyncManager(cloudSyncManager)
  syncScheduler = new SyncScheduler(cloudSyncManager)
  setCloudSyncWorkspaceChangedHandler(() => syncScheduler?.onWorkspaceChanged())

  // 注入云同步冲突回调：检测到冲突时创建系统维护目标 + 立即驱动 Agent 处理
  cloudSyncManager.setOnConflictDetected((conflict) => {
    if (!agentRuntimeBridge || !agentRuntimeBridge.isInitialized) {
      log.warn('[CloudSync] 检测到冲突但 agentRuntimeBridge 未就绪，仅创建目标等待心跳驱动')
      return
    }
    // 委托 bridge 创建 system-maintenance 冲突目标并立即驱动 Agent（受限实例）。
    // bridge.executeSyncConflictGoal 内部有 in-flight 守卫，不重入。
    void agentRuntimeBridge.executeSyncConflictGoal().then(
      (summary) => {
        if (summary) log.info(`[CloudSync] 冲突 Agent 处理完成: ${summary}`)
      },
      (err) => {
        log.error('[CloudSync] 冲突 Agent 处理异常:', err instanceof Error ? err.message : String(err))
      },
    )
  })

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
  // 会话级开发上下文（项目 + 工具）同样落 config 目录
  {
    const { setDevContextBaseDir } = await import('./coding-dev-dev-context.js')
    setDevContextBaseDir(directoryManager.getDirectory('config'))
  }
  // 开发配置切片（项目列表 / Agent 绑定）统一访问点：渠道命令与命令处理器共用
  {
    const { setCodingDevConfigGetter, setCodingDevConfigWriter } = await import('./coding-dev-env.js')
    setCodingDevConfigGetter(() => configManager?.getAppConfig() ?? {})
    setCodingDevConfigWriter(async (patch) => {
      await configManager?.updateAppConfig(patch)
    })
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

  // 云同步调度：工作空间 getter 挂接后再启动（sync 惰性读工作空间目录）
  syncScheduler?.start(loadCloudSyncConfig())

  // 灵栖/Lumii 独立版：无后端、无登录。
  // 不构造 apiClient / gatewayClient / nodeModeCoordinator / devicePairingService，
  // 这些实例保持 null，相关能力（provider 配置、agents 存储）由本地能力层（阶段 4/5）接管。
  // setupApiIpcHandlers 仍注册（内部 handler 已对 !apiClient 做本地兜底/降级）。
  setupApiIpcHandlers()
  // 记忆宫殿（自研 SQLite）IPC
  setPalaceBridgeProvider(() => agentRuntimeBridge)
  setupPalaceIpcHandlers()
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

  // 脚本运行环境：写 node/python shim，缺 Python 时后台下载内置运行时。
  // 脚本运行时按需懒加载，不阻塞首屏（首次会下载内置 Python，改 fire-and-forget）。
  void initScriptRuntimes().catch((err) => {
    log.warn('脚本运行时初始化失败（不影响主流程，用到可执行技能时按需重试）:', err instanceof Error ? err.message : err)
  })
  // 反检测浏览器（国内 GitHub 镜像）后台预安装，不阻塞启动
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

  // 注入云同步冲突 Agent 重试回调：SyncScheduler 每次 tick 若仍处于 conflict 且冷却已过，
  // 自动驱动 Agent 重新处理（与心跳 evolution-tick 同路径）
  syncScheduler?.setOnConflictPending(async () => {
    if (!agentRuntimeBridge?.isInitialized) return
    await agentRuntimeBridge.executeSyncConflictGoal()
  })

  // 启动浏览器控制服务（控制用户本机浏览器）
  const browserStarted = await startBrowserService()
  if (browserStarted) {
    log.info('浏览器控制服务已就绪')
  } else {
    log.warn('浏览器控制服务启动失败，browser.* 命令将不可用')
  }

  log.info('灵栖 Lumii 启动完成')

  // 三个渠道登录服务移出关键路径：setImmediate 后台异步初始化，不阻塞首屏；
  // 装配逻辑保留，失败仅记日志。channelHub 依赖三者实例，一并放入后台完成。
  setImmediate(() => {
    void (async () => {
      // 声明 weixin 变量（在 try/catch 外层，供后续 channelHub 装配使用）
      // 渠道 peer 持久化先行创建：adapter 早于 Hub 构造，入站记录要写进同一实例
      const channelPeerStore = createChannelPeerStore(resolveWindowsClientDataRoot())
      let weixinReplyContextStore: ReturnType<typeof createWeixinReplyContextStore> | undefined
      let weixinChannelAdapter: WeixinChannelAdapter | undefined
      let wecomChannelAdapter: WecomChannelAdapter | undefined
      let qbotChannelAdapter: QbotChannelAdapter | undefined

      // 初始化微信(iLink)登录服务
      try {
        weixinLoginService = new WeixinLoginService()
        await weixinLoginService.initialize()
        // 注入 SILK ASR 转录回调
        weixinLoginService.silkAsrCallback = (samples, sampleRate) => voiceCallService!.transcribePcm(samples, sampleRate)
      } catch (err) {
        log.warn('微信(iLink)服务初始化失败:', err instanceof Error ? err.message : err)
        // 不 return：微信失败不应阻断企微/飞书/QQ 的初始化
        weixinLoginService = null as any
      }

      if (weixinLoginService) {

      // 微信消息：通过 WeixinChannelAdapter 处理，支持完整斜杠命令集和 ACP 后端路由
      const weixinAcpBackendManager = new AcpBackendManager()
      weixinReplyContextStore = createWeixinReplyContextStore(resolveWindowsClientDataRoot())
      weixinChannelAdapter = new WeixinChannelAdapter(
        weixinLoginService!,
        agentRuntimeBridge!,
        weixinAcpBackendManager,
        weixinReplyContextStore,
      )
      weixinChannelAdapter.startListening()
      setWeixinBindingManagerForIpc(weixinChannelAdapter.bindingManager)

      // 微信状态变化推送到渲染进程
      weixinLoginService!.on('statusChange', (status: string, session?: unknown) => {
        mainWindow?.webContents.send('weixin:statusChange', status, session)
      })
      weixinLoginService!.on('qrcode', (dataUrl: string, rawUrl?: string) => {
        if (isHeadless && rawUrl) {
          void printQrCodeToTerminal(rawUrl, '微信')
        } else {
          mainWindow?.webContents.send('weixin:qrcode', dataUrl)
        }
      })
      weixinLoginService!.on('error', (message: string) => {
        mainWindow?.webContents.send('weixin:error', message)
      })
      log.info('微信(iLink)服务已初始化')
      }

      // 初始化企业微信 AI Bot 扫码服务
      try {
        wecomLoginService = new WecomLoginService()
        await wecomLoginService.initialize()
        wecomChannelAdapter = new WecomChannelAdapter(wecomLoginService, agentRuntimeBridge!)
        wecomChannelAdapter.startListening()
        wecomLoginService.on('statusChange', (status: string, session?: unknown) => {
          mainWindow?.webContents.send('wecom:statusChange', status, session)
        })
        wecomLoginService.on('qrcode', (dataUrl: string, rawUrl?: string) => {
          if (isHeadless && rawUrl) {
            void printQrCodeToTerminal(rawUrl, '企业微信')
          } else {
            mainWindow?.webContents.send('wecom:qrcode', dataUrl)
          }
        })
        wecomLoginService.on('error', (message: string) => {
          mainWindow?.webContents.send('wecom:error', message)
        })
        log.info('企业微信(AI Bot)服务已初始化')
      } catch (err) {
        log.warn('企业微信(AI Bot)服务初始化失败:', err instanceof Error ? err.message : err)
      }

      // 初始化飞书扫码服务
      try {
        feishuLoginService = new FeishuLoginService()
        await feishuLoginService.initialize()
        // 注入语音转文字回调（飞书 opus 语音消息 → ASR）
        // 模型未就绪时返回空字符串，不阻塞消息处理
        feishuLoginService.asrCallback = async (absPath) => {
          try {
            return await transcribeVoiceFile(absPath, (samples, sampleRate) => voiceCallService!.transcribePcm(samples, sampleRate))
          } catch (e) {
            console.warn('[Feishu ASR] 转录失败（可能语音模型未下载）:', e instanceof Error ? e.message : String(e))
            return ''
          }
        }
        const feishuChannelAdapter = new FeishuChannelAdapter(feishuLoginService, agentRuntimeBridge!)
        feishuChannelAdapter.startListening()
        feishuLoginService.on('statusChange', (status: string, session?: unknown) => {
          mainWindow?.webContents.send('feishu:statusChange', status, session)
        })
        feishuLoginService.on('qrcode', (dataUrl: string, rawUrl?: string) => {
          if (isHeadless && rawUrl) {
            void printQrCodeToTerminal(rawUrl, '飞书')
          } else {
            mainWindow?.webContents.send('feishu:qrcode', dataUrl)
          }
        })
        feishuLoginService.on('error', (message: string) => {
          mainWindow?.webContents.send('feishu:error', message)
        })
        log.info('飞书服务已初始化')
      } catch (err) {
        log.warn('飞书服务初始化失败:', err instanceof Error ? err.message : err)
      }

      // 初始化 QQ 机器人扫码服务
      try {
        qbotLoginService = new QbotLoginService()
        await qbotLoginService.initialize()
        // 注入语音转文字回调（QQ amr/silk 语音消息 → ASR）
        // silk-wasm 未加载或模型未就绪时返回空字符串，不阻塞消息处理
        qbotLoginService.asrCallback = async (absPath) => {
          try {
            return await transcribeVoiceFile(absPath, (samples, sampleRate) => voiceCallService!.transcribePcm(samples, sampleRate))
          } catch (e) {
            console.warn('[Qbot ASR] 转录失败（silk-wasm 未加载或语音模型未下载）:', e instanceof Error ? e.message : String(e))
            return ''
          }
        }
        qbotChannelAdapter = new QbotChannelAdapter(qbotLoginService, agentRuntimeBridge!)
        qbotChannelAdapter.startListening()
        qbotLoginService.on('statusChange', (status: string, session?: unknown) => {
          mainWindow?.webContents.send('qbot:statusChange', status, session)
        })
        qbotLoginService.on('qrcode', (dataUrl: string, rawUrl?: string) => {
          if (isHeadless && rawUrl) {
            void printQrCodeToTerminal(rawUrl, 'QQ 机器人')
          } else {
            mainWindow?.webContents.send('qbot:qrcode', dataUrl)
          }
        })
        qbotLoginService.on('error', (message: string) => {
          mainWindow?.webContents.send('qbot:error', message)
        })
        log.info('QQ 机器人服务已初始化')
      } catch (err) {
        log.warn('QQ 机器人服务初始化失败:', err instanceof Error ? err.message : err)
      }

      // 装配渠道出站 Hub（Agent channel_list/send + cron 同源）
      channelHub = createChannelHub({
        feishu: feishuLoginService!,
        weixin: weixinLoginService ?? undefined,
        wecom: wecomLoginService!,
        qbot: qbotLoginService ?? undefined,
        dataRoot: resolveWindowsClientDataRoot(),
        weixinStore: weixinReplyContextStore,
        peerStore: channelPeerStore,
      })
      if (weixinChannelAdapter) {
        weixinChannelAdapter.setReplyContextStore(channelHub.weixinStore)
      }
      // 入站 peer 记录：QQ/企微发送走被动回复窗口，peer 表此前只在内存里，
      // 主进程重启即清空，导致 channel_list 永远找不到可投递对象
      if (wecomChannelAdapter) {
        wecomChannelAdapter.setChannelPeerStore(channelHub.peerStore, channelHub.wecomProvider)
      }
      if (qbotChannelAdapter && channelHub.qbotProvider) {
        qbotChannelAdapter.setChannelPeerStore(channelHub.peerStore, channelHub.qbotProvider)
      }
      channelHub.restorePeerSnapshots()
      log.info('渠道出站 Hub 已装配')
    })()
  })
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
    // 云同步：停掉定时器与 workspace 文件监听（fs.watch 句柄需显式关闭）
    syncScheduler?.stop()
    await stopAppUiControlServer()
    await stopBrowserService()

    // 微信登出清理
    if (weixinLoginService) {
      weixinLoginService.shutdown()
    }

    // 工具调用计数是 debounce 落盘的，退出前补一次，避免丢掉最后几次调用。
    // 必须排在 destroyAll 之前：它内部会关闭 agent-runtime 数据库，之后 flush 只会
    // 报 "database is not open" 并落 0 条（2026-09-19 实测）。
    await flushToolUsage()

    // 销毁所有 Agent 实例并关闭本地数据库
    // 触发 abort → agent:error 事件 → bridge 删除流式占位行，确保 is_streaming 不残留
    if (agentRuntimeBridge) {
      log.info('[performCleanup] 开始销毁 Agent Runtime Bridge')
      agentRuntimeBridge.destroyAll()
      log.info('[performCleanup] Agent Runtime Bridge 已销毁')
    }

    // 停止 MCP Server 子进程。
    //
    // 为什么单独一步：MCP client 由 `mcpManager` 独立持有，`destroyAll()` 不覆盖
    // 它（那管的是 agent 实例与调度器）。而这些是**独立子进程**，不终止就会拖住
    // Electron 的退出——2026-09-20 Linux 实测：`app.exit(0)` 之后 McpManager 仍在
    // 重连、子进程仍在跑，GPU watchdog 在窗口期判定失败并
    // `FATAL: GPU process isn't usable. Goodbye.`（干净退出变成带 FATAL 的退出）。
    try {
      await agentRuntimeBridge?.stopMcpServers()
      log.info('[performCleanup] MCP Server 已停止')
    } catch (err) {
      log.warn('[performCleanup] MCP Server 停止失败:', err)
    }

    // 终止所有运行中的 ACP CLI 子进程（dispose 内部 abort 全部 run 并清理定时器）
    try {
      const { getAcpRunController } = await import('./coding-dev-acp-run.js')
      getAcpRunController().dispose()
      log.info('[performCleanup] ACP 运行控制器已释放')
    } catch (err) {
      log.warn('[performCleanup] ACP 运行清理失败:', err)
    }

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

    // 最后收一次技能子进程（bash / python / node）。
    //
    // 为什么需要：POSIX 下 `spawnChildInGroup` 用了 `detached: true`，子进程不再
    // 随父进程退出而终止——正常路径由各 runner 自己收拾，这里兜住
    // 「Electron 被强杀 / 技能卡住不响应 abort」时的孤儿。
    try {
      const { killAllTrackedChildren } = await import('./platform/process-kill.js')
      const n = killAllTrackedChildren()
      if (n > 0) log.info(`[performCleanup] 已回收 ${n} 个残留技能子进程`)
    } catch (err) {
      log.warn('[performCleanup] 技能子进程回收失败:', err)
    }

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
