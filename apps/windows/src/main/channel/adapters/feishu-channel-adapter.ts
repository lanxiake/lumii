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
import { getAcpRunController } from '../../coding-dev-acp-run.js'
import { DEFAULT_CODING_DEV_BACKEND_ID } from '../../coding-dev-backends-stub/contracts.js'
import { pushAgentRuntimeEvent } from '../../ipc/agent-runtime-ipc.js'
import {
  CHANNEL_ACK_TEXT,
  buildChannelErrorMessage,
} from '../channel-error-helper'

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

/** 取消息内容块里的纯文本（忽略图片等非文本块） */
function textOfContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('')
    .trim()
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
          sessionManager: this.sessionManager,
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

      // 斜杠命令之外：先回复即时回执，避免用户发完无响应产生重复发送
      await this.sendTextReply(session, CHANNEL_ACK_TEXT).catch((err) => {
        log.warn(`[handleMessage] 发送即时回执失败: ${err instanceof Error ? err.message : String(err)}`)
      })

      this.bridge.notifyIncomingMessage(session.sessionKey, prompt)
      this.bridge.notifyNavigateToSession(session.sessionKey)

      // 非主代理后端：走本机 ACP 子进程路径
      const currentBackend = this.acpBackendManager.getBackend(msg.channelUserId, session.sessionKey)
      if (currentBackend !== DEFAULT_CODING_DEV_BACKEND_ID) {
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
      try {
        await this.sendTextReply(session, buildChannelErrorMessage(err))
      } catch (replyErr) {
        log.warn(`[handleMessage] 发送错误回传失败: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`)
      }
    }
  }

  /**
   * ACP 子进程路径：走 AcpRunController，与客户端自发消息共用同一套运行时。
   *
   * 这样渠道会话的工具调用/流式回复会同步渲染到客户端对话页，并持久化到 DB；
   * 飞书侧仍按渠道习惯只推「执行中」短消息 + 最终结果，避免刷屏。
   */
  private async handleAcpPrompt(
    session: ChannelSession,
    prompt: string,
    backendId: string,
  ): Promise<void> {
    log.info(`[handleAcpPrompt] 走 ACP 路径: backendId=${backendId} sessionKey=${session.sessionKey}`)

    const runId = `feishu-acp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const sentToolIds = new Set<string>()
    const ACP_STATUS_THROTTLE_MS = 3000
    let lastStatusSentAt = 0
    let finalText = ''
    let errorText = ''

    await getAcpRunController().startRun({
      runId,
      sessionKey: session.sessionKey,
      backendId,
      text: prompt,
      instanceId: session.instanceId ?? session.sessionKey,
      bridge: this.bridge,
      accountId: session.channelUserId,
      senderId: session.channelUserId,
      pushEvent: (event) => {
        // 先转发给渲染进程，客户端对话页由此渲染工具卡片与流式文本
        pushAgentRuntimeEvent(event)

        // 再按渠道习惯挑重点回飞书
        if (event.type === 'agent:tool:start' && !sentToolIds.has(event.toolCallId)) {
          sentToolIds.add(event.toolCallId)
          void this.sendTextReply(session, `🔧 执行中：${event.toolName || '工具'}`)
          return
        }
        if (event.type === 'agent:thinking:delta') {
          const now = Date.now()
          if (now - lastStatusSentAt > ACP_STATUS_THROTTLE_MS) {
            lastStatusSentAt = now
            void this.sendTextReply(session, '💭 思考中…')
          }
          return
        }
        if (event.type === 'agent:message:end') {
          finalText = textOfContent(event.content)
          return
        }
        // controller 中止/失败时会推一条带用户可读文案的助手消息，直接复用
        if (event.type === 'conversation:message:new' && event.message.role === 'assistant') {
          errorText = textOfContent(event.message.content)
        }
      },
    })

    if (errorText) {
      await this.sendTextReply(session, errorText)
      return
    }
    log.info(`[handleAcpPrompt] ACP 完成，回复长度=${finalText.length}`)
    await this.sendTextReply(session, finalText || '✅ ACP 任务完成（无文本输出）。')
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
    registry.register('cursor', createSwitchBackendCommand('cursor'))
    return registry
  }
}
