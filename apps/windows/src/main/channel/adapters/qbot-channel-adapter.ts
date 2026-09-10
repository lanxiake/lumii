/**
 * QbotChannelAdapter — QQ 机器人（Gateway WS）通道适配器。
 *
 * 照 wecom-channel-adapter 骨架：StatelessContextStrategy + 基础斜杠命令 + userQueues 串行。
 */

import type { QbotLoginService, QbotNormalizedMessage } from '../../qbot-login-service'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { IChannelAdapter, ChannelSession, ContextStrategy, CommandContext, CommandHandler } from '../types'
import { StatelessContextStrategy } from '../context-strategy/stateless-strategy'
import { SlashCommandRegistry } from '../slash-command-registry'
import { SessionManager } from '../session-manager'
import { clearCommand } from '../slash-commands/clear'
import { createHelpCommand } from '../slash-commands/help'
import { compactCommand } from '../slash-commands/compact'
import { stopCommand } from '../slash-commands/stop'
import { AcpBackendManager } from '../acp-backend-manager'
import {
  getChannelInteractionHub,
  tryHandleChannelOutOfBand,
} from '../channel-interaction-hub'
import {
  CHANNEL_ACK_TEXT,
  buildChannelErrorMessage,
} from '../channel-error-helper'
import { markdownToPlainText } from '../../agent-runtime/cron-notify-format.js'

const qbotNewCommand: CommandHandler = {
  description: '新建独立会话',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge } = ctx
    const { channelUserId } = session
    const newSessionKey = `qbot:${channelUserId}:${Date.now()}`
    const newTitle = `QQ - ${new Date().toLocaleString('zh-CN')}`
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
  info: (...args: unknown[]) => console.log('[QbotChannelAdapter]', ...args),
  warn: (...args: unknown[]) => console.warn('[QbotChannelAdapter]', ...args),
  error: (...args: unknown[]) => console.error('[QbotChannelAdapter]', ...args),
}

export class QbotChannelAdapter implements IChannelAdapter {
  readonly channelType = 'qbot'

  private readonly sessionToInstance = new Map<string, string>()
  private readonly activeSession = new Map<string, string>()
  private readonly userQueues = new Map<string, Promise<void>>()
  private readonly contextStrategy: StatelessContextStrategy
  private readonly registry: SlashCommandRegistry
  private readonly sessionManager: SessionManager
  private readonly interactionHub: ReturnType<typeof getChannelInteractionHub>
  private readonly acpBackendManager: AcpBackendManager

  constructor(
    private readonly qbotLoginService: QbotLoginService,
    private readonly bridge: AgentRuntimeBridge,
  ) {
    this.contextStrategy = new StatelessContextStrategy(bridge)
    this.sessionManager = new SessionManager(bridge)
    this.interactionHub = getChannelInteractionHub(bridge)
    this.acpBackendManager = new AcpBackendManager()
    this.registry = this.buildRegistry()
  }

  async sendTextReply(session: ChannelSession, text: string): Promise<void> {
    const chatId = session.replyContext?.chatId as string | undefined
    if (!chatId) {
      log.warn(`[sendTextReply] 缺少 chatId: channelUserId=${session.channelUserId}`)
      return
    }
    const ok = await this.qbotLoginService.replyText(chatId, markdownToPlainText(text))
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

  startListening(): void {
    this.qbotLoginService.on('message', (msg: QbotNormalizedMessage) => {
      const userId = msg.channelUserId
      if (this.tryHandleOutOfBand(msg)) return
      const prev = this.userQueues.get(userId) ?? Promise.resolve()
      const next = prev
        .then(() => this.handleMessage(msg))
        .catch((err) => {
          log.error(`[startListening] 失败: ${err instanceof Error ? err.message : String(err)}`)
        })
      this.userQueues.set(userId, next)
    })
    log.info('[startListening] QQ 消息监听已启动')
  }

  private tryHandleOutOfBand(msg: QbotNormalizedMessage): boolean {
    return tryHandleChannelOutOfBand({
      hub: this.interactionHub,
      bridge: this.bridge,
      adapter: this,
      session: this.buildSession(msg),
      text: msg.text?.trim() ?? '',
      sessionManager: this.sessionManager,
      onError: (err) =>
        log.error(`[tryHandleOutOfBand] 失败: ${err instanceof Error ? err.message : String(err)}`),
    })
  }

  getActiveSessionKey(channelUserId: string): string {
    return this.activeSession.get(channelUserId) ?? `qbot:${channelUserId}`
  }

  setActiveSessionKey(channelUserId: string, sessionKey: string): void {
    this.activeSession.set(channelUserId, sessionKey)
  }

  private async handleMessage(msg: QbotNormalizedMessage): Promise<void> {
    const userText = msg.text?.trim() ?? ''
    const mediaLine = msg.mediaPath ? `[media attached: ${msg.mediaPath}${msg.fileName ? ` (${msg.fileName})` : ''}]` : ''
    const parts: string[] = []
    if (userText) parts.push(userText)
    if (mediaLine) parts.push(mediaLine)
    if (parts.length === 0) {
      log.info(`[handleMessage] 无文本/媒体，跳过 channelUserId=${msg.channelUserId}`)
      return
    }
    const prompt = parts.join('\n')

    const session = this.buildSession(msg)
    log.info(`[handleMessage] sessionKey=${session.sessionKey} type=${msg.type} promptLen=${prompt.length}`)

    try {
      this.bridge.ensureConversationExists(session.sessionKey, `QQ - ${msg.channelUserId}`)

      if (prompt.startsWith('/')) {
        const args = SlashCommandRegistry.parseArgs(prompt)
        const cmdCtx: CommandContext = {
          session,
          adapter: this,
          bridge: this.bridge,
          acpBackendManager: this.acpBackendManager,
          sessionManager: this.sessionManager,
          args,
        }
        const handled = await this.registry.execute(cmdCtx, prompt)
        if (!handled) {
          const cmds = this.registry.listCommands()
          await this.sendTextReply(session, `未知命令。可用命令：\n${cmds.map((c) => `${c.cmd} — ${c.description}`).join('\n')}`)
        }
        return
      }

      this.interactionHub.trackSession(this, session)

      await this.sendTextReply(session, CHANNEL_ACK_TEXT).catch((err) => {
        log.warn(`[handleMessage] 发送即时回执失败: ${err instanceof Error ? err.message : String(err)}`)
      })

      this.bridge.notifyIncomingMessage(session.sessionKey, prompt)
      this.bridge.notifyNavigateToSession(session.sessionKey)

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
      let streamError: string | null = null
      this.bridge.registerNodeStreamCallback(instanceId, (event) => {
        const evt = event as Record<string, unknown>
        if (evt.type === 'message:end') {
          if (typeof evt.fullText === 'string' && evt.fullText.trim()) finalTexts.push(evt.fullText)
          const llmErr = evt.llmError as { message?: unknown } | undefined
          if (llmErr && typeof llmErr.message === 'string' && llmErr.message.trim()) streamError = llmErr.message
        } else if (evt.type === 'agent:end' || evt.type === 'agent:error') {
          if (typeof evt.error === 'string' && evt.error.trim()) streamError = evt.error
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
      } else if (streamError) {
        await this.sendTextReply(activeSession, buildChannelErrorMessage(streamError))
      }
    } catch (err) {
      log.error(`[handleMessage] 异常: ${err instanceof Error ? err.message : String(err)}`)
      try {
        await this.sendTextReply(session, buildChannelErrorMessage(err))
      } catch (replyErr) {
        log.warn(`[handleMessage] 发送错误回传失败: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`)
      }
    }
  }

  private buildSession(msg: QbotNormalizedMessage): ChannelSession {
    const sessionKey = this.getActiveSessionKey(msg.channelUserId)
    return {
      sessionKey,
      channelType: 'qbot',
      channelUserId: msg.channelUserId,
      instanceId: this.sessionToInstance.get(sessionKey) ?? null,
      replyContext: { chatId: msg.chatId, msgId: msg.msgId, rawEvent: msg.rawEvent },
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
    registry.register('new', qbotNewCommand)
    registry.register('clear', clearCommand)
    registry.register('compact', compactCommand)
    registry.register('stop', stopCommand, ['abort'])
    return registry
  }
}
