/**
 * FeishuChannelAdapter — 飞书（WebSocket）通道适配器
 *
 * 扫码接入后由 FeishuLoginService 收消息；路由到 Agent Runtime 后 reply/create 回复。
 */

import type { FeishuLoginService, FeishuNormalizedMessage } from '../../feishu-login-service'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type {
  IChannelAdapter,
  ChannelSession,
  ContextStrategy,
  CommandContext,
  CommandHandler,
} from '../types'
import { StatelessContextStrategy } from '../context-strategy/stateless-strategy'
import { SlashCommandRegistry } from '../slash-command-registry'
import { SessionManager } from '../session-manager'
import { AcpBackendManager } from '../acp-backend-manager'
import { clearCommand } from '../slash-commands/clear'
import { createHelpCommand } from '../slash-commands/help'
import { compactCommand } from '../slash-commands/compact'
import { backendCommand } from '../slash-commands/backend'
import { createSwitchBackendCommand, lumiiCommand } from '../slash-commands/switch-backend'
import { runCodingDevAcpPrompt } from '../../coding-dev-backends-stub/run-coding-dev-acp-prompt.js'
import { resolveAcpTimeoutMs } from '../../coding-dev-backends-stub/acp-config.js'

/**
 * 飞书专用 /new。
 */
const feishuNewCommand: CommandHandler = {
  description: '新建独立会话',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge } = ctx
    const { channelUserId } = session
    const newSessionKey = `feishu:${channelUserId}:${Date.now()}`
    const newTitle = `飞书 - ${new Date().toLocaleString('zh-CN')}`
    bridge.ensureConversationExists(newSessionKey, newTitle)
    adapter.setActiveSessionKey?.(channelUserId, newSessionKey)
    bridge.notifyNavigateToSession(newSessionKey, newTitle)
    bridge.notifyIncomingMessage(newSessionKey, '/new')
    await adapter.sendTextReply(
      { ...session, sessionKey: newSessionKey, instanceId: null },
      `✅ 已新建对话。\n会话ID: ${newSessionKey.slice(-8)}`,
    )
  },
}

const log = {
  info: (...args: unknown[]) => console.log('[FeishuChannelAdapter]', ...args),
  warn: (...args: unknown[]) => console.warn('[FeishuChannelAdapter]', ...args),
  error: (...args: unknown[]) => console.error('[FeishuChannelAdapter]', ...args),
}

/**
 * 飞书通道适配器。
 */
export class FeishuChannelAdapter implements IChannelAdapter {
  readonly channelType = 'feishu'

  private readonly sessionToInstance = new Map<string, string>()
  private readonly activeSession = new Map<string, string>()
  private readonly userQueues = new Map<string, Promise<void>>()
  private readonly contextStrategy: StatelessContextStrategy
  private readonly registry: SlashCommandRegistry
  private readonly sessionManager: SessionManager
  private readonly acpBackendManager: AcpBackendManager

  constructor(
    private readonly feishuLoginService: FeishuLoginService,
    private readonly bridge: AgentRuntimeBridge,
  ) {
    this.contextStrategy = new StatelessContextStrategy(bridge)
    this.sessionManager = new SessionManager(bridge)
    this.acpBackendManager = new AcpBackendManager()
    this.registry = this.buildRegistry()
  }

  /**
   * 向飞书用户发送文本回复。
   */
  async sendTextReply(session: ChannelSession, text: string): Promise<void> {
    const msgId = session.replyContext?.msgId as string | undefined
    const chatId = session.replyContext?.chatId as string | undefined
    const chatType = (session.replyContext?.chatType as 'p2p' | 'group') ?? 'p2p'
    if (!msgId || !chatId) {
      log.warn(`[sendTextReply] 缺少 msgId/chatId: channelUserId=${session.channelUserId}`)
      return
    }
    const ok = await this.feishuLoginService.replyText(msgId, chatId, chatType, text)
    if (!ok) {
      log.error(`[sendTextReply] 回复失败: channelUserId=${session.channelUserId}`)
    }
  }

  notifyIncomingMessage(session: ChannelSession, text: string): void {
    this.bridge.notifyIncomingMessage(session.sessionKey, text)
  }

  notifyNavigateToSession(session: ChannelSession): void {
    this.bridge.notifyNavigateToSession(session.sessionKey)
  }

  getContextStrategy(): ContextStrategy {
    return this.contextStrategy
  }

  /**
   * 启动飞书消息监听。
   */
  startListening(): void {
    this.feishuLoginService.on('message', (msg: FeishuNormalizedMessage) => {
      const userId = msg.channelUserId
      const prev = this.userQueues.get(userId) ?? Promise.resolve()
      const next = prev
        .then(() => this.handleMessage(msg))
        .catch((err) => {
          log.error(`[startListening] 失败: ${err instanceof Error ? err.message : String(err)}`)
        })
      this.userQueues.set(userId, next)
    })
    log.info('[startListening] 飞书消息监听已启动')
  }

  getActiveSessionKey(channelUserId: string): string {
    return this.activeSession.get(channelUserId) ?? `feishu:${channelUserId}`
  }

  setActiveSessionKey(channelUserId: string, sessionKey: string): void {
    this.activeSession.set(channelUserId, sessionKey)
  }

  /**
   * 处理入站文本。
   */
  private async handleMessage(msg: FeishuNormalizedMessage): Promise<void> {
    const prompt = msg.text?.trim() ?? ''
    if (!prompt) return

    const session = this.buildSession(msg)
    log.info(`[handleMessage] sessionKey=${session.sessionKey} len=${prompt.length}`)

    try {
      this.bridge.ensureConversationExists(session.sessionKey, `飞书 - ${msg.channelUserId}`)

      if (prompt.startsWith('/')) {
        const args = SlashCommandRegistry.parseArgs(prompt)
        const cmdCtx: CommandContext = {
          session,
          adapter: this,
          bridge: this.bridge,
          acpBackendManager: this.acpBackendManager,
          args,
        }
        const handled = await this.registry.execute(cmdCtx, prompt)
        if (!handled) {
          const cmds = this.registry.listCommands()
          await this.sendTextReply(
            session,
            `未知命令。可用命令：\n${cmds.map((c) => `${c.cmd} — ${c.description}`).join('\n')}`,
          )
        }
        return
      }

      this.bridge.notifyIncomingMessage(session.sessionKey, prompt)
      this.bridge.notifyNavigateToSession(session.sessionKey)

      // 非主代理后端：走本机 ACP 子进程路径
      const currentBackend = this.acpBackendManager.getBackend(msg.channelUserId, session.sessionKey)
      if (currentBackend !== 'openclaw') {
        await this.handleAcpPrompt(session, prompt, currentBackend)
        return
      }

      const instanceId = await this.getOrCreateInstance(session.sessionKey)
      const activeSession = { ...session, instanceId }

      try {
        this.bridge.conversationRepo.saveMessage({
          conversationId: session.sessionKey,
          role: 'user',
          contentJson: { type: 'text', text: prompt },
        })
      } catch (err) {
        log.error(`[handleMessage] 持久化失败: ${err instanceof Error ? err.message : String(err)}`)
      }

      const finalTexts: string[] = []
      this.bridge.registerNodeStreamCallback(instanceId, (event) => {
        const evt = event as Record<string, unknown>
        if (evt.type === 'message:end' && typeof evt.fullText === 'string') {
          finalTexts.push(evt.fullText)
        }
      })

      try {
        await this.sessionManager.prompt({
          instanceId,
          sessionKey: session.sessionKey,
          message: prompt,
          strategy: this.contextStrategy,
          adapter: this,
          session: activeSession,
        })
      } finally {
        this.bridge.unregisterNodeStreamCallback(instanceId)
      }

      const replyText = finalTexts.join('\n').trim()
      if (replyText && replyText !== 'NO_REPLY') {
        await this.sendTextReply(activeSession, replyText)
      }
    } catch (err) {
      log.error(`[handleMessage] 异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * ACP 子进程路径：通过 emitProgress 推送工具进度，超时可配置。
   * 工具执行状态以短消息推送，最终结果一次性回复。
   */
  private async handleAcpPrompt(
    session: ChannelSession,
    prompt: string,
    backendId: string,
  ): Promise<void> {
    log.info(`[handleAcpPrompt] 走 ACP 路径: backendId=${backendId} sessionKey=${session.sessionKey}`)

    const abortController = new AbortController()
    const timeoutMs = resolveAcpTimeoutMs()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let timedOut = false

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        abortController.abort()
      }, timeoutMs)
    }

    const startedAt = Date.now()
    const sentToolNames = new Set<string>()
    const ACP_STATUS_THROTTLE_MS = 3000
    let lastStatusSentAt = 0

    try {
      const output = await runCodingDevAcpPrompt({
        backendId,
        text: prompt,
        accountId: session.channelUserId,
        peerId: session.sessionKey,
        senderId: session.channelUserId,
        emitProgress: async (progress) => {
          if (abortController.signal.aborted) {
            return
          }
          if (progress.kind === "tool" && progress.tool) {
            const { toolName, phase } = progress.tool
            if (phase === "start" && !sentToolNames.has(progress.tool.toolCallId)) {
              sentToolNames.add(progress.tool.toolCallId)
              await this.sendTextReply(session, `🔧 执行中：${toolName || "工具"}`)
            }
          }
          const now = Date.now()
          if (now - lastStatusSentAt > ACP_STATUS_THROTTLE_MS && progress.kind === "status") {
            lastStatusSentAt = now
            await this.sendTextReply(session, "💭 思考中…")
          }
        },
        abortSignal: abortController.signal,
      })

      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
      if (timedOut) {
        return
      }

      const replyText = output?.text?.trim() ?? ''
      log.info(`[handleAcpPrompt] ACP 完成，回复长度=${replyText.length}`)
      if (replyText) {
        await this.sendTextReply(session, replyText)
      } else {
        await this.sendTextReply(session, "✅ ACP 任务完成（无文本输出）。")
      }
    } catch (err) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
      if (abortController.signal.aborted) {
        const reason = timedOut ? "超时" : "已取消"
        const waitedMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
        const timeoutHint = timedOut
          ? `\n若任务较重，可设置 MTBOT_ACP_TIMEOUT_MS=0 取消限制，或拆分任务后重试。`
          : ""
        await this.sendTextReply(session, `❌ ACP 执行${reason}（已等待 ${waitedMinutes} 分钟）。${timeoutHint}`)
      } else {
        log.error(`[handleAcpPrompt] ACP 执行失败: ${err instanceof Error ? err.message : String(err)}`)
        await this.sendTextReply(session, `❌ ACP 执行失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private buildSession(msg: FeishuNormalizedMessage): ChannelSession {
    const sessionKey = this.getActiveSessionKey(msg.channelUserId)
    return {
      sessionKey,
      channelType: 'feishu',
      channelUserId: msg.channelUserId,
      instanceId: this.sessionToInstance.get(sessionKey) ?? null,
      replyContext: {
        msgId: msg.msgId,
        chatId: msg.chatId,
        chatType: msg.chatType,
      },
    }
  }

  private async getOrCreateInstance(sessionKey: string): Promise<string> {
    const cachedId = this.sessionToInstance.get(sessionKey)
    if (cachedId) {
      const instances = this.bridge.getInstances()
      if (instances.some((i: { id: string }) => i.id === cachedId)) return cachedId
      this.sessionToInstance.delete(sessionKey)
    }
    const instanceId = await this.bridge.createInstanceById('main', sessionKey, sessionKey)
    this.sessionToInstance.set(sessionKey, instanceId)
    return instanceId
  }

  private buildRegistry(): SlashCommandRegistry {
    const registry = new SlashCommandRegistry()
    registry.register('help', createHelpCommand(registry))
    registry.register('new', feishuNewCommand)
    registry.register('clear', clearCommand)
    registry.register('compact', compactCommand)
    // ACP 后端查看/切回主代理
    registry.register('backend', backendCommand)
    registry.register('lumii', lumiiCommand)
    // ACP 后端切换（含别名）
    const claudeCmd = createSwitchBackendCommand('claude')
    registry.register('claude', claudeCmd)
    registry.register('claude-code', claudeCmd)       // 别名
    registry.register('codex', createSwitchBackendCommand('codex'))
    registry.register('opencode', createSwitchBackendCommand('opencode'))
    registry.register('gemini', createSwitchBackendCommand('gemini'))
    registry.register('qoder', createSwitchBackendCommand('qoder'))
    registry.register('qwen', createSwitchBackendCommand('qwen'))
    registry.register('kimi', createSwitchBackendCommand('kimi'))
    registry.register('copilot', createSwitchBackendCommand('copilot'))
    registry.register('auggie', createSwitchBackendCommand('auggie'))
    registry.register('cursor', createSwitchBackendCommand('cursor'))
    return registry
  }
}
