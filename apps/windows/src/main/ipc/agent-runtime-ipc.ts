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
import { resolveWindowsClientDataRoot } from '../client-data-root'
import { getToolUsage } from '../tool-usage-store'
import { AcpBackendManager } from '../channel/acp-backend-manager'
import { IpcChannelAdapter } from '../channel/adapters/ipc-channel-adapter'
import { StatefulContextStrategy } from '../channel/context-strategy/stateful-strategy'
import type { WeixinSessionBindingManager } from '../channel/weixin-session-binding'
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
 * 判断预览路径是否在允许范围内：Agent 工作区或 Lumii 截图临时目录（app_screenshot 缩略图）。
 */
function isAllowedPreviewPath(resolvedAbs: string, resolvedCwd: string): boolean {
  if (isResolvedPathInsideWorkspace(resolvedAbs, resolvedCwd)) return true
  const screenshotDir = path.resolve(path.join(resolveWindowsClientDataRoot(), 'temp', 'screenshots'))
  return resolvedAbs.startsWith(screenshotDir + path.sep)
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
  log.info(`[invalidateAgentInstancesForProviderChange] 销毁 ${instances.length} 个实例`)
  for (const inst of instances) {
    try {
      untrackInstanceRuns(inst.id)
      ipcBridgeRef.destroy(inst.id)
    } catch (err) {
      log.warn(`[invalidateAgentInstancesForProviderChange] destroy ${inst.id} 失败:`, err)
    }
  }
  sessionToInstance.clear()
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

export function installAgentRuntimeCommandIpc(): void {
  if (agentRuntimeCommandIpcInstalled) {
    log.info('agent-runtime:command 已注册，跳过重复 install')
    return
  }
  agentRuntimeCommandIpcInstalled = true
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
  ipcMain.handle('agent-runtime:command', commandHandler)
  log.info('agent-runtime:command 已提前注册（installAgentRuntimeCommandIpc）')
}

/**
 * 解析记忆列表/清空所用的 Agent 定义 ID
 */
/**
 * 把 MCP 写操作包成 { success, error }
 *
 * 配置无效、名称冲突、命令启动失败都是用户可修的日常错误，
 * 不该抛到 IPC 边界外变成 renderer 的未捕获 rejection。
 */
async function toMcpResult(action: () => Promise<void>): Promise<{ success: boolean; error?: string }> {
  try {
    await action()
    return { success: true }
  } catch (err) {
    const error = (err as Error).message
    log.error('[mcp] 操作失败:', error)
    return { success: false, error }
  }
}

function resolveAgentIdForMemories(
  bridge: AgentRuntimeBridge,
  sessionKey?: string,
  explicitAgentId?: string,
): string {
  if (explicitAgentId) return explicitAgentId
  if (sessionKey) {
    const fromConv = bridge.conversationRepo.getAgentParticipantId(sessionKey)
    if (fromConv) return fromConv
  }
  return 'assistant'
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

  // 异步一次性迁移：修复 DB 中旧消息 content_json.text 含 </think> 但无 thinkingText 的行
  setImmediate(() => { migrateThinkTagsInDb(bridge).catch((e) => log.warn('[migrate] think-tag 迁移失败:', e)) })

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
 */
export async function handleCommand(
  bridge: AgentRuntimeBridge,
  command: AgentRuntimeCommand,
): Promise<unknown> {
  switch (command.type) {
      // ---- 用户交互 ----
      case 'user:send': {
        const instanceId = await getInstanceForSession(bridge, command.sessionKey, command.agentId)
        if (!instanceId) {
          throw new Error(`No agent instance found for session: ${command.sessionKey}. Create a conversation first.`)
        }

        bridge.setSessionPreferredModel(command.sessionKey, command.modelId)

        log.info(
          `[user:send] sessionKey=${command.sessionKey}, instanceId=${instanceId}, modelId=${command.modelId ?? '(default)'}, content="${command.content.slice(0, 50)}"`,
        )

        // 确保会话存在于数据库（防止前端 createSession IPC 尚未完成时用户就发送了消息）
        const existingConv = bridge.conversationRepo.getConversation(command.sessionKey)
        if (!existingConv) {
          log.warn(`[user:send] 会话 ${command.sessionKey} 不存在，自动创建`)
          const agentId = command.agentId ?? 'assistant'
          // 直接插入数据库，使用前端传入的 sessionKey 作为 conversation.id
          const now = new Date().toISOString()
          bridge.conversationRepo['db'].prepare(
            `INSERT INTO conversations (id, user_id, title, is_active, created_at)
             VALUES (?, ?, ?, 1, ?)`,
          ).run(command.sessionKey, LOCAL_USER_ID, '新对话', now)
          // 插入参与者（user + agent）
          const insertParticipant = bridge.conversationRepo['db'].prepare(
            `INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, joined_at)
             VALUES (?, ?, ?, ?)`,
          )
          insertParticipant.run(command.sessionKey, 'user', LOCAL_USER_ID, now)
          insertParticipant.run(command.sessionKey, 'agent', agentId, now)
          log.info(`[user:send] 自动创建会话 ${command.sessionKey}, agentId=${agentId}`)
        }

        // 持久化用户消息到 DB（sessionKey === conversationId；语音消息含 WAV 供历史回放）
        try {
          const voice = 'isVoice' in command && command.isVoice === true
          const wav = 'audioWavBase64' in command && typeof (command as { audioWavBase64?: string }).audioWavBase64 === 'string'
            ? (command as { audioWavBase64: string }).audioWavBase64
            : undefined
          bridge.conversationRepo.saveMessage({
            id: command.msgId,
            conversationId: command.sessionKey,
            role: 'user',
            contentJson: {
              type: 'text',
              text: command.content,
              ...(voice ? { isVoice: true as const } : {}),
              ...(wav ? { audioWavBase64: wav } : {}),
            },
          })
          // 广播用户消息：主窗口与宠物窗口是独立渲染进程，宠物侧 sendMessage 无法更新主窗口 store
          const win = ipcMainWindowRef
          if (win && !win.isDestroyed() && command.msgId) {
            pushEvent(win, {
              type: 'conversation:message:new',
              sessionKey: command.sessionKey,
              message: {
                id: command.msgId,
                role: 'user',
                content: [{ type: 'text', text: command.content }],
                timestamp: Date.now(),
                ...(voice ? { isVoice: true as const } : {}),
                ...(wav ? { audioWavBase64: wav } : {}),
              },
            })
          }
          // 首条用户消息时，将默认标题「新对话」更新为与 useChat 一致的智能标题
          const userCount = bridge.conversationRepo.countUserMessages(command.sessionKey)
          if (userCount === 1) {
            const conv = bridge.conversationRepo.getConversation(command.sessionKey)
            const currentTitle = conv?.title?.trim()
            if (!currentTitle || currentTitle === '新对话') {
              const newTitle = deriveConversationTitleFromUserText(command.content)
              bridge.conversationRepo.updateTitle(command.sessionKey, newTitle)
              log.info(`[user:send] 首条消息更新会话标题 sessionKey=${command.sessionKey} → "${newTitle}"`)
            }
          }
        } catch (err) {
          log.error(`[user:send] failed to save user message:`, err)
        }

        // 段落总结记忆（灰度，默认 no-op）：观察该 user 轮，驱动分段/总结
        try {
          if (command.msgId) {
            bridge.segmentMemory?.observeUserTurn({
              conversationId: command.sessionKey,
              agentId: resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId),
              messageId: command.msgId,
              text: command.content,
            })
          }
        } catch (err) {
          log.error(`[user:send] segmentMemory.observeUserTurn 失败:`, err)
        }

        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        trackRunInstance(runId, instanceId)

        // 检查 ACP 后端：per-peer 优先，回退到 user-global，再回退到默认主代理
        const acpMgr = getAcpBackendManager()
        const currentBackend = acpMgr.getBackendWithFallback(LOCAL_USER_ID, command.sessionKey)
        if (currentBackend !== DEFAULT_CODING_DEV_BACKEND_ID) {
          log.info(`[user:send] ACP 路径: backendId=${currentBackend} sessionKey=${command.sessionKey}`)
          // Controller 内部负责：turn:start / message:start / delta / tool:start/progress/end /
          // message:end / idle / timeout / abort / DB 持久化。异步执行，不阻塞 IPC 响应。
          const controller = getAcpRunController()
          void controller.startRun({
            runId,
            sessionKey: command.sessionKey,
            backendId: currentBackend,
            text: command.content,
            instanceId,
            bridge,
            pushEvent: (event) => {
              const win = ipcMainWindowRef
              if (win && !win.isDestroyed()) pushEvent(win, event)
            },
          })
          return { runId }
        }

        // 主代理：通过 IpcChannelAdapter → SessionManager 发送（含并发保护 + 增量同步）
        // 不 await，让它在后台运行
        // 图片附件路径透传给 bridge.prompt，由其读盘转 base64 构造多模态 ImageContent 块
        const imageAttachmentPaths = command.imageAttachmentPaths
        if (imageAttachmentPaths && imageAttachmentPaths.length > 0) {
          log.info(
            `[user:send] 含图片附件 sessionKey=${command.sessionKey} count=${imageAttachmentPaths.length} 首张=${imageAttachmentPaths[0]}`,
          )
        }
        getIpcChannelAdapter(bridge)
          .sendPrompt(instanceId, command.sessionKey, command.content, imageAttachmentPaths, command.msgId)
          .catch((err) => {
            log.error(`[user:send] prompt failed:`, err)
          })

        return { runId }
      }

      case 'user:steer': {
        log.info(`[user:steer] steerText="${command.steerText.slice(0, 50)}"`)
        const instances = bridge.getInstances()
        const running = instances.find((i) => i.state === 'running')
        if (running) {
          bridge.steer(running.id, command.steerText)
        } else {
          log.info(`[user:steer] no running instance found`)
        }
        return undefined
      }

      case 'user:abort': {
        // 1. 尝试中止 ACP run（按 runId 精确中止 / 按 sessionKey 全部中止）
        const acpController = getAcpRunController()
        if (command.runId && acpController.abortRun(command.runId, 'user_cancel')) {
          return undefined
        }
        if (command.sessionKey && acpController.abortSession(command.sessionKey, 'user_cancel') > 0) {
          if (command.runId) untrackRun(command.runId)
          return undefined
        }
        // 2. 现有主代理中止逻辑：清挂起等待 + 级联 abort + 释放会话串行锁
        if (command.sessionKey) {
          const abortedRoots = bridge.abortSession(command.sessionKey)
          // 无论是否找到根实例，都清锁，防止上一轮 prompt Promise 未 settle 卡住后续 send
          getIpcChannelAdapter(bridge).sessionManager.clearLock(command.sessionKey)
          if (abortedRoots > 0) {
            if (command.runId) untrackRun(command.runId)
            return undefined
          }
        }

        const targetInstanceId = command.runId ? runIdToInstance.get(command.runId) : undefined
        const fallbackInstanceId = command.sessionKey ? sessionToInstance.get(command.sessionKey) : undefined
        const instanceIdToAbort = targetInstanceId ?? fallbackInstanceId
        if (!instanceIdToAbort) {
          log.info(`[user:abort] 未找到可中止实例 runId=${command.runId ?? '(none)'} sessionKey=${command.sessionKey ?? '(none)'}`)
          return undefined
        }
        // 仅中止当前 run 对应实例（及其子 Agent），避免误伤其他会话
        bridge.abortWithChildrenAndPending(instanceIdToAbort)
        if (command.sessionKey) {
          getIpcChannelAdapter(bridge).sessionManager.clearLock(command.sessionKey)
        }
        if (command.runId) untrackRun(command.runId)
        return undefined
      }

      // ---- 权限响应 ----
      case 'user:permission:respond': {
        log.info(`[user:permission:respond] requestId=${command.requestId} → ${command.decision}`)
        bridge.resolvePermission(command.requestId, command.decision)
        return undefined
      }

      // ---- ask_user_question 回答 ----
      case 'user:ask-user:respond': {
        log.info(
          `[user:ask-user:respond] requestId=${command.requestId} declined=${Boolean(command.declined)}`,
        )
        bridge.resolveAskUserQuestion(command.requestId, {
          answers: command.answers,
          annotations: command.annotations,
          declined: command.declined,
        })
        return undefined
      }

      case 'runtime:modelCatalog:set': {
        bridge.setModelCatalogFromApi(command.entries)
        return { ok: true }
      }

      case 'session:preferredModel:set': {
        bridge.primeSessionModelCompaction(command.sessionKey, command.modelId)
        return bridge.getSessionContextUsage(command.sessionKey)
      }

      case 'session:thinkingPrefs:set': {
        return bridge.setSessionThinkingPrefs(command.sessionKey, {
          ...(command.thinkingEnabled !== undefined ? { thinkingEnabled: command.thinkingEnabled } : {}),
          ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}),
        })
      }

      // ---- 会话管理 ----
      case 'conversation:create': {
        return createConversation(bridge, command.title, command.agentId, command.selectedModelId)
      }

      case 'conversation:close': {
        return closeConversation(bridge, command.sessionKey)
      }

      case 'conversation:list': {
        return listConversations(bridge)
      }

      case 'conversation:delete': {
        return deleteConversation(bridge, command.sessionKey)
      }

      case 'conversation:rename': {
        bridge.conversationRepo.updateTitle(command.sessionKey, command.newTitle)
        return { success: true }
      }

      case 'conversation:pin-toggle': {
        const isPinned = bridge.conversationRepo.togglePinned(command.sessionKey)
        return { isPinned }
      }

      case 'conversation:messages': {
        return getConversationMessages(bridge, command.sessionKey, {
          limit: command.limit,
          before: command.before,
        })
      }

      case 'conversation:context-usage': {
        return bridge.getSessionContextUsage(command.sessionKey)
      }

      case 'conversation:dismiss-interrupt': {
        bridge.clearInterruptMarker(command.sessionKey)
        return { ok: true }
      }

      case 'conversation:continue-interrupted': {
        bridge.clearInterruptMarker(command.sessionKey)
        return continueInterruptedConversation(bridge, command.sessionKey)
      }

      case 'cron:create': {
        return createLocalCronJob(bridge, command)
      }

      case 'cron:list': {
        return listLocalCronJobs(bridge, command.includeDisabled ?? true)
      }

      case 'cron:delete': {
        return deleteLocalCronJob(bridge, command.id)
      }

      case 'cron:update': {
        return updateLocalCronJob(bridge, command.id, command.patch)
      }

      case 'cron:run': {
        return runLocalCronJobNow(bridge, command.id)
      }

      case 'cron:runs': {
        return listLocalCronRuns(bridge, command.id, command.limit ?? 50)
      }

      // ---- Agent 定义查询 ----
      case 'agent:definitions:list': {
        return BUILT_IN_AGENTS.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          modelTier: a.modelTier,
          permissionMode: a.permissionMode,
          canSpawnSubAgents: a.canSpawnSubAgents,
          disallowedTools: a.disallowedTools,
          maxTurns: a.maxTurns,
        }))
      }

      case 'agent:memories:list': {
        // 若未指定 sessionKey/agentId，返回该用户所有 Agent 的记忆（记忆管理页全量视图）
        const entries = (!command.sessionKey && !command.agentId)
          ? bridge.memoryManager.listActiveAllAgents(LOCAL_USER_ID)
          : bridge.memoryManager.listActive(
              resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId),
              LOCAL_USER_ID,
            )
        return entries.map((e) => ({
          id: e.id,
          category: e.category,
          content: e.content,
          importance: e.importance,
          createdAt: new Date(e.created_at).getTime(),
          sourceSegmentId: e.source_segment_id,
          palaceDrawerId: e.palace_drawer_id,
        }))
      }

      case 'agent:memories:delete': {
        bridge.memoryManager.deleteMemory(command.memoryId)
        return { success: true }
      }

      case 'agent:memories:update': {
        bridge.memoryManager.updateMemory(command.memoryId, command.content)
        return { success: true }
      }

      case 'agent:memories:clear': {
        const agentId = resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId)
        const deletedCount = bridge.memoryManager.clearAllForAgent(agentId, LOCAL_USER_ID)
        return { deletedCount }
      }

      case 'agent:memories:export': {
        const agentId = resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId)
        const entries = bridge.memoryManager.listActive(agentId, LOCAL_USER_ID)
        const json = JSON.stringify(
          entries.map((e) => ({
            id: e.id,
            category: e.category,
            content: e.content,
            importance: e.importance,
            createdAt: e.created_at,
          })),
          null,
          2,
        )
        return { json }
      }

      case 'agent:memories:provenance': {
        const prov = bridge.memoryManager.getMemoryProvenance(command.memoryId)
        if (!prov) return null
        return {
          memoryId: prov.memoryId,
          sourceSegmentId: prov.sourceSegmentId,
          sourceMessageId: prov.sourceMessageId,
          palaceDrawerId: prov.palaceDrawerId,
          originalText: prov.originalText,
          segment: prov.segment
            ? {
                id: prov.segment.id,
                conversationId: prov.segment.conversationId,
                startMessageId: prov.segment.startMessageId,
                endMessageId: prov.segment.endMessageId,
                createdAt: prov.segment.createdAt,
                turnCount: prov.segment.turnCount,
                charCount: prov.segment.charCount,
              }
            : null,
        }
      }

      // ---- 工具管理 ----
      case 'tools:list': {
        // 附带累计调用次数，让 UI 能标出高频/从未使用的工具
        const usage = await getToolUsage()
        return bridge.listTools().map((tool) => {
          const stat = usage[tool.name]
          return {
            ...tool,
            usageCount: stat?.count ?? 0,
            ...(stat?.lastUsedAt ? { lastUsedAt: stat.lastUsedAt } : {}),
          }
        })
      }

      case 'tools:toggle': {
        const success = bridge.toggleTool(command.toolName, command.enabled)
        log.info(`[tools:toggle] toolName=${command.toolName} enabled=${command.enabled} success=${success}`)
        return { success }
      }

      case 'mcp:status': {
        const configError = bridge.getMcpConfigError()
        return {
          servers: bridge.getMcpStatus(),
          ...(configError ? { configError } : {}),
        }
      }

      case 'mcp:upsert': {
        return toMcpResult(() => bridge.upsertMcpServer(command.entry, command.originalName))
      }

      case 'mcp:import': {
        return toMcpResult(() => bridge.importMcpServers(command.entries))
      }

      case 'mcp:remove': {
        return toMcpResult(() => bridge.removeMcpServer(command.name))
      }

      case 'mcp:setEnabled': {
        return toMcpResult(() => bridge.setMcpServerEnabled(command.name, command.enabled))
      }

      case 'mcp:reconnect': {
        return toMcpResult(() => bridge.reconnectMcpServer(command.name))
      }

      case 'mcp:readConfigFile': {
        return bridge.readMcpConfigFile()
      }

      case 'mcp:writeConfigFile': {
        return toMcpResult(() => bridge.writeMcpConfigFile(command.content))
      }

      // ---- 主进程桥接（原 agent-runtime:* 独立通道）----
      case 'runtime:ping':
        return { ok: true }

      case 'runtime:featureFlags:get':
        return bridge.getFeatureFlags()

      case 'runtime:featureFlags:set': {
        bridge.setFeatureFlags(command.flags)
        return bridge.getFeatureFlags()
      }

      case 'runtime:enabled':
        return bridge.isEnabled

      case 'agentInstance:create': {
        try {
          const instanceId = await bridge.createInstance(command.agentDef as AgentDefinition | undefined)
          return { ok: true, instanceId }
        } catch (err) {
          log.error('agentInstance:create failed:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'agentInstance:createById': {
        try {
          const instanceId = await bridge.createInstanceById(command.agentId)
          return { ok: true, instanceId }
        } catch (err) {
          log.error('agentInstance:createById failed:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'agentDefinition:syncStatus':
        return bridge.getDefinitionSyncStatus()

      case 'agentDefinition:syncUserAgents': {
        try {
          const result = await bridge.syncUserAgentDefinitions()
          return { ok: true, ...result }
        } catch (err) {
          log.error('agentDefinition:syncUserAgents failed:', err)
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            synced: 0,
            failed: 0,
          }
        }
      }

      case 'agentDefinition:cacheList':
        return bridge.listCachedAgentDefinitions()

      case 'agentDefinition:cacheRemove':
        return bridge.removeCachedAgentDefinition(command.agentId)

      case 'agentDefinition:cacheClearOlder':
        return bridge.clearCachedAgentsOlderThan(command.cutoffIso)

      case 'agentDefinition:cacheClearAll': {
        bridge.clearAllCachedAgentDefinitions()
        return { ok: true }
      }

      case 'agentDefinition:cacheRefresh': {
        try {
          await bridge.refreshCachedAgentDefinition(command.agentId)
          return { ok: true }
        } catch (err) {
          log.error('agentDefinition:cacheRefresh failed:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'agentInstance:prompt': {
        try {
          await bridge.prompt(command.instanceId, command.message)
          return { ok: true }
        } catch (err) {
          log.error('agentInstance:prompt failed:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'agentInstance:abort': {
        bridge.abort(command.instanceId)
        return { ok: true }
      }

      case 'agentInstance:destroy': {
        bridge.destroy(command.instanceId)
        return { ok: true }
      }

      case 'agentInstance:list':
        return bridge.getInstances()

      case 'agentInstance:lifecycleSnapshot':
        return bridge.getLifecycleSnapshot(String(command.definitionId ?? ''))

      case 'storage:stats':
        return bridge.getLocalStorageStats()

      case 'storage:exportJsonl':
        return bridge.exportLocalDataJSONL()

      case 'storage:clearMalformed':
        return bridge.clearMalformedMessages()

      case 'storage:listBackups':
        return bridge.listDatabaseBackups()

      case 'storage:createBackup': {
        try {
          const backup = bridge.createDatabaseBackupNow()
          return { ok: true, ...backup }
        } catch (err) {
          log.error('[storage:createBackup] failed:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'storage:restoreBackup': {
        try {
          return await bridge.restoreDatabaseFromBackupFile(String(command.backupFileName ?? ''))
        } catch (err) {
          log.error('[storage:restoreBackup] failed:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'storage:restoreLatestBackup': {
        try {
          return { ok: true, ...(await bridge.restoreDatabaseFromLatestBackup()) }
        } catch (err) {
          log.error('[storage:restoreLatestBackup] failed:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'storage:deleteBackup': {
        try {
          bridge.deleteDatabaseBackupFile(String(command.backupFileName ?? ''))
          return { ok: true }
        } catch (err) {
          log.error('[storage:deleteBackup] failed:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'storage:auditRecent':
        return bridge.auditRepo.listRecentGlobally(command.limit ?? 20)

      case 'message:delete': {
        const { messageId, sessionKey: convId } = command
        try {
          bridge.conversationRepo.deleteMessage(messageId, convId)
          return { success: true }
        } catch (err) {
          log.error(`[message:delete] failed to delete message ${messageId}:`, err)
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'message:edit': {
        const { messageId, sessionKey: convId, newContent } = command
        try {
          bridge.conversationRepo.updateMessageContent({
            messageId,
            conversationId: convId,
            contentJson: { type: 'text', text: newContent },
            isStreaming: false,
          })
          return { success: true }
        } catch (err) {
          log.error(`[message:edit] failed to edit message ${messageId}:`, err)
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'conversation:fork': {
        const { sourceSessionKey, uptoMessageId, newContent } = command
        try {
          const agentId = bridge.conversationRepo.getAgentParticipantId(sourceSessionKey)
          const newSessionKey = bridge.conversationRepo.forkConversation({
            sourceConversationId: sourceSessionKey,
            uptoMessageId,
            newUserContent: newContent,
            userId: LOCAL_USER_ID,
            agentId,
          })
          log.info(`[conversation:fork] ${sourceSessionKey} → ${newSessionKey}`)
          return { success: true, sessionKey: newSessionKey }
        } catch (err) {
          log.error(`[conversation:fork] failed:`, err)
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'message:edit-and-resend': {
        const { sessionKey: convId, messageId, newContent } = command
        log.info(`[message:edit-and-resend] convId=${convId} messageId=${messageId}`)
        try {
          // 1. 删除该消息之后的所有消息
          const removed = bridge.conversationRepo.deleteMessagesAfter(messageId, convId)
          log.info(`[message:edit-and-resend] deleted ${removed} messages after ${messageId}`)
          // 2. 更新消息内容
          bridge.conversationRepo.updateMessageContent({
            messageId,
            conversationId: convId,
            contentJson: { type: 'text', text: newContent },
            isStreaming: false,
          })
          // 3. 重新触发 Agent 回复（复用 compact 路径的 getInstanceForSession）
          const instanceId = await getInstanceForSession(bridge, convId)
          if (instanceId) {
            // 截断重放：DB 已删后续消息，但 Agent 内存仍保留完整历史。
            // 强制下次 beforePrompt 以 DB 为准重注入，否则「内存更完整」启发式会把后续消息一并发给 LLM。
            const adapter = getIpcChannelAdapter(bridge)
            const strategy = adapter.getContextStrategy()
            if (strategy instanceof StatefulContextStrategy) {
              strategy.markForceResync(convId)
            }
            // 排除已更新的用户消息，避免 restore + prompt 重复注入
            await adapter.sendPrompt(
              instanceId,
              convId,
              newContent,
              undefined,
              messageId,
            )
          } else {
            log.warn(`[message:edit-and-resend] 无 instanceId，消息已更新但未自动触发回复`)
          }
          return { success: true, messagesRemoved: removed }
        } catch (err) {
          log.error(`[message:edit-and-resend] failed:`, err)
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'user:compact-context': {
        const keepTurns = command.keepRecentTurns ?? 6
        log.info(`[user:compact-context] sessionKey=${command.sessionKey}, keepRecentTurns=${keepTurns}`)
        try {
          // 重启后 sessionToInstance 可能为空，通过 getInstanceForSession 恢复实例（含 LLM stream）
          const instanceId = await getInstanceForSession(bridge, command.sessionKey)
          if (instanceId) {
            const result = await bridge.compactContextAsync(instanceId, command.sessionKey, keepTurns)
            // 压缩后 DB 比内存短，必须强制下次 prompt 以 DB（含摘要）为准重注入
            const adapter = getIpcChannelAdapter(bridge)
            const strategy = adapter.getContextStrategy()
            if (strategy instanceof StatefulContextStrategy) {
              strategy.markForceResync(command.sessionKey)
            }
            return result
          } else {
            log.warn(`[user:compact-context] 无法恢复 instanceId，降级为同步压缩: sessionKey=${command.sessionKey}`)
            const result = bridge.compactContext(command.sessionKey, keepTurns)
            return { ...result, hadSummary: false }
          }
        } catch (err) {
          log.error(`[user:compact-context] 失败:`, err)
          throw err
        }
      }

      // ---- 文件管理 ----
      case 'files:list': {
        const { userId, agentId, conversationId, channel, category, limit, offset } = command
        // 若指定了 conversationId，直接走按对话查询（返回格式与 listByUser 保持一致）
        if (conversationId) {
          const files = bridge.fileRepo.listByConversation(conversationId)
          return { files, total: files.length }
        }
        return bridge.fileRepo.listByUser(userId, { agentId, channel, category, limit, offset })
      }

      case 'tasks:list': {
        const { conversationId } = command
        const rows = bridge.taskRepo.list(conversationId)
        return {
          tasks: rows.map((t) => ({
            id: t.id,
            subject: t.subject,
            description: t.description,
            status: t.status,
            owner: t.owner,
          })),
        }
      }

      case 'files:search': {
        const { userId, query, filters } = command
        const results = bridge.fileRepo.search(userId, query, filters)
        return results.map((f) => ({
          id: f.id,
          fileName: f.fileName,
          localPath: f.localPath,
          fileSize: f.fileSize,
          mimeType: f.mimeType,
          createdAt: f.createdAt,
          channel: f.channel,
          agentId: f.agentId,
          conversationId: f.conversationId,
        }))
      }

      case 'files:delete': {
        const { fileIds } = command
        const cwd = bridge.getCwd()
        const resolvedCwd = path.resolve(cwd)
        for (const id of fileIds) {
          const file = bridge.fileRepo.findById(id)
          if (!file) continue
          const absPath = path.resolve(cwd, file.localPath)
          const resolvedAbs = path.resolve(absPath)
          if (isResolvedPathInsideWorkspace(resolvedAbs, resolvedCwd)) {
            try {
              await fs.promises.unlink(resolvedAbs)
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code
              if (code !== 'ENOENT') {
                log.warn(`[files:delete] 磁盘删除失败 ${resolvedAbs}:`, err)
              }
            }
          } else {
            log.warn(`[files:delete] 跳过工作区外路径: ${resolvedAbs}`)
          }
          bridge.fileRepo.hardDelete(id)
        }
        return { deletedCount: fileIds.length }
      }

      case 'files:open': {
        const { fileId } = command
        const file = bridge.fileRepo.findById(fileId)
        if (!file) throw new Error(`文件不存在: ${fileId}`)
        const cwd = bridge.getCwd()
        const absPath = path.resolve(cwd, file.localPath)
        if (!fs.existsSync(absPath)) {
          bridge.fileRepo.markMissing(fileId)
          throw new Error('文件已丢失，可能已被删除或移动')
        }
        await shell.openPath(absPath)
        return { success: true }
      }

      case 'files:save-as': {
        const { fileId, savePath } = command
        const file = bridge.fileRepo.findById(fileId)
        if (!file) throw new Error(`文件不存在: ${fileId}`)
        const cwd = bridge.getCwd()
        const absPath = path.resolve(cwd, file.localPath)
        if (!fs.existsSync(absPath)) {
          bridge.fileRepo.markMissing(fileId)
          throw new Error('文件已丢失，可能已被删除或移动')
        }
        await fs.promises.copyFile(absPath, savePath)
        return { success: true }
      }

      case 'files:read-preview-content': {
        const { fileId } = command
        const file = bridge.fileRepo.findById(fileId)
        if (!file) throw new Error(`文件不存在: ${fileId}`)
        const cwd = bridge.getCwd()
        const absPath = path.resolve(cwd, file.localPath)
        if (!fs.existsSync(absPath)) {
          bridge.fileRepo.markMissing(fileId)
          throw new Error('文件已丢失，可能已被删除或移动')
        }
        const inferred = inferPreviewMimeFromFileName(file.fileName)
        /** 元数据误标为 text/* 时仍以扩展名为准（避免 PDF 等被按 UTF-8 读坏） */
        let effectiveMime = file.mimeType ?? inferred
        if (
          inferred &&
          file.mimeType?.startsWith('text/') &&
          (inferred === 'application/pdf' ||
            inferred === 'application/msword' ||
            inferred === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        ) {
          effectiveMime = inferred
        }
        const MAX_BYTES = 10 * 1024 * 1024
        const stat = await fs.promises.stat(absPath)
        if (stat.size > MAX_BYTES) {
          return { truncated: true, content: null, size: stat.size, mimeType: effectiveMime }
        }
        if (shouldReadPreviewAsUtf8(effectiveMime, file.fileName)) {
          const content = await fs.promises.readFile(absPath, 'utf-8')
          return {
            truncated: false,
            content,
            size: stat.size,
            mimeType: effectiveMime,
            encoding: 'utf-8',
          }
        }
        const buf = await fs.promises.readFile(absPath)
        return {
          truncated: false,
          content: buf.toString('base64'),
          size: stat.size,
          mimeType: effectiveMime,
          encoding: 'base64',
        }
      }

      // ---- 命令注册表 ----
      case 'commands:list': {
        return BASE_SLASH_COMMANDS
      }

      case 'files:read-preview-by-path': {
        const { filePath, startLine, endLine } = command
        const cwd = bridge.getCwd()
        const expandedPath = expandTildePath(filePath)
        // 路径安全：须位于 workspace 或 Lumii 截图临时目录内
        const absPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(cwd, expandedPath)
        const resolvedAbs = path.resolve(absPath)
        const resolvedCwd = path.resolve(cwd)
        if (!isAllowedPreviewPath(resolvedAbs, resolvedCwd)) {
          throw new Error('该路径不在当前 Agent 工作目录内，无法预览')
        }
        if (!fs.existsSync(resolvedAbs)) {
          throw new Error('文件不存在或已被删除')
        }
        const fileName = path.basename(resolvedAbs)
        /** 与 files:read-preview-content 共用推断，避免 PDF 等被误作 text/plain */
        const inferred = inferPreviewMimeFromFileName(fileName)
        let effectiveMime = inferred ?? 'text/plain'
        const MAX_BYTES = 10 * 1024 * 1024
        const stat = await fs.promises.stat(resolvedAbs)
        if (stat.isDirectory()) {
          throw new Error('无法预览目录，请在文件树中展开查看')
        }
        if (stat.size > MAX_BYTES) {
          return {
            truncated: true,
            content: null,
            size: stat.size,
            mimeType: effectiveMime,
            fileName,
            ranged: false,
          }
        }

        const textMode = shouldReadPreviewAsUtf8(effectiveMime, fileName)

        if (textMode) {
          const raw = await fs.promises.readFile(resolvedAbs, 'utf-8')
          if (typeof startLine === 'number' && startLine >= 1) {
            const lines = raw.length === 0 ? [] : raw.split('\n')
            const start0 = Math.max(0, startLine - 1)
            const end0 =
              typeof endLine === 'number' && endLine >= startLine
                ? Math.min(lines.length, endLine)
                : lines.length
            const sliced = lines.slice(start0, end0).join('\n')
            return {
              truncated: false,
              content: sliced,
              size: stat.size,
              mimeType: effectiveMime,
              fileName,
              ranged: true,
              startLine,
              endLine: typeof endLine === 'number' ? endLine : lines.length,
              encoding: 'utf-8',
            }
          }
          return {
            truncated: false,
            content: raw,
            size: stat.size,
            mimeType: effectiveMime,
            fileName,
            ranged: false,
            encoding: 'utf-8',
          }
        }

        const buf = await fs.promises.readFile(resolvedAbs)
        return {
          truncated: false,
          content: buf.toString('base64'),
          size: stat.size,
          mimeType: effectiveMime,
          fileName,
          ranged: false,
          encoding: 'base64',
        }
      }

      case 'files:import': {
        const { sourcePath, fileName, mimeType, conversationId, fileBuffer } = command
        const cwd = bridge.getCwd()
        // 按日期创建 uploads 子目录
        const today = new Date()
        const dateFolder = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
        const uploadsDir = path.join(cwd, 'uploads', dateFolder)
        await fs.promises.mkdir(uploadsDir, { recursive: true })
        // 避免文件名冲突：加时间戳前缀
        const ts = Date.now()
        const ext = path.extname(fileName)
        const base = path.basename(fileName, ext)
        const destFileName = `${base}_${ts}${ext}`
        const destAbs = path.join(uploadsDir, destFileName)

        let fileBase64: string
        if (fileBuffer) {
          // 渲染进程直接传来文件内容（file.path 不可用时的 fallback）
          await fs.promises.writeFile(destAbs, Buffer.from(fileBuffer as string, 'base64'))
          fileBase64 = fileBuffer as string
        } else {
          if (!sourcePath || !fs.existsSync(sourcePath)) {
            throw new Error(`源文件不存在: ${sourcePath}`)
          }
          await fs.promises.copyFile(sourcePath, destAbs)
          fileBase64 = (await fs.promises.readFile(destAbs)).toString('base64')
        }

        const stat = await fs.promises.stat(destAbs)
        const localPath = path.relative(cwd, destAbs).replace(/\\/g, '/')
        const fileId = bridge.fileRepo.registerOrUpdate({
          userId: LOCAL_USER_ID,
          agentId: null,
          conversationId: conversationId ?? null,
          messageId: null,
          channel: 'windows',
          sourceType: 'user_upload',
          fileName: destFileName,
          fileSize: stat.size,
          mimeType: mimeType || 'application/octet-stream',
          localPath,
        })

        // 对可解析的文档格式，生成伴生 .extracted.txt 文件
        // Agent 通过 file_read 读取伴生文件即可获得可理解的纯文本内容
        let parsedTextPath: string | null = null
        const parsableMimes = new Set([
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/vnd.ms-powerpoint',
          'text/csv',
          'text/tab-separated-values',
          'application/epub+zip',
          'application/rtf',
          'text/rtf',
        ])
        const parsableExts = new Set([
          '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
          '.csv', '.tsv', '.epub', '.rtf',
        ])
        // 音频文件通过 ASR 转录
        const audioMimes = new Set([
          'audio/wav', 'audio/x-wav', 'audio/wave',
          'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/aac',
        ])
        const audioExts = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac'])
        const effectiveMime = mimeType || 'application/octet-stream'
        const fileExt = ext.toLowerCase()
        if (parsableMimes.has(effectiveMime) || parsableExts.has(fileExt)) {
          try {
            const parseResult = await extractDocumentText(fileBase64, destFileName, effectiveMime)
            if (parseResult.ok && parseResult.text) {
              const txtFileName = `${base}_${ts}.extracted.txt`
              const txtAbs = path.join(uploadsDir, txtFileName)
              const header = [
                `# 文档解析结果`,
                `# 原始文件: ${destFileName}`,
                `# 格式: ${effectiveMime}`,
                parseResult.pages ? `# 页数: ${parseResult.pages}` : null,
                `# 解析时间: ${new Date().toISOString()}`,
                ``,
              ].filter(Boolean).join('\n')
              await fs.promises.writeFile(txtAbs, header + parseResult.text, 'utf-8')
              parsedTextPath = path.relative(cwd, txtAbs).replace(/\\/g, '/')
              log.info(`[files:import] 文档解析成功: ${destFileName} → ${txtFileName} (${parseResult.text.length} chars)`)
            } else {
              log.warn(`[files:import] 文档解析失败或无内容: ${destFileName}`)
            }
          } catch (parseErr) {
            log.warn(`[files:import] 文档解析异常（已忽略）: ${destFileName}`, parseErr)
          }
        } else if ((audioMimes.has(effectiveMime) || audioExts.has(fileExt)) && audioTranscribeCallback) {
          // 音频文件：调用 ASR 引擎转录，生成伴生文本
          try {
            log.info(`[files:import] 开始 ASR 转录音频文件: ${destFileName}`)
            const transcribedText = await audioTranscribeCallback(fileBase64, effectiveMime)
            if (transcribedText) {
              const txtFileName = `${base}_${ts}.extracted.txt`
              const txtAbs = path.join(uploadsDir, txtFileName)
              const header = [
                `# 语音转录结果`,
                `# 原始文件: ${destFileName}`,
                `# 格式: ${effectiveMime}`,
                `# 转录时间: ${new Date().toISOString()}`,
                ``,
              ].filter(Boolean).join('\n')
              await fs.promises.writeFile(txtAbs, header + transcribedText, 'utf-8')
              parsedTextPath = path.relative(cwd, txtAbs).replace(/\\/g, '/')
              log.info(`[files:import] ASR 转录成功: ${destFileName} → ${txtFileName} (${transcribedText.length} chars)`)
            } else {
              log.warn(`[files:import] ASR 转录无内容: ${destFileName}`)
            }
          } catch (asrErr) {
            log.warn(`[files:import] ASR 转录异常（已忽略）: ${destFileName}`, asrErr)
          }
        }

        return {
          fileId,
          localPath,
          absPath: destAbs,
          fileName: destFileName,
          mimeType: effectiveMime,
          fileSize: stat.size,
          /** 伴生文本文件的相对路径（workspace 相对），null 表示无法解析或不需要解析 */
          parsedTextPath,
        }
      }

      // ---- ACP 多后端管理 ----
      case 'codingDev:setBackend': {
        const mgr = getAcpBackendManager()
        // Windows 客户端统一用 user-global 范围，accountId 固定为 LOCAL_USER_ID
        await mgr.setBackend(
          command.backendId as CodingDevBackendId,
          'user-global',
          LOCAL_USER_ID,
        )
        return { ok: true }
      }

      case 'codingDev:getBackend': {
        const mgr = getAcpBackendManager()
        const backendId = mgr.getBackend(LOCAL_USER_ID)
        return { backendId }
      }

      case 'codingDev:listBackends': {
        const mgr = getAcpBackendManager()
        return { backends: mgr.listBackends() }
      }

      // ---- 图片处理（识别 / 美化 / 等，按 operation 扩展） ----
      case 'image:recognize': {
        const { imagePath, modelId, prompt, includeOcr } = command
        try {
          const result = await bridge.recognizeImage({
            imagePath,
            modelId,
            prompt,
            includeOcr,
          })
          log.info(`[image:recognize] 识别完成 model=${result.modelId} descLen=${result.description.length} ocrLen=${result.ocrText.length}`)
          return result
        } catch (err) {
          log.error(`[image:recognize] 失败:`, err)
          throw err
        }
      }

      case 'image:generate': {
        const { prompt, modelId, width, height } = command
        try {
          const result = await bridge.generateImage({ prompt, modelId, width, height })
          log.info(`[image:generate] 生成完成: ${result.filePath} (${result.width}x${result.height})`)
          return result
        } catch (err) {
          log.error(`[image:generate] 失败:`, err)
          throw err
        }
      }

      case 'image:process': {
        const { operation } = command
        // 预留接口：当前仅支持未来注册的策略，目前统一抛错
        // 注册方式（后续实现）：const strategy = imageStrategies[operation]; if (strategy) return strategy.run(...)
        throw new Error(`图片处理操作 '${operation}' 尚未实现，功能开发中`)
      }

      // ---- 技能自进化 ----
      case 'skill:confirm_draft': {
        try {
          const engine = bridge.getSkillEvolutionEngine()
          if (!engine) throw new Error('SkillEvolutionEngine 未初始化')
          await engine.confirmDraft(command.draft.id, command.draft as import('../skill-evolution/types').SkillDraft)
          log.info(`[skill:confirm_draft] 草稿已确认: draftId=${command.draft.id}`)
          return { ok: true }
        } catch (err) {
          log.error('[skill:confirm_draft] 失败:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'skill:reject_draft': {
        try {
          const engine = bridge.getSkillEvolutionEngine()
          if (!engine) throw new Error('SkillEvolutionEngine 未初始化')
          await engine.rejectDraft(command.draftId)
          log.info(`[skill:reject_draft] 草稿已拒绝: draftId=${command.draftId}`)
          return { ok: true }
        } catch (err) {
          log.error('[skill:reject_draft] 失败:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case 'skill:deprecate': {
        try {
          const engine = bridge.getSkillEvolutionEngine()
          if (!engine) throw new Error('SkillEvolutionEngine 未初始化')
          await engine.deprecateSkill(command.skillName)
          log.info(`[skill:deprecate] 技能已废弃: skillName=${command.skillName}`)
          return { ok: true }
        } catch (err) {
          log.error('[skill:deprecate] 失败:', err)
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

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

/**
 * 创建新对话
 *
 * 1. 在 ConversationRepo 中创建持久化对话记录
 * 2. 使用 conversationId 作为 sessionKey（重启后不变，历史对话可恢复）
 * 3. 创建 Agent 实例并绑定到 sessionKey
 */
async function createConversation(
  bridge: AgentRuntimeBridge,
  title?: string,
  agentId?: string,
  selectedModelId?: string,
): Promise<{ sessionKey: string; conversationId: string }> {
  // 1. 持久化到 DB
  const conversation = bridge.conversationRepo.createConversation({
    userId: 'local-user',
    title: title ?? '新对话',
    participants: [
      { type: 'user', id: 'local-user' },
      { type: 'agent', id: agentId ?? 'default' },
    ],
  })

  // 2. 使用 conversationId 作为 sessionKey（确定性值，重启后仍有效）
  const sessionKey = conversation.id

  // 2b. 根据 UI 选中模型写入会话级压缩参数（在 createInstance 之前）
  bridge.primeSessionModelCompaction(sessionKey, selectedModelId)

  // 3. 创建 Agent 实例，绑定到 sessionKey 和 conversationId
  const instanceId = agentId
    ? await bridge.createInstanceById(agentId, sessionKey, conversation.id)
    : await bridge.createInstance(undefined, sessionKey, conversation.id)
  sessionToInstance.set(sessionKey, instanceId)

  log.info(`[conversation:create] sessionKey=${sessionKey}, conversationId=${conversation.id}, instanceId=${instanceId}, title="${title ?? '新对话'}"`)

  return { sessionKey, conversationId: conversation.id }
}

/**
 * 关闭对话
 *
 * 清理 Agent 实例和 sessionKey 映射
 * sessionKey === conversationId，直接用于 DB 操作
 */
function closeConversation(
  bridge: AgentRuntimeBridge,
  sessionKey: string,
): void {
  const instanceId = sessionToInstance.get(sessionKey)
  if (instanceId) {
    try {
      bridge.destroy(instanceId)
    } catch (err) {
      log.error(`[conversation:close] failed to destroy instance ${instanceId}:`, err)
    }
    untrackInstanceRuns(instanceId)
    sessionToInstance.delete(sessionKey)
  }

  bridge.clearSessionPreferredModel(sessionKey)

  // sessionKey === conversationId，直接关闭对话
  try {
    bridge.conversationRepo.closeConversation(sessionKey)
  } catch (err) {
    log.error(`[conversation:close] failed to close conversation ${sessionKey}:`, err)
  }

  log.info(`[conversation:close] sessionKey=${sessionKey}`)
}

/**
 * 根据会话 ID / 微信绑定推断渠道标记。
 * - wechat：微信绑定会话，或 id 以 weixin: 开头
 * - wecom / feishu：id 前缀
 * - default：其余（含客户端本地新建）
 */
function resolveConversationChannel(
  conversationId: string,
  weixinConvIds: Set<string>,
): 'default' | 'wechat' | 'wecom' | 'feishu' {
  if (weixinConvIds.has(conversationId) || conversationId.startsWith('weixin:')) {
    return 'wechat'
  }
  if (conversationId.startsWith('wecom:')) return 'wecom'
  if (conversationId.startsWith('feishu:')) return 'feishu'
  return 'default'
}

/**
 * 列出活跃对话
 * sessionKey === conversationId，重启后仍有效
 * agentId 从 conversation_participants 表关联查出，用于侧边栏按 Agent 分组
 */
function listConversations(
  bridge: AgentRuntimeBridge,
): readonly { id: string; sessionKey: string; title: string; updatedAt: string; agentId?: string; lastMessagePreview?: string; hasRunning?: boolean; isPinned?: boolean; wasInterrupted?: boolean; channel?: string }[] {
  const conversations = bridge.conversationRepo.listActiveConversations('local-user', 50)

  // 构建微信绑定的 conversationId 集合（用于渠道标记）
  const weixinConvIds = new Set<string>()
  if (weixinBindingManagerRef) {
    for (const binding of weixinBindingManagerRef.listBindings()) {
      weixinConvIds.add(binding.conversationId)
    }
  }

  return conversations.map((c) => ({
    ...(() => {
      const lastMsg = bridge.conversationRepo.loadRecentMessages(c.id, 1)[0]
      if (!lastMsg) return {}
      try {
        const parsed = JSON.parse(lastMsg.content_json) as { text?: string; content?: string }
        const text = typeof parsed?.text === 'string'
          ? parsed.text
          : typeof parsed?.content === 'string'
            ? parsed.content
            : ''
        return { lastMessagePreview: text.slice(0, 80) }
      } catch {
        return {}
      }
    })(),
    id: c.id,
    sessionKey: c.id,  // sessionKey 直接使用 conversationId，重启后不失效
    title: c.title ?? '新对话',
    updatedAt: c.last_msg_at ?? c.created_at,
    agentId: bridge.conversationRepo.getAgentParticipantId(c.id),
    hasRunning: bridge.hasStreamingMessages(c.id),
    isPinned: c.is_pinned === 1,
    wasInterrupted: bridge.isConversationInterrupted(c.id),
    channel: resolveConversationChannel(c.id, weixinConvIds),
  }))
}

/**
 * 继续被中断的对话：获取或创建实例，发送 continuation prompt（设计文档 §3.2.4）
 */
async function continueInterruptedConversation(
  bridge: AgentRuntimeBridge,
  sessionKey: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const instanceId = await getInstanceForSession(bridge, sessionKey)
    if (!instanceId) {
      return { ok: false, error: 'Failed to get or create agent instance for interrupted session' }
    }

    const CONTINUATION_PROMPT =
      "你的上一次执行被中断了（客户端重启）。" +
      "请查看上面的对话历史，了解你已经完成了什么，然后继续完成剩余的任务。" +
      "注意：已经执行过的操作不要重复执行。"

    // 持久化 continuation prompt 到 DB
    const msgId = `cont-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    try {
      bridge.conversationRepo.saveMessage({
        id: msgId,
        conversationId: sessionKey,
        role: 'user',
        contentJson: { type: 'text', text: CONTINUATION_PROMPT },
      })
    } catch (err) {
      log.error(`[continue-interrupted] failed to save continuation message:`, err)
    }

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    trackRunInstance(runId, instanceId)

    // 必须走 SessionManager.sendPrompt（含 beforePrompt 历史恢复），不可直接 bridge.prompt
    getIpcChannelAdapter(bridge)
      .sendPrompt(instanceId, sessionKey, CONTINUATION_PROMPT, undefined, msgId)
      .catch((err) => {
        log.error(`[continue-interrupted] prompt failed:`, err)
      })

    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`[continue-interrupted] error:`, err)
    return { ok: false, error: msg }
  }
}

/**
 * 删除对话（从数据库中彻底删除）
 * sessionKey === conversationId
 */
function deleteConversation(
  bridge: AgentRuntimeBridge,
  sessionKey: string,
): void {
  const instanceId = sessionToInstance.get(sessionKey)
  if (instanceId) {
    try {
      bridge.destroy(instanceId)
    } catch (err) {
      log.error(`[conversation:delete] failed to destroy instance ${instanceId}:`, err)
    }
    untrackInstanceRuns(instanceId)
    sessionToInstance.delete(sessionKey)
  }

  bridge.clearSessionPreferredModel(sessionKey)

  // 软删除该对话关联的所有文件
  try {
    const now = new Date()
    const conversationFiles = bridge.fileRepo.listByConversation(sessionKey)
    for (const f of conversationFiles) {
      bridge.fileRepo.softDelete(f.id, now)
    }
    if (conversationFiles.length > 0) {
      log.info(`[conversation:delete] soft-deleted ${conversationFiles.length} files for conversation ${sessionKey}`)
    }
  } catch (err) {
    log.warn('[conversation:delete] failed to soft-delete files:', err)
  }

  // sessionKey === conversationId，直接从数据库删除对话
  // 不捕获异常 —— 让错误向上传播至 handleCommand / IPC handler，
  // 使渲染层能感知删除失败，避免假性成功导致重启后数据复现。
  bridge.conversationRepo.deleteConversation(sessionKey)

  log.info(`[conversation:delete] sessionKey=${sessionKey}`)
}

/**
 * 获取对话消息
 * sessionKey === conversationId，直接用于 DB 查询
 */
/**
 * 一次性 DB 迁移：将旧消息 content_json.text 中的内联 </think> 标签剥离，
 * 把推理内容写入 thinkingText 字段，正文存干净文本。
 * 幂等：已有 thinkingText 字段的行跳过。
 */
async function migrateThinkTagsInDb(bridge: AgentRuntimeBridge): Promise<void> {
  const repo = bridge.conversationRepo
  // 只扫描 assistant 行且 content_json 含 </think> 的消息，避免全表扫描
  const rows = repo.loadMessagesContaining('</think>', 'assistant')
  if (rows.length === 0) return
  log.info(`[migrate] 发现 ${rows.length} 条旧消息含 </think>，开始迁移...`)
  let fixed = 0
  for (const row of rows) {
    try {
      const parsed = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json
      if (!parsed || typeof parsed !== 'object') continue
      const p = parsed as Record<string, unknown>
      // 已有 thinkingText 说明是新格式，跳过
      if (typeof p.thinkingText === 'string') continue
      const rawText = typeof p.text === 'string' ? p.text : ''
      if (!rawText.includes('</think>')) continue
      const { thinkingText, finalText } = parseThinkTagsFromRaw(rawText)
      const newJson = JSON.stringify({ ...p, text: finalText, ...(thinkingText ? { thinkingText } : {}) })
      repo.updateMessageContentRaw(row.id, newJson)
      fixed++
    } catch (e) {
      log.warn(`[migrate] 跳过消息 ${row.id}:`, e)
    }
  }
  log.info(`[migrate] think-tag 迁移完成，共修复 ${fixed} 条消息`)
}

/** UI 单页历史消息条数：兼顾首屏渲染成本与上滑加载频率 */
const CONVERSATION_PAGE_SIZE = 60

interface ConversationHistoryMessage {
  id: string
  role: string
  content: readonly { type: 'text'; text: string }[]
  contentJson: string
  timestamp: number
  isStreaming?: boolean
  /** 已被上下文压缩移出 LLM 请求，但仍保留在历史中 */
  contextExcluded?: boolean
  thinkingText?: string
  toolCalls?: readonly { id: string; name: string; args: Record<string, unknown>; result?: unknown; isError?: boolean; textPositionAtStart?: number }[]
  sourceAgent?: { instanceId: string; label: string }
  isVoice?: boolean
  audioWavBase64?: string
}

/**
 * 分页读取会话历史供 UI 展示。
 *
 * 与「喂给模型」的读取路径不同，这里**不过滤**已压缩消息：压缩只是把消息移出上下文，
 * 用户仍需要能回看。历史可能很长，因此按游标倒序分页，由 UI 上滑懒加载。
 */
function getConversationMessages(
  bridge: AgentRuntimeBridge,
  sessionKey: string,
  options?: { limit?: number; before?: { timestamp: string; id: string } },
): {
  items: readonly ConversationHistoryMessage[]
  hasMore: boolean
  nextCursor?: { timestamp: string; id: string }
} {
  const conversationId = sessionKey
  bridge.setLastActiveConversation(conversationId)
  const page = bridge.conversationRepo.loadMessagesPage(conversationId, {
    limit: options?.limit ?? CONVERSATION_PAGE_SIZE,
    ...(options?.before ? { before: options.before } : {}),
  })

  const items = page.items.map((msg): ConversationHistoryMessage => {
    let contentText = ''
    let thinkingText: string | undefined
    let toolCalls: Array<{
      id: string
      name: string
      args: Record<string, unknown>
      result?: unknown
      isError?: boolean
      textPositionAtStart?: number
    }> | undefined
    let sourceAgent: { instanceId: string; label: string } | undefined
    let isVoice: boolean | undefined
    let audioWavBase64: string | undefined
    try {
      const parsed = typeof msg.content_json === 'string'
        ? JSON.parse(msg.content_json)
        : msg.content_json
      if (parsed && typeof parsed === 'object') {
        if ((parsed as { isVoice?: unknown }).isVoice === true) isVoice = true
        const aw = (parsed as { audioWavBase64?: unknown }).audioWavBase64
        if (typeof aw === 'string' && aw.length > 0) audioWavBase64 = aw
      }
      // 仅工具调用、无正文的 assistant 回合 text 为空，此时不能兜到 JSON.stringify，
      // 否则 null 会渲染成字面量 "null"、tool_result 会渲染成整坨 JSON。
      contentText = typeof parsed === 'string' ? parsed
        : typeof parsed?.text === 'string' ? parsed.text
          : typeof parsed?.content === 'string' ? parsed.content
            : ''
      // 读取存库的 thinkingText（新格式）
      if (parsed && typeof parsed === 'object' && typeof (parsed as { thinkingText?: unknown }).thinkingText === 'string') {
        thinkingText = (parsed as { thinkingText: string }).thinkingText || undefined
      }
      // 旧消息兜底：content_json 里没有 thinkingText 但 text 含 </think> 标签时实时解析
      if (!thinkingText && msg.role === 'assistant' && contentText.includes('</think>')) {
        const parsed2 = parseThinkTagsFromRaw(contentText)
        thinkingText = parsed2.thinkingText || undefined
        contentText = parsed2.finalText
      }
      const rawTools = parsed && typeof parsed === 'object' && Array.isArray((parsed as { toolCalls?: unknown }).toolCalls)
        ? (parsed as { toolCalls: Array<Record<string, unknown>> }).toolCalls
        : undefined
      if (rawTools && rawTools.length > 0) {
        toolCalls = rawTools.map((t) => ({
          id: String(t.id ?? ''),
          name: String(t.name ?? ''),
          args: (t.args && typeof t.args === 'object' ? t.args : {}) as Record<string, unknown>,
          result: t.result,
          isError: Boolean(t.isError),
          textPositionAtStart: typeof t.textPositionAtStart === 'number' ? t.textPositionAtStart : undefined,
        }))
      }
      const rawSa = parsed && typeof parsed === 'object' ? (parsed as { sourceAgent?: unknown }).sourceAgent : undefined
      if (rawSa && typeof rawSa === 'object') {
        const sa = rawSa as Record<string, unknown>
        if (typeof sa.instanceId === 'string' && sa.instanceId) {
          sourceAgent = { instanceId: sa.instanceId, label: String(sa.label ?? sa.instanceId) }
        }
      }
    } catch {
      contentText = String(msg.content_json)
    }

    return {
      id: msg.id,
      role: msg.role,
      content: [{ type: 'text' as const, text: contentText }],
      // renderer 使用共享 parser 恢复 assistant_parts，保留旧 content 字段兼容历史消息。
      contentJson: msg.content_json,
      timestamp: new Date(msg.timestamp).getTime(),
      ...(msg.is_streaming === 1 ? { isStreaming: true } : {}),
      ...(msg.compacted_at ? { contextExcluded: true } : {}),
      ...(thinkingText ? { thinkingText } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(sourceAgent ? { sourceAgent } : {}),
      ...(isVoice ? { isVoice: true } : {}),
      ...(audioWavBase64 ? { audioWavBase64 } : {}),
    }
  })

  // 游标用 DB 原始 timestamp 字符串，避免 renderer 用毫秒时间戳回推 ISO 时产生偏差
  const oldest = page.items[0]
  return {
    items,
    hasMore: page.hasMore,
    ...(oldest ? { nextCursor: { timestamp: oldest.timestamp, id: oldest.id } } : {}),
  }
}

/**
 * 创建本地 Cron 任务（写入 local_cron_jobs 表，Bridge 启动后会自动恢复调度）。
 */
function createLocalCronJob(
  bridge: AgentRuntimeBridge,
  command: {
    name: string
    taskText: string
    scheduleType: 'at' | 'every' | 'cron'
    scheduleExpr: string
    agentId?: string
    activeDays?: string
    activeHourStart?: number
    activeHourEnd?: number
    notifyTargets?: string
  },
): { status: 'ok' | 'error'; job?: { id: string; name: string; scheduleType: 'at' | 'every' | 'cron'; scheduleExpr: string; nextRunAt?: number; intervalMs?: number; enabled: boolean }; message?: string } {
  const name = command.name.trim()
  const taskText = command.taskText.trim()
  const scheduleExpr = command.scheduleExpr.trim()
  if (!name || !taskText || !scheduleExpr) {
    return { status: 'error', message: 'name/taskText/scheduleExpr is required' }
  }

  const now = Date.now()
  const schedule = resolveLocalCronSchedule(command.scheduleType, scheduleExpr, now)
  if (!schedule.ok) return { status: 'error', message: schedule.message }

  const id = `local-cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  bridge.createLocalCronJobRecord({
    id,
    name,
    taskText,
    agentId: command.agentId,
    scheduleType: command.scheduleType,
    scheduleExpr,
    nextRunAt: schedule.nextRunAt,
    intervalMs: schedule.intervalMs,
    enabled: true,
    createdAt: now,
    activeDays: command.activeDays ?? null,
    activeHourStart: command.activeHourStart ?? null,
    activeHourEnd: command.activeHourEnd ?? null,
    notifyTargets: command.notifyTargets ?? null,
  })
  bridge.reloadLocalCronScheduler()

  return {
    status: 'ok',
    job: {
      id,
      name,
      scheduleType: command.scheduleType,
      scheduleExpr,
      nextRunAt: schedule.nextRunAt,
      intervalMs: schedule.intervalMs,
      enabled: true,
    },
  }
}

/**
 * 列出本地 Cron 任务。
 */
function listLocalCronJobs(
  bridge: AgentRuntimeBridge,
  includeDisabled: boolean,
): { status: 'ok'; jobs: Array<{ id: string; name: string; taskText: string; agentId?: string; scheduleType: 'at' | 'every' | 'cron'; scheduleExpr: string; nextRunAt: number; intervalMs?: number; enabled: boolean; createdAt: number; lastRunAt?: number; lastStatus?: 'ok' | 'error' | 'running'; activeDays?: string; activeHourStart?: number; activeHourEnd?: number; notifyTargets?: string }>; total: number } {
  const rows = bridge.listLocalCronJobRecords(includeDisabled)
  return {
    status: 'ok',
    jobs: rows.map((r) => ({
      id: r.id,
      name: r.name,
      taskText: r.task_text,
      agentId: r.agent_id ?? undefined,
      scheduleType: r.schedule_type,
      scheduleExpr: r.schedule_expr,
      nextRunAt: r.next_run_at,
      intervalMs: r.interval_ms ?? undefined,
      enabled: r.enabled === 1,
      createdAt: r.created_at,
      ...(r.last_run_at != null ? { lastRunAt: r.last_run_at } : {}),
      ...(r.last_status != null ? { lastStatus: r.last_status } : {}),
      ...(r.active_days != null ? { activeDays: r.active_days } : {}),
      ...(r.active_hour_start != null ? { activeHourStart: r.active_hour_start } : {}),
      ...(r.active_hour_end != null ? { activeHourEnd: r.active_hour_end } : {}),
      ...(r.notify_targets != null ? { notifyTargets: r.notify_targets } : {}),
    })),
    total: rows.length,
  }
}

/**
 * 删除本地 Cron 任务。
 */
function deleteLocalCronJob(
  bridge: AgentRuntimeBridge,
  id: string,
): { status: 'ok' | 'not_found' | 'error'; id: string; message?: string } {
  const cleanId = id.trim()
  if (!cleanId) return { status: 'error', id, message: 'id is required' }
  const changes = bridge.deleteLocalCronJobRecord(cleanId)
  if (changes > 0) {
    bridge.reloadLocalCronScheduler()
  }
  return { status: changes > 0 ? 'ok' : 'not_found', id: cleanId }
}

/**
 * 更新本地 Cron 任务基础字段（用于启用/禁用、重命名、改提醒文本）。
 */
function updateLocalCronJob(
  bridge: AgentRuntimeBridge,
  id: string,
  patch: {
    enabled?: boolean
    name?: string
    taskText?: string
    agentId?: string | null
    scheduleType?: 'at' | 'every' | 'cron'
    scheduleExpr?: string
    activeDays?: string
    activeHourStart?: number | null
    activeHourEnd?: number | null
    notifyTargets?: string
  },
): { status: 'ok' | 'not_found' | 'error'; id: string; message?: string } {
  const cleanId = id.trim()
  if (!cleanId) return { status: 'error', id, message: 'id is required' }
  const row = bridge.getLocalCronJobRecordById(cleanId)
  if (!row) return { status: 'not_found', id: cleanId }
  const nextName = patch.name?.trim() || row.name
  const nextTaskText = patch.taskText?.trim() || row.task_text
  const nextAgentId = patch.agentId === undefined ? row.agent_id : patch.agentId?.trim() || null
  const nextEnabled = typeof patch.enabled === 'boolean' ? (patch.enabled ? 1 : 0) : row.enabled
  const nextScheduleType = patch.scheduleType ?? row.schedule_type
  const nextScheduleExpr = patch.scheduleExpr?.trim() || row.schedule_expr
  const schedule = resolveLocalCronSchedule(nextScheduleType, nextScheduleExpr, Date.now(), false)
  if (!schedule.ok) return { status: 'error', id: cleanId, message: schedule.message }
  bridge.updateLocalCronJobRecord({
    id: cleanId,
    name: nextName,
    taskText: nextTaskText,
    agentId: nextAgentId ?? undefined,
    enabled: nextEnabled === 1,
    scheduleType: nextScheduleType,
    scheduleExpr: nextScheduleExpr,
    nextRunAt: schedule.nextRunAt,
    intervalMs: schedule.intervalMs,
    // undefined 表示本次 patch 不涉及该字段，沿用旧值
    activeDays: patch.activeDays === undefined ? row.active_days : patch.activeDays,
    activeHourStart: patch.activeHourStart === undefined ? row.active_hour_start : patch.activeHourStart,
    activeHourEnd: patch.activeHourEnd === undefined ? row.active_hour_end : patch.activeHourEnd,
    notifyTargets: patch.notifyTargets === undefined ? row.notify_targets : patch.notifyTargets,
  })
  bridge.reloadLocalCronScheduler()
  return { status: 'ok', id: cleanId }
}

function resolveLocalCronSchedule(
  scheduleType: 'at' | 'every' | 'cron',
  scheduleExpr: string,
  now: number,
  requireFuture = true,
): { ok: true; nextRunAt: number; intervalMs?: number } | { ok: false; message: string } {
  if (scheduleType === 'every') {
    const intervalMs = parseStrictMs(scheduleExpr)
    if (!intervalMs || intervalMs <= 0) {
      return { ok: false, message: 'Invalid scheduleExpr for every' }
    }
    return { ok: true, nextRunAt: now + intervalMs, intervalMs }
  }

  if (scheduleType === 'at') {
    const nextRunAt = parseAtScheduleExprLite(scheduleExpr)
    if (nextRunAt === undefined || (requireFuture && nextRunAt < now)) {
      return { ok: false, message: 'Invalid scheduleExpr for at' }
    }
    return { ok: true, nextRunAt }
  }

  try {
    const next = new Cron(scheduleExpr, { timezone: 'Asia/Shanghai' }).nextRun()
    if (!next) return { ok: false, message: 'Cron expression has no next run' }
    return { ok: true, nextRunAt: next.getTime() }
  } catch {
    return { ok: false, message: 'Invalid scheduleExpr for cron' }
  }
}

/**
 * 立即执行一次本地 Cron 任务（手动触发）。
 * 与自动触发走同一路径：更新状态、驱动 Agent（如配置）、发系统通知。
 */
async function runLocalCronJobNow(
  bridge: AgentRuntimeBridge,
  id: string,
): Promise<{ status: 'ok' | 'not_found' | 'error'; id: string; message?: string }> {
  const cleanId = id.trim()
  if (!cleanId) return { status: 'error', id, message: 'id is required' }
  const row = bridge.getLocalCronJobRecordById(cleanId)
  if (!row) return { status: 'not_found', id: cleanId }
  try {
    await bridge.runCronJobManually(row)
    return { status: 'ok', id: cleanId }
  } catch (err) {
    return { status: 'error', id: cleanId, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 查询本地 Cron 运行历史。
 */
function listLocalCronRuns(
  bridge: AgentRuntimeBridge,
  id: string,
  limit: number,
): { status: 'ok'; entries: Array<{ id: string; status: 'ok' | 'error'; startedAt: number; finishedAt: number; durationMs: number; summary?: string; error?: string }> } {
  const cleanId = id.trim()
  if (!cleanId) return { status: 'ok', entries: [] }
  const rows = bridge.listLocalCronRuns(cleanId, limit)
  return {
    status: 'ok',
    entries: rows.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      summary: r.summary ?? undefined,
      error: r.error ?? undefined,
    })),
  }
}

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
