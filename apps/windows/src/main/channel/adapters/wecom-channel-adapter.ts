/**
 * WecomChannelAdapter — 企业微信 AI Bot（WebSocket）通道适配器
 *
 * 扫码接入后由 WecomLoginService 收消息；本适配器负责路由到 Agent Runtime 并回复。
 * 文本优先；斜杠命令复用跨渠道基础命令（help/new/clear/compact）。
 */

import type { WecomLoginService, WecomNormalizedMessage } from '../../wecom-login-service'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { IChannelAdapter, ChannelSession, ContextStrategy, CommandContext, CommandHandler } from '../types'
import { StatelessContextStrategy } from '../context-strategy/stateless-strategy'
import { SlashCommandRegistry } from '../slash-command-registry'
import { SessionManager } from '../session-manager'
import { AcpBackendManager } from '../acp-backend-manager'
import { clearCommand } from '../slash-commands/clear'
import { createHelpCommand } from '../slash-commands/help'
import { compactCommand } from '../slash-commands/compact'
import { stopCommand } from '../slash-commands/stop'
import {
  getChannelInteractionHub,
  tryHandleChannelOutOfBand,
} from '../channel-interaction-hub'
import {
  CHANNEL_ACK_TEXT,
  buildChannelErrorMessage,
} from '../channel-error-helper'

/**
 * 企微专用 /new：新建 wecom: 前缀会话。
 */
const wecomNewCommand: CommandHandler = {
  description: '新建独立会话',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge } = ctx
    const { channelUserId } = session
    const newSessionKey = `wecom:${channelUserId}:${Date.now()}`
    const newTitle = `企业微信 - ${new Date().toLocaleString('zh-CN')}`
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
  info: (...args: unknown[]) => console.log('[WecomChannelAdapter]', ...args),
  warn: (...args: unknown[]) => console.warn('[WecomChannelAdapter]', ...args),
  error: (...args: unknown[]) => console.error('[WecomChannelAdapter]', ...args),
}

/**
 * 企业微信通道适配器。
 */
export class WecomChannelAdapter implements IChannelAdapter {
  readonly channelType = 'wecom'

  private readonly sessionToInstance = new Map<string, string>()
  private readonly activeSession = new Map<string, string>()
  private readonly userQueues = new Map<string, Promise<void>>()
  private readonly contextStrategy: StatelessContextStrategy
  private readonly registry: SlashCommandRegistry
  private readonly sessionManager: SessionManager
  private readonly acpBackendManager: AcpBackendManager
  private readonly interactionHub: ReturnType<typeof getChannelInteractionHub>

  constructor(
    private readonly wecomLoginService: WecomLoginService,
    private readonly bridge: AgentRuntimeBridge,
  ) {
    this.contextStrategy = new StatelessContextStrategy(bridge)
    this.sessionManager = new SessionManager(bridge)
    this.interactionHub = getChannelInteractionHub(bridge)
    this.acpBackendManager = new AcpBackendManager()
    this.registry = this.buildRegistry()
  }

  /**
   * 向企微用户发送文本回复（通过 WS replyStream）。
   */
  async sendTextReply(session: ChannelSession, text: string): Promise<void> {
    const rawFrame = session.replyContext?.rawFrame
    if (!rawFrame) {
      log.warn(`[sendTextReply] 缺少 rawFrame: channelUserId=${session.channelUserId}`)
      return
    }
    const ok = await this.wecomLoginService.replyText(rawFrame, text)
    if (!ok) {
      log.error(`[sendTextReply] 回复失败: channelUserId=${session.channelUserId}`)
    }
  }

  /**
   * 通知渲染进程有新入站消息。
   */
  notifyIncomingMessage(session: ChannelSession, text: string): void {
    this.bridge.notifyIncomingMessage(session.sessionKey, text)
  }

  /**
   * 导航到对应会话。
   */
  notifyNavigateToSession(session: ChannelSession): void {
    this.bridge.notifyNavigateToSession(session.sessionKey)
  }

  /**
   * 返回上下文策略。
   */
  getContextStrategy(): ContextStrategy {
    return this.contextStrategy
  }

  /**
   * 启动企微消息监听。
   */
  startListening(): void {
    this.wecomLoginService.on('message', (msg: WecomNormalizedMessage) => {
      const userId = msg.channelUserId
      // 插队路径：答复挂起的提问/审批、以及 /stop 打断，都必须绕过 userQueues。
      // 正在运行的那一轮还占着队列，排队等于永远等不到。
      if (this.tryHandleOutOfBand(msg)) return
      const prev = this.userQueues.get(userId) ?? Promise.resolve()
      const next = prev
        .then(() => this.handleMessage(msg))
        .catch((err) => {
          log.error(`[startListening] 消息处理失败: ${err instanceof Error ? err.message : String(err)}`)
        })
      this.userQueues.set(userId, next)
    })
    log.info('[startListening] 企业微信消息监听已启动')
  }

  /** 插队处理提问/审批答复与 /stop（详见 tryHandleChannelOutOfBand） */
  private tryHandleOutOfBand(msg: WecomNormalizedMessage): boolean {
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

  /**
   * 获取当前活跃 sessionKey。
   */
  getActiveSessionKey(channelUserId: string): string {
    const active = this.activeSession.get(channelUserId)
    if (active) return active
    return `wecom:${channelUserId}`
  }

  /**
   * 设置活跃 sessionKey（/new 等命令）。
   */
  setActiveSessionKey(channelUserId: string, sessionKey: string): void {
    this.activeSession.set(channelUserId, sessionKey)
  }

  /**
   * 处理入站文本消息。
   */
  private async handleMessage(msg: WecomNormalizedMessage): Promise<void> {
    const prompt = msg.text?.trim() ?? ''
    if (!prompt) {
      log.info(`[handleMessage] 无文本，跳过 channelUserId=${msg.channelUserId}`)
      return
    }

    const session = this.buildSession(msg)
    log.info(`[handleMessage] sessionKey=${session.sessionKey} promptLen=${prompt.length}`)

    try {
      this.bridge.ensureConversationExists(session.sessionKey, `企业微信 - ${msg.channelUserId}`)

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
          const lines = cmds.map((c) => `${c.cmd} — ${c.description}`)
          await this.sendTextReply(session, `未知命令。可用命令：\n${lines.join('\n')}`)
        }
        return
      }

      // 刷新交互回复上下文：replyContext 是一次性的，必须每轮更新
      this.interactionHub.trackSession(this, session)

      // 斜杠命令之外：先回复即时回执，避免用户发完无响应产生重复发送
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
      try {
        await this.sendTextReply(session, buildChannelErrorMessage(err))
      } catch (replyErr) {
        log.warn(`[handleMessage] 发送错误回传失败: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`)
      }
    }
  }

  /**
   * 构造 ChannelSession。
   */
  private buildSession(msg: WecomNormalizedMessage): ChannelSession {
    const sessionKey = this.getActiveSessionKey(msg.channelUserId)
    return {
      sessionKey,
      channelType: 'wecom',
      channelUserId: msg.channelUserId,
      instanceId: this.sessionToInstance.get(sessionKey) ?? null,
      replyContext: { rawFrame: msg.rawFrame, chatId: msg.chatId, msgId: msg.msgId },
    }
  }

  /**
   * 获取或创建 Agent 实例。
   */
  private async getOrCreateInstance(sessionKey: string): Promise<string> {
    const cachedId = this.sessionToInstance.get(sessionKey)
    if (cachedId) {
      const instances = this.bridge.getInstances()
      if (instances.some((i: { id: string }) => i.id === cachedId)) {
        return cachedId
      }
      this.sessionToInstance.delete(sessionKey)
    }
    const instanceId = await this.bridge.createInstanceById('main', sessionKey, sessionKey)
    this.sessionToInstance.set(sessionKey, instanceId)
    return instanceId
  }

  /**
   * 注册企微可用的基础斜杠命令。
   */
  private buildRegistry(): SlashCommandRegistry {
    const registry = new SlashCommandRegistry()
    registry.register('help', createHelpCommand(registry))
    registry.register('new', wecomNewCommand)
    registry.register('clear', clearCommand)
    registry.register('compact', compactCommand)
    registry.register('stop', stopCommand, ['abort'])
    return registry
  }
}
