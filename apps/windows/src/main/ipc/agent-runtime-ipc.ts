/**
 * Agent Runtime IPC 注册层
 *
 * 在主进程注册统一的 'agent-runtime:command' 处理器，
 * 并转发 Agent Runtime 事件到渲染进程。
 *
 * 设计依据: .qoder/design/client-agent-runtime/08-前端渲染与IPC通讯.md §3
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { ipcMain, shell, dialog, type BrowserWindow } from 'electron'
import { Cron } from 'croner'
import { BUILT_IN_AGENTS, type AgentDefinition } from '@mtbot/agent-runtime'
import type { AgentRuntimeCommand } from '../../shared/agent-runtime-commands'
import type { AgentRuntimeEvent } from '../../shared/agent-runtime-events'
import { voiceEventBus } from '../voice/voice-event-bus.js'
import { getPetWindowManager } from '../pet/pet-mode-ipc.js'
import { deriveConversationTitleFromUserText } from '../../shared/conversation-title'
import type { AgentRuntimeBridge } from '../agent-runtime/bridge'
import { parseThinkTagsFromRaw } from '../agent-runtime/event-converter'
import { resolveRecordingsDir, resolveScreenshotTempDir } from '../workspace-paths'
import { isAllowedPreviewPath as checkAllowedPreviewPath } from '../preview-path-acl'
import { buildLocalMediaUrl } from '../local-media-protocol'
import { getToolUsage } from '../tool-usage-store'
import { AcpBackendManager } from '../channel/acp-backend-manager'
import { IpcChannelAdapter } from '../channel/adapters/ipc-channel-adapter'
import { StatefulContextStrategy } from '../channel/context-strategy/stateful-strategy'
import type { WeixinSessionBindingManager } from '../channel/weixin-session-binding'
import { handleImageRecognize, handleImageGenerate, handleImageProcess } from './agent-runtime/image-commands'
import { handleMessageDelete, handleMessageEdit } from './agent-runtime/message-commands'
import { createMeasuredHandler } from '../perf/performance-ipc'
import type { PerformanceMonitor } from '../perf/performance-monitor'
import {
  handleCronCreate,
  handleCronList,
  handleCronDelete,
  handleCronUpdate,
  handleCronRun,
  handleCronRuns,
} from './agent-runtime/cron-commands'
import {
  handleSkillConfirmDraft,
  handleSkillRejectDraft,
  handleSkillDeprecate,
} from './agent-runtime/skill-commands'
import {
  handleCodingDevSetBackend,
  handleCodingDevGetBackend,
  handleCodingDevListBackends,
  setAcpBackendManagerGetter,
} from './agent-runtime/coding-dev-commands'
import {
  handleRuntimePing,
  handleRuntimeFeatureFlagsGet,
  handleRuntimeFeatureFlagsSet,
  handleRuntimeEnabled,
  handleRuntimeModelCatalogSet,
} from './agent-runtime/runtime-commands'
import {
  handleConversationCreate,
  handleConversationClose,
  handleConversationList,
  handleConversationDelete,
  handleConversationRename,
  handleConversationPinToggle,
  handleConversationMessages,
  handleConversationContextUsage,
  handleConversationDismissInterrupt,
  handleConversationContinueInterrupted,
  handleConversationFork,
  setConversationDependencies,
} from './agent-runtime/conversation-commands'
import {
  handleStorageStats,
  handleStorageExportJsonl,
  handleStorageClearMalformed,
  handleStorageListBackups,
  handleStorageCreateBackup,
  handleStorageRestoreBackup,
  handleStorageRestoreLatestBackup,
  handleStorageDeleteBackup,
  handleStorageAuditRecent,
} from './agent-runtime/storage-commands'
import {
  handleAgentDefinitionsList,
  handleAgentMemoriesList,
  handleAgentMemoriesDelete,
  handleAgentMemoriesUpdate,
  handleAgentMemoriesClear,
  handleAgentMemoriesExport,
  handleAgentMemoriesProvenance,
  handleAgentMemoriesSearch,
  handleAgentMemoriesArchiveCold,
  handleAgentMemoriesUnarchive,
  handleAgentMemoriesRebuildIndex,
  handleAgentMemoriesStats,
  handleAgentInstanceCreate,
  handleAgentInstanceCreateById,
  handleAgentDefinitionSyncStatus,
  handleAgentDefinitionSyncUserAgents,
  handleAgentDefinitionCacheList,
  handleAgentDefinitionCacheRemove,
  handleAgentDefinitionCacheClearOlder,
  handleAgentDefinitionCacheClearAll,
  handleAgentDefinitionCacheRefresh,
  handleAgentInstancePrompt,
  handleAgentInstanceAbort,
  handleAgentInstanceDestroy,
  handleAgentInstanceList,
  handleAgentInstanceLifecycleSnapshot,
} from './agent-runtime/agent-commands'
import {
  handleWikiInboxList,
  handleWikiInboxRetry,
  handleWikiInboxDiscard,
  handleWikiInboxOrganize,
  handleWikiPageList,
  handleWikiPageGet,
  handleWikiPageUpdate,
  handleWikiPageDelete,
  handleWikiSearch,
  handleWikiSourceGet,
  handleWikiRunsList,
  handleWikiIndexRebuild,
} from './agent-runtime/wiki-commands'
import {
  handleToolsList,
  handleToolsToggle,
  handleMcpStatus,
  handleMcpUpsert,
  handleMcpImport,
  handleMcpRemove,
  handleMcpSetEnabled,
  handleMcpSetSessionEnabled,
  handleMcpSessionDisabled,
  handleSkillSetSessionEnabled,
  handleSkillSessionDisabled,
  handleMcpReconnect,
  handleMcpReadConfigFile,
  handleMcpWriteConfigFile,
} from './agent-runtime/tools-and-mcp-commands'
import {
  handleFilesList,
  handleFilesSearch,
  handleFilesDelete,
  handleFilesOpen,
  handleFilesSaveAs,
  handleFilesReadPreviewContent,
  handleFilesReadPreviewByPath,
  handleFilesImport,
  setFilesDependencies,
} from './agent-runtime/files-commands'
import {
  handleUserSend,
  handleUserSteer,
  handleUserAbort,
  handleUserPermissionRespond,
  handleUserAskUserRespond,
  handleUserAutoApproveSet,
  handleUserCompactContext,
  handleUserAbortCompactContext,
  setUserDependencies,
} from './agent-runtime/user-commands'
import {
  handleSessionPreferredModelSet,
  handleSessionThinkingPrefsSet,
  handleMessageDelete as handleMiscMessageDelete,
  handleMessageEdit as handleMiscMessageEdit,
  handleMessageEditAndResend,
  handleTasksList,
  handleCommandsList,
  handleImageRecognize as handleMiscImageRecognize,
  handleImageGenerate as handleMiscImageGenerate,
  handleImageProcess as handleMiscImageProcess,
  setMiscDependencies,
} from './agent-runtime/misc-commands'
import type { CodingDevBackendId } from '../coding-dev-backends-stub/contracts.js'
import { DEFAULT_CODING_DEV_BACKEND_ID } from '../coding-dev-backends-stub/contracts.js'
import { extractDocumentText } from '../vendor/document-parser.js'
import { getAcpRunController } from '../coding-dev-acp-run.js'

const log = {
  debug: (...args: unknown[]) => console.log('[AgentRuntime:IPC:DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[AgentRuntime:IPC]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime:IPC]', ...args),
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

/**
 * 根据扩展名推断 MIME（与 files:read-preview-by-path 映射保持一致，供 DB 未写入 mime 时补全）
 */
function inferPreviewMimeFromFileName(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase()
  const mimeMap: Record<string, string> = {
    // ── 文档 ──
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint',
    // ── 代码 ──
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.cjs': 'application/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.jsx': 'application/javascript',
    '.json': 'application/json',
    '.json5': 'application/json',
    '.py': 'text/x-python',
    '.sh': 'text/x-sh',
    '.bash': 'text/x-sh',
    '.zsh': 'text/x-sh',
    '.java': 'text/x-java',
    '.kt': 'text/x-kotlin',
    '.kts': 'text/x-kotlin',
    '.go': 'text/x-go',
    '.rs': 'text/x-rust',
    '.cpp': 'text/x-c++src',
    '.cc': 'text/x-c++src',
    '.cxx': 'text/x-c++src',
    '.c': 'text/x-csrc',
    '.h': 'text/x-chdr',
    '.hpp': 'text/x-c++hdr',
    '.cs': 'text/x-csharp',
    '.rb': 'text/x-ruby',
    '.php': 'text/x-php',
    '.swift': 'text/x-swift',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.toml': 'text/x-toml',
    '.ini': 'text/plain',
    '.env': 'text/plain',
    '.sql': 'text/x-sql',
    '.graphql': 'text/x-graphql',
    '.gql': 'text/x-graphql',
    '.vue': 'text/x-vue',
    '.svelte': 'text/x-svelte',
    '.dart': 'text/x-dart',
    '.lua': 'text/x-lua',
    '.r': 'text/x-r',
    '.scala': 'text/x-scala',
    '.clj': 'text/x-clojure',
    '.ex': 'text/x-elixir',
    '.exs': 'text/x-elixir',
    '.hs': 'text/x-haskell',
    '.tf': 'text/x-terraform',
    '.proto': 'text/x-protobuf',
    '.dockerfile': 'text/x-dockerfile',
    // ── 图片 ──
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.avif': 'image/avif',
    // ── 音频 ──
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.opus': 'audio/opus',
    '.weba': 'audio/webm',
    // ── 视频 ──
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4',
    '.ogv': 'video/ogg',
    '.3gp': 'video/3gpp',
    // ── 字体 ──
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
  }
  return mimeMap[ext] ?? null
}

/**
 * 判断是否应以 UTF-8 文本读取预览内容；否则按二进制读入并 base64 下发给渲染进程
 */
function shouldReadPreviewAsUtf8(effectiveMime: string | null, fileName: string): boolean {
  const m = effectiveMime ?? ''
  if (m.startsWith('text/')) return true
  if (
    m === 'application/json' ||
    m === 'application/javascript' ||
    m === 'application/xml' ||
    m === 'text/xml'
  ) {
    return true
  }
  // 音频、视频、图片、字体 → 二进制 base64
  if (m.startsWith('audio/') || m.startsWith('video/') || m.startsWith('image/') || m.startsWith('font/')) {
    return false
  }
  const ext = path.extname(fileName).toLowerCase()
  const textExts = new Set([
    '.txt', '.md', '.markdown', '.json', '.json5', '.csv', '.xml', '.html', '.htm', '.css',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.sh', '.bash', '.zsh', '.py', '.yaml', '.yml', '.toml', '.ini', '.env', '.log',
    '.java', '.kt', '.kts', '.go', '.rs', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
    '.cs', '.rb', '.php', '.swift', '.dart', '.lua', '.r', '.scala', '.clj', '.ex', '.exs',
    '.hs', '.tf', '.proto', '.sql', '.graphql', '.gql', '.vue', '.svelte',
  ])
  if (textExts.has(ext)) return true
  return false
}

/**
 * 展开以 ~ 开头的路径为当前用户主目录下的绝对路径。
 */
function expandTildePath(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('~')) {
    return path.resolve(trimmed.replace(/^~(?=$|[/\\])/, os.homedir()))
  }
  return trimmed
}

/**
 * 解析后的绝对路径须落在 Agent workspace（cwd）内，防止路径穿越
 */
function isResolvedPathInsideWorkspace(resolvedAbs: string, resolvedCwd: string): boolean {
  return resolvedAbs.startsWith(resolvedCwd + path.sep) || resolvedAbs === resolvedCwd
}

/**
 * 判断预览路径是否在允许范围内：工作区 / recordings / 截图临时目录。
 */
function isAllowedPreviewPath(resolvedAbs: string, resolvedCwd: string): boolean {
  const screenshotDir = path.resolve(resolveScreenshotTempDir())
  const recordingsDir = path.resolve(resolveRecordingsDir())
  return checkAllowedPreviewPath(resolvedAbs, {
    workspaceCwd: resolvedCwd,
    recordingsDir,
    screenshotDir,
  })
}

/**
 * 跨渠道通用基础斜杠命令列表
 *
 * 这是所有渠道（WeChat、Windows 客户端等）共有的命令元数据，
 * 也是客户端 slash-commands.ts 的权威来源。
 * 客户端特有命令（backend-switching 等）由渲染层追加。
 *
 * 与服务端 src/auto-reply/commands-registry.data.ts 中对应命令保持一致。
 */
const BASE_SLASH_COMMANDS = [
  // ── 信息查询 ──────────────────────────────────────────────────
  {
    key: 'help',
    name: '/help',
    aliases: [],
    description: '显示所有可用命令',
    usage: '/help',
    category: 'info',
    acceptsArgs: false,
  },
  {
    key: 'status',
    name: '/status',
    aliases: [],
    description: '查看当前 Agent 状态（上下文用量、模型等）',
    usage: '/status',
    category: 'info',
    acceptsArgs: false,
  },
  // ── 会话管理 ──────────────────────────────────────────────────
  {
    key: 'clear',
    name: '/clear',
    aliases: [],
    description: '清空当前会话的所有消息（保留会话）',
    usage: '/clear',
    category: 'session',
    acceptsArgs: false,
  },
  {
    key: 'new',
    name: '/new',
    aliases: ['/n'],
    description: '新建一个空白会话',
    usage: '/new',
    category: 'session',
    acceptsArgs: false,
  },
  {
    key: 'resume',
    name: '/resume',
    aliases: ['/r'],
    description: '查看最近 10 个会话，可恢复对话',
    usage: '/resume [编号]',
    category: 'session',
    acceptsArgs: true,
  },
  {
    key: 'compact',
    name: '/compact',
    aliases: ['/compress'],
    description: '压缩对话上下文，删除较早的消息以释放 token',
    usage: '/compact [自定义压缩指令]',
    category: 'session',
    acceptsArgs: true,
  },
  // ── 记忆管理 ──────────────────────────────────────────────────
  {
    key: 'memory',
    name: '/memory',
    aliases: [],
    description: '查看当前 Agent 的记忆列表，支持 clear 子命令',
    usage: '/memory [clear]',
    category: 'memory',
    acceptsArgs: true,
  },
  // ── 设置选项 ──────────────────────────────────────────────────
  {
    key: 'think',
    name: '/think',
    aliases: ['/thinking', '/t'],
    description: '设置思考级别（off/low/medium/high）',
    usage: '/think <off|low|medium|high>',
    category: 'settings',
    acceptsArgs: true,
  },
] as const

/** 客户端侧固定 accountId：user-global 后端选择写在这个 key 下 */
export const LOCAL_USER_ID = 'local-user'

/**
 * 当前挂载到 IPC 的 Bridge（在 initAgentRuntime 创建实例后立即赋值，早于 initialize 完成）
 * 解决渲染进程在应用初始化完成前就调用 agent-runtime:command 导致的「No handler registered」竞态。
 */
let ipcBridgeRef: AgentRuntimeBridge | null = null

/** 供控制口读取 bridge；ipcBridgeRef 保持私有，不允许外部改写 */
export function getAgentRuntimeBridge(): AgentRuntimeBridge | null {
  return ipcBridgeRef
}

let weixinBindingManagerRef: WeixinSessionBindingManager | null = null
let ipcMainWindowRef: BrowserWindow | null = null
/** 音频文件 ASR 转录回调（由 voice-ipc 注入） */
let audioTranscribeCallback: ((base64: string, mimeType: string) => Promise<string>) | null = null

/**
 * 注入语音 ASR 转录能力（由主进程 voice 模块调用）
 */
export function setAudioTranscribeCallback(cb: ((base64: string, mimeType: string) => Promise<string>) | null): void {
  audioTranscribeCallback = cb
}

/**
 * Provider 配置变更后使会话 Agent 实例失效，下次发消息按新配置重建（走 direct）。
 * 不关闭数据库，仅销毁内存中的实例与 session 映射。
 */
export function invalidateAgentInstancesForProviderChange(): void {
  if (!ipcBridgeRef) {
    log.warn('[invalidateAgentInstancesForProviderChange] bridge 未就绪，跳过')
    return
  }
  const instances = ipcBridgeRef.getInstances()
  const deferredIds = new Set<string>()
  for (const inst of instances) {
    try {
      // 运行中的实例只做标记：立即销毁会掐断正在执行的 Agent 回路，
      // 工具结果回不到模型且不报错，表现为对话永久卡死。
      if (ipcBridgeRef.invalidateInstance(inst.id) === 'deferred') {
        deferredIds.add(inst.id)
        continue
      }
      untrackInstanceRuns(inst.id)
    } catch (err) {
      log.warn(`[invalidateAgentInstancesForProviderChange] 失效 ${inst.id} 失败:`, err)
    }
  }
  // 推迟销毁的实例仍在跑，保留其 session 映射，等本轮结束后由 bridge.prompt 收尾销毁
  for (const [sessionKey, instanceId] of sessionToInstance) {
    if (!deferredIds.has(instanceId)) sessionToInstance.delete(sessionKey)
  }
  log.info(
    `[invalidateAgentInstancesForProviderChange] 失效 ${instances.length} 个实例，其中 ${deferredIds.size} 个运行中已推迟销毁`,
  )
}

/**
 * 将 Bridge 实例挂到 IPC（或卸载时传 null）
 */
export function setAgentRuntimeBridgeForIpc(bridge: AgentRuntimeBridge | null): void {
  ipcBridgeRef = bridge
}

/**
 * 注入微信绑定管理器，用于对话列表的渠道标记（wechat / default）
 */
export function setWeixinBindingManagerForIpc(mgr: WeixinSessionBindingManager | null): void {
  weixinBindingManagerRef = mgr
}

/**
 * 根据 instanceId 反查 sessionKey（供 SkillEvolutionEngine inject_message 使用）
 */
export function getSessionKeyForInstance(instanceId: string): string | undefined {
  for (const [sessionKey, iid] of sessionToInstance.entries()) {
    if (iid === instanceId) return sessionKey
  }
  return undefined
}

/**
 * 设置主窗口引用，供 ACP 路径推送事件使用
 */
export function setIpcMainWindow(win: BrowserWindow | null): void {
  ipcMainWindowRef = win
}

/**
 * 注册 agent-runtime:command IPC 处理器
 *
 * 调用时机：应早于渲染进程加载。bridge 尚未挂接时 handler 会返回 NOT_READY，
 * 由渲染进程既有重试逻辑等待 runtime ready；这样避免 Electron 抛出
 * "No handler registered for 'agent-runtime:command'"。
 */
let agentRuntimeCommandIpcInstalled = false

export function installAgentRuntimeCommandIpc(performanceMonitor?: PerformanceMonitor): void {
  if (agentRuntimeCommandIpcInstalled) {
    log.info('agent-runtime:command 已注册，跳过重复 install')
    return
  }
  agentRuntimeCommandIpcInstalled = true

  // 初始化 coding-dev-commands 的 AcpBackendManager getter
  setAcpBackendManagerGetter(getAcpBackendManager)

  // 初始化 conversation-commands 的依赖
  setConversationDependencies({
    sessionToInstance,
    runIdToInstance,
    instanceToRunIds,
    weixinBindingManagerRef,
    trackRunInstance,
    untrackInstanceRuns,
    getIpcChannelAdapter,
    getInstanceForSession,
  })

  // 初始化 files-commands 的依赖
  setFilesDependencies({
    inferPreviewMimeFromFileName,
    shouldReadPreviewAsUtf8,
    expandTildePath,
    isAllowedPreviewPath,
    isResolvedPathInsideWorkspace,
    audioTranscribeCallback,
  })

  // 初始化 user-commands 的依赖
  setUserDependencies({
    ipcMainWindowRef,
    sessionToInstance,
    runIdToInstance,
    trackRunInstance,
    untrackRun,
    getInstanceForSession,
    getIpcChannelAdapter,
    getAcpBackendManager,
    getAcpRunController,
    pushEvent,
    resolveAgentIdForMemories: (bridge, sessionKey, explicitAgentId) => {
      if (explicitAgentId) return explicitAgentId
      if (sessionKey) {
        const fromConv = bridge.conversationRepo.getAgentParticipantId(sessionKey)
        if (fromConv) return fromConv
      }
      return 'assistant'
    },
  })

  // 初始化 misc-commands 的依赖
  setMiscDependencies({
    getInstanceForSession,
    getIpcChannelAdapter,
    handleMessageDelete,
    handleMessageEdit,
    handleImageRecognize,
    handleImageGenerate,
    handleImageProcess,
  })

  const commandHandler = async (
    _event: Electron.IpcMainInvokeEvent,
    command: AgentRuntimeCommand,
  ): Promise<unknown> => {
    if (!ipcBridgeRef) {
      // 理论上不应该到达这里（因为 installAgentRuntimeCommandIpc 在 setAgentRuntimeBridgeForIpc 之后调用）
      log.warn(`[command] bridge 未就绪（不应发生）: ${command?.type}`)
      return { ok: false, error: 'NOT_READY' }
    }
    // 高频/轮询命令降级为静默，避免日志刷屏
    const QUIET_COMMANDS = new Set([
      'agentInstance:lifecycleSnapshot',
      'runtime:modelCatalog:set',
      'conversation:list',
      'agentDefinition:syncStatus',
    ])
    if (!QUIET_COMMANDS.has(command?.type)) {
      log.info(`[command] received: ${command?.type}`)
    }
    try {
      return await handleCommand(ipcBridgeRef, command)
    } catch (err) {
      log.error(`[command] error handling ${command?.type}:`, err)
      throw err
    }
  }
  ipcMain.handle(
    'agent-runtime:command',
    performanceMonitor
      ? createMeasuredHandler('agent-runtime:command', commandHandler, performanceMonitor)
      : commandHandler,
  )
  log.info('agent-runtime:command 已提前注册（installAgentRuntimeCommandIpc）')
}

/**
 * 向渲染进程推送 Agent Runtime 事件
 * 所有事件统一通过 'agent-runtime:event' 通道传输
 */
function pushEvent(win: BrowserWindow, event: AgentRuntimeEvent): void {
  if (!win.isDestroyed()) {
    try {
      win.webContents.send('agent-runtime:event', event)
    } catch (e) {
      log.error(`[pushEvent] IPC 发送失败 type=${(event as any)?.type}: ${(e as Error).message}`)
    }
  }
  // 宠物模式独立窗口需同步 Agent 流式输出（字幕/状态）
  const petWin = getPetWindowManager()?.getPetBrowserWindow()
  if (petWin && !petWin.isDestroyed() && petWin !== win) {
    try {
      petWin.webContents.send('agent-runtime:event', event)
    } catch (e) {
      log.error(`[pushEvent] 宠物窗口 IPC 发送失败 type=${(event as any)?.type}: ${(e as Error).message}`)
    }
  }
  // 同步通知语音通话服务（如通话进行中需要 Agent 事件）
  try {
    voiceEventBus.emit('agent-event', event)
  } catch (e) {
    log.error(`[pushEvent] voiceEventBus 回调异常 type=${(event as any)?.type}: ${(e as Error).message}`)
  }
}

/**
 * 供渠道适配器（飞书/企微/微信）推送 Agent 事件到渲染进程。
 * 渠道消息与客户端自发消息共用同一套事件通道，客户端才能实时看到渠道会话的运行过程。
 */
export function pushAgentRuntimeEvent(event: AgentRuntimeEvent): void {
  const win = ipcMainWindowRef
  if (win && !win.isDestroyed()) pushEvent(win, event)
}

/**
 * 供语音通话服务调用：将 ASR 识别文本作为用户消息发送给 Agent
 * @param audioWavBase64 - 原始录音 WAV 的 base64，用于 UI 回放（可选）
 */
export async function submitVoiceTranscript(sessionKey: string, content: string, audioWavBase64?: string): Promise<void> {
  if (!ipcBridgeRef) {
    log.warn('[submitVoiceTranscript] bridge 尚未就绪，丢弃语音识别结果')
    return
  }
  log.info(`[submitVoiceTranscript] sessionKey=${sessionKey} content="${content.slice(0, 50)}"`)

  // 将语音识别文本推送为用户消息，让聊天界面显示用户说了什么
  const msgId = `voice-usr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const win = ipcMainWindowRef
  if (win && !win.isDestroyed()) {
    pushEvent(win, {
      type: 'conversation:message:new',
      sessionKey,
      message: {
        id: msgId,
        role: 'user',
        content: [{ type: 'text', text: content }],
        timestamp: Date.now(),
        isVoice: true,
        ...(audioWavBase64 ? { audioWavBase64 } : {}),
      },
    })
  }

  await handleCommand(ipcBridgeRef, {
    type: 'user:send',
    sessionKey,
    content,
    msgId,
    isVoice: true,
    ...(audioWavBase64 ? { audioWavBase64 } : {}),
  } as AgentRuntimeCommand)
}

/**
 * 注册所有 Agent Runtime IPC 处理器（新协议）
 *
 * 单一 'agent-runtime:command' 通道处理所有命令。
 * 使用 exhaustive switch 确保类型安全。
 *
 * @param mainWindow - Electron 主窗口
 * @param bridge - AgentRuntimeBridge 实例
 * @returns 清理函数，用于注销 IPC 处理器
 */
export function registerAgentRuntimeIPC(
  _mainWindow: BrowserWindow,
  bridge: AgentRuntimeBridge,
): () => void {
  setAgentRuntimeBridgeForIpc(bridge)
  ipcMainWindowRef = _mainWindow
  log.info('Agent Runtime Bridge 已挂接到 IPC（agent-runtime:command）')

  return () => {
    setAgentRuntimeBridgeForIpc(null)
    sessionToInstance.clear()
    runIdToInstance.clear()
    instanceToRunIds.clear()
    getAcpRunController().dispose()
    log.info('Agent Runtime Bridge 已从 IPC 卸载，session maps cleared')
  }
}

/**
 * 处理单个命令（IPC 与本机控制口共用）
 *
 * TODO: 继续按命令前缀拆分到 agent-runtime/ 子目录（参考 docs/plans/大文件重构分析处理/README.md P0-05）
 * 已完成：
 *   - image:* (3) → image-commands.ts
 *   - message:delete/edit (2) → message-commands.ts
 * 待拆分：
 *   - conversation:* (11) → session-commands.ts
 *   - storage:* (9) → memory-commands.ts
 *   - user:* (8) → user-commands.ts
 *   - mcp:* (8) → mcp-commands.ts
 *   - files:* (8) → files-commands.ts
 *   - agentDefinition:* (7) → agent-commands.ts
 *   - agentInstance:* (7) → agent-commands.ts
 *   - agent:* (7) → agent-commands.ts
 *   - cron:* (6) → cron-commands.ts
 *   - skill:* (3) → skill-commands.ts
 *   - codingDev:* (3) → skill-commands.ts
 *   - runtime:* (5) → system-commands.ts
 *   - tools:* (2), commands:* (1), tasks:* (1) → system-commands.ts
 */
export async function handleCommand(
  bridge: AgentRuntimeBridge,
  command: AgentRuntimeCommand,
): Promise<unknown> {
  switch (command.type) {
      // ---- 用户交互 ----
      case 'user:send':
        return handleUserSend(bridge, command)

      case 'user:steer':
        handleUserSteer(bridge, command)
        return undefined

      case 'user:abort':
        handleUserAbort(bridge, command)
        return undefined

      // ---- 权限响应 ----
      case 'user:permission:respond':
        handleUserPermissionRespond(bridge, command)
        return undefined

      // ---- ask_user_question 回答 ----
      case 'user:ask-user:respond':
        handleUserAskUserRespond(bridge, command)
        return undefined

      // ---- 自动审批开关同步（渠道据此判断是否值得推审批消息）----
      case 'user:auto-approve:set':
        handleUserAutoApproveSet(bridge, command)
        return undefined

      case 'runtime:modelCatalog:set':
        return handleRuntimeModelCatalogSet(bridge, command)

      case 'session:preferredModel:set':
        return handleSessionPreferredModelSet(bridge, command)

      case 'session:thinkingPrefs:set':
        return handleSessionThinkingPrefsSet(bridge, command)

      // ---- 会话管理 ----
      case 'conversation:create':
        return handleConversationCreate(bridge, command)

      case 'conversation:close':
        return handleConversationClose(bridge, command)

      case 'conversation:list':
        return handleConversationList(bridge)

      case 'conversation:delete':
        return handleConversationDelete(bridge, command)

      case 'conversation:rename':
        return handleConversationRename(bridge, command)

      case 'conversation:pin-toggle':
        return handleConversationPinToggle(bridge, command)

      case 'conversation:messages':
        return handleConversationMessages(bridge, command)

      case 'conversation:context-usage':
        return handleConversationContextUsage(bridge, command)

      case 'conversation:dismiss-interrupt':
        return handleConversationDismissInterrupt(bridge, command)

      case 'conversation:continue-interrupted':
        return handleConversationContinueInterrupted(bridge, command)

      case 'cron:create':
        return handleCronCreate(bridge, command)

      case 'cron:list':
        return handleCronList(bridge, command.includeDisabled ?? true)

      case 'cron:delete':
        return handleCronDelete(bridge, command.id)

      case 'cron:update':
        return handleCronUpdate(bridge, command.id, command.patch)

      case 'cron:run':
        return handleCronRun(bridge, command.id)

      case 'cron:runs':
        return handleCronRuns(bridge, command.id, command.limit ?? 50)

      // ---- Agent 定义查询 ----
      case 'agent:definitions:list':
        return handleAgentDefinitionsList()

      case 'agent:memories:list':
        return handleAgentMemoriesList(bridge, command)

      case 'agent:memories:delete':
        return handleAgentMemoriesDelete(bridge, command)

      case 'agent:memories:update':
        return handleAgentMemoriesUpdate(bridge, command)

      case 'agent:memories:clear':
        return handleAgentMemoriesClear(bridge, command)

      case 'agent:memories:export':
        return handleAgentMemoriesExport(bridge, command)

      case 'agent:memories:provenance':
        return handleAgentMemoriesProvenance(bridge, command)

      case 'agent:memories:search':
        return handleAgentMemoriesSearch(bridge, command)

      case 'agent:memories:archiveCold':
        return handleAgentMemoriesArchiveCold(bridge, command)

      case 'agent:memories:unarchive':
        return handleAgentMemoriesUnarchive(bridge, command)

      case 'agent:memories:rebuildIndex':
        return handleAgentMemoriesRebuildIndex(bridge)

      case 'agent:memories:stats':
        return handleAgentMemoriesStats(bridge, command)

      // ---- Wiki 知识库（P0） ----
      case 'wiki:inbox:list':
        return handleWikiInboxList(bridge, command)

      case 'wiki:inbox:retry':
        return handleWikiInboxRetry(bridge, command)

      case 'wiki:inbox:discard':
        return handleWikiInboxDiscard(bridge, command)

      case 'wiki:inbox:organize':
        return handleWikiInboxOrganize(bridge, command)

      case 'wiki:page:list':
        return handleWikiPageList(bridge, command)

      case 'wiki:page:get':
        return handleWikiPageGet(bridge, command)

      case 'wiki:page:update':
        return handleWikiPageUpdate(bridge, command)

      case 'wiki:page:delete':
        return handleWikiPageDelete(bridge, command)

      case 'wiki:search':
        return handleWikiSearch(bridge, command)

      case 'wiki:source:get':
        return handleWikiSourceGet(bridge, command)

      case 'wiki:runs:list':
        return handleWikiRunsList(bridge, command)

      case 'wiki:index:rebuild':
        return handleWikiIndexRebuild(bridge)

      // ---- 工具管理 ----
      case 'tools:list':
        return handleToolsList(bridge)

      case 'tools:toggle':
        return handleToolsToggle(bridge, command)

      case 'mcp:status':
        return handleMcpStatus(bridge)

      case 'mcp:upsert':
        return handleMcpUpsert(bridge, command)

      case 'mcp:import':
        return handleMcpImport(bridge, command)

      case 'mcp:remove':
        return handleMcpRemove(bridge, command)

      case 'mcp:setEnabled':
        return handleMcpSetEnabled(bridge, command)

      case 'mcp:setSessionEnabled':
        return handleMcpSetSessionEnabled(bridge, command)

      case 'mcp:sessionDisabled':
        return handleMcpSessionDisabled(bridge, command)

      case 'mcp:reconnect':
        return handleMcpReconnect(bridge, command)

      case 'mcp:readConfigFile':
        return handleMcpReadConfigFile(bridge)

      case 'mcp:writeConfigFile':
        return handleMcpWriteConfigFile(bridge, command)

      // ---- 主进程桥接（原 agent-runtime:* 独立通道）----
      case 'runtime:ping':
        return handleRuntimePing()

      case 'runtime:featureFlags:get':
        return handleRuntimeFeatureFlagsGet(bridge)

      case 'runtime:featureFlags:set':
        return handleRuntimeFeatureFlagsSet(bridge, command)

      case 'runtime:enabled':
        return handleRuntimeEnabled(bridge)

      case 'agentInstance:create':
        return handleAgentInstanceCreate(bridge, command)

      case 'agentInstance:createById':
        return handleAgentInstanceCreateById(bridge, command)

      case 'agentDefinition:syncStatus':
        return handleAgentDefinitionSyncStatus(bridge)

      case 'agentDefinition:syncUserAgents':
        return handleAgentDefinitionSyncUserAgents(bridge)

      case 'agentDefinition:cacheList':
        return handleAgentDefinitionCacheList(bridge)

      case 'agentDefinition:cacheRemove':
        return handleAgentDefinitionCacheRemove(bridge, command)

      case 'agentDefinition:cacheClearOlder':
        return handleAgentDefinitionCacheClearOlder(bridge, command)

      case 'agentDefinition:cacheClearAll':
        return handleAgentDefinitionCacheClearAll(bridge)

      case 'agentDefinition:cacheRefresh':
        return handleAgentDefinitionCacheRefresh(bridge, command)

      case 'agentInstance:prompt':
        return handleAgentInstancePrompt(bridge, command)

      case 'agentInstance:abort':
        return handleAgentInstanceAbort(bridge, command)

      case 'agentInstance:destroy':
        return handleAgentInstanceDestroy(bridge, command)

      case 'agentInstance:list':
        return handleAgentInstanceList(bridge)

      case 'agentInstance:lifecycleSnapshot':
        return handleAgentInstanceLifecycleSnapshot(bridge, command)

      case 'storage:stats':
        return handleStorageStats(bridge)

      case 'storage:exportJsonl':
        return handleStorageExportJsonl(bridge)

      case 'storage:clearMalformed':
        return handleStorageClearMalformed(bridge)

      case 'storage:listBackups':
        return handleStorageListBackups(bridge)

      case 'storage:createBackup':
        return handleStorageCreateBackup(bridge)

      case 'storage:restoreBackup':
        return handleStorageRestoreBackup(bridge, command)

      case 'storage:restoreLatestBackup':
        return handleStorageRestoreLatestBackup(bridge)

      case 'storage:deleteBackup':
        return handleStorageDeleteBackup(bridge, command)

      case 'storage:auditRecent':
        return handleStorageAuditRecent(bridge, command)

      case 'message:delete':
        return handleMiscMessageDelete(bridge, command)

      case 'message:edit':
        return handleMiscMessageEdit(bridge, command)

      case 'conversation:fork':
        return handleConversationFork(bridge, command)

      case 'message:edit-and-resend':
        return handleMessageEditAndResend(bridge, command)

      case 'user:compact-context':
        return handleUserCompactContext(bridge, command)

      case 'user:abort-compact-context':
        return handleUserAbortCompactContext(bridge, command)

      // ---- 文件管理 ----
      case 'files:list':
        return handleFilesList(bridge, command)

      case 'tasks:list':
        return handleTasksList(bridge, command)

      case 'files:search':
        return handleFilesSearch(bridge, command)

      case 'files:delete':
        return handleFilesDelete(bridge, command)

      case 'files:open':
        return handleFilesOpen(bridge, command)

      case 'files:save-as':
        return handleFilesSaveAs(bridge, command)

      case 'files:read-preview-content':
        return handleFilesReadPreviewContent(bridge, command)

      // ---- 命令注册表 ----
      case 'commands:list':
        return handleCommandsList()

      case 'files:read-preview-by-path':
        return handleFilesReadPreviewByPath(bridge, command)

      case 'files:import':
        return handleFilesImport(bridge, command)

      // ---- ACP 多后端管理 ----
      case 'codingDev:setBackend':
        return handleCodingDevSetBackend(command)

      case 'codingDev:getBackend':
        return handleCodingDevGetBackend()

      case 'codingDev:listBackends':
        return handleCodingDevListBackends()

      // ---- 图片处理（识别 / 美化 / 等，按 operation 扩展） ----
      case 'image:recognize':
        return handleMiscImageRecognize(bridge, command)

      case 'image:generate':
        return handleMiscImageGenerate(bridge, command)

      case 'image:process':
        return handleMiscImageProcess(bridge, command)

      // ---- 技能自进化 ----
      case 'skill:confirm_draft':
        return handleSkillConfirmDraft(bridge, command)

      case 'skill:reject_draft':
        return handleSkillRejectDraft(bridge, command)

      case 'skill:deprecate':
        return handleSkillDeprecate(bridge, command)

      // ---- 会话级技能开关（技能中心的启用/禁用是全局总开关） ----
      case 'skill:setSessionEnabled':
        return handleSkillSetSessionEnabled(bridge, command)

      case 'skill:sessionDisabled':
        return handleSkillSessionDisabled(bridge, command)

      default: {
        const _exhaustive: never = command
        throw new Error(`Unknown command type: ${(_exhaustive as AgentRuntimeCommand).type}`)
      }
    }
  }

// ============================================================
// 会话管理
// ============================================================

/**
 * sessionKey → instanceId（Agent 实例）
 * 注意：sessionKey 直接使用 conversationId，重启后不变，历史对话可恢复
 */
const sessionToInstance = new Map<string, string>()
const runIdToInstance = new Map<string, string>()
const instanceToRunIds = new Map<string, Set<string>>()

/**
 * 建立 runId 与实例的双向索引，供精确中止时定位实例。
 */
function trackRunInstance(runId: string, instanceId: string): void {
  runIdToInstance.set(runId, instanceId)
  const runIds = instanceToRunIds.get(instanceId) ?? new Set<string>()
  runIds.add(runId)
  instanceToRunIds.set(instanceId, runIds)
}

/**
 * 清理某个 runId 的双向索引。
 */
function untrackRun(runId: string): void {
  const instanceId = runIdToInstance.get(runId)
  if (!instanceId) return
  runIdToInstance.delete(runId)
  const runIds = instanceToRunIds.get(instanceId)
  if (!runIds) return
  runIds.delete(runId)
  if (runIds.size === 0) {
    instanceToRunIds.delete(instanceId)
  }
}

/**
 * 清理某个实例绑定的全部 run 索引（会话关闭/实例重建时调用）。
 */
function untrackInstanceRuns(instanceId: string): void {
  const runIds = instanceToRunIds.get(instanceId)
  if (!runIds) return
  for (const runId of runIds) {
    runIdToInstance.delete(runId)
  }
  instanceToRunIds.delete(instanceId)
}

// ============================================================
// Cron 函数已移至 agent-runtime/cron-commands.ts
// ============================================================

// ============================================================
// Conversation 函数已移至 agent-runtime/conversation-commands.ts
// ============================================================

// ============================================================
// ACP 后端管理器单例
// ============================================================

let _acpBackendManager: AcpBackendManager | null = null

export function getAcpBackendManager(): AcpBackendManager {
  if (!_acpBackendManager) {
    _acpBackendManager = new AcpBackendManager()
  }
  return _acpBackendManager
}

// ============================================================
// IPC 通道适配器单例
// ============================================================

let _ipcChannelAdapter: IpcChannelAdapter | null = null

function getIpcChannelAdapter(bridge: AgentRuntimeBridge): IpcChannelAdapter {
  if (!_ipcChannelAdapter) {
    _ipcChannelAdapter = new IpcChannelAdapter(bridge, getAcpBackendManager(), () => null)
  }
  return _ipcChannelAdapter
}

/**
 * 将字符串解析为严格毫秒数。
 */
function parseStrictMs(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

/**
 * 简化版 at 时间表达式解析（支持 ms/秒级/ISO）。
 */
function parseAtScheduleExprLite(rawExpr: string): number | undefined {
  const direct = parseStrictMs(rawExpr)
  if (direct !== undefined) {
    return direct > 0 && direct < 1_000_000_000_000 ? direct * 1000 : direct
  }
  const iso = Date.parse(rawExpr)
  if (Number.isFinite(iso)) return iso
  return undefined
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 获取 sessionKey 对应的 Agent 实例
 *
 * 如果 sessionKey 没有实例但提供了 agentId，不再自动创建。
 * 调用方应该先 conversation:create。
 */
async function getInstanceForSession(
  bridge: AgentRuntimeBridge,
  sessionKey: string,
  agentId?: string,
): Promise<string | undefined> {
  // 注意：此函数有两处 createInstanceById + sessionToInstance.set 调用，但不存在双重创建竞态。
  // JS 运行时为单线程事件循环：每次 await 只会让出控制权给事件循环，
  // 而所有调用方（handleCommand）均在同一 IPC 任务中串行执行，
  // 不存在两个不同的 macrotask 同时进入此函数处理同一 sessionKey 的场景。
  const instanceId = sessionToInstance.get(sessionKey)

  if (!instanceId) {
    // 重启后 sessionToInstance 为空，尝试从 DB 恢复 Agent 实例
    const effectiveAgentId = agentId ?? bridge.conversationRepo.getAgentParticipantId(sessionKey) ?? undefined
    log.info(`[getInstanceForSession] no instance in map, restoring for session ${sessionKey}, agentId=${effectiveAgentId ?? '(default)'}`)
    try {
      const newInstanceId = effectiveAgentId
        ? await bridge.createInstanceById(effectiveAgentId, sessionKey, sessionKey)
        : await bridge.createInstance(undefined, sessionKey, sessionKey)
      sessionToInstance.set(sessionKey, newInstanceId)
      return newInstanceId
    } catch (err) {
      log.error(`[getInstanceForSession] failed to restore instance for session ${sessionKey}:`, err)
      return undefined
    }
  }

  // 上轮运行期间发生过配置/工具变更的实例，在复用前先销毁，走下方重建分支
  bridge.consumePendingInvalidation(instanceId)

  // 验证实例还存在
  const instances = bridge.getInstances()
  if (instances.some((i) => i.id === instanceId)) {
    return instanceId
  }

  // 实例已不存在（可能被销毁了），重新创建
  // sessionKey === conversationId
  log.info(`[getInstanceForSession] instance ${instanceId} no longer exists, recreating for session ${sessionKey}`)
  untrackInstanceRuns(instanceId)
  const effectiveAgentId = agentId ?? bridge.conversationRepo.getAgentParticipantId(sessionKey) ?? undefined
  const newInstanceId = effectiveAgentId
    ? await bridge.createInstanceById(effectiveAgentId, sessionKey, sessionKey)
    : await bridge.createInstance(undefined, sessionKey, sessionKey)
  sessionToInstance.set(sessionKey, newInstanceId)
  return newInstanceId
}
