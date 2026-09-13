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
import {
  consumeHandoff,
  findLatestHandoffFor,
  isHandoffConfirmText,
} from '../../agent-runtime/handoff-store'
import { getCodingDevConfig, resolveDevContext } from '../../coding-dev-env.js'
import { getAcpRunController } from '../../coding-dev-acp-run.js'
import { DEFAULT_CODING_DEV_BACKEND_ID } from '../../coding-dev-backends-stub/contracts.js'
import { pushAgentRuntimeEvent } from '../../ipc/agent-runtime-ipc.js'
import { resolveContinuityForChannel } from '../cross-channel-continuity'
import { getChannelFeatures } from '../channel-feature-store'
import {
  pendingAttachments,
  makePendingKey,
  ATTACHMENT_HELD_HINT,
  type PendingAttachment,
} from '../pending-attachments'
import {
  getChannelVoiceAsrFailedHint,
  isChannelVoiceAsrFailed,
} from '../channel-voice-asr-hint.js'

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

/** ACP 事件里取文本内容（agent:message:end / controller 的错误提示消息） */
function textOfAcpContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text ?? '')
    .join('')
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
      continuity: this.continuity(),
      onError: (err) =>
        log.error(`[tryHandleOutOfBand] 失败: ${err instanceof Error ? err.message : String(err)}`),
    })
  }

  /** 跨渠道接续状态机（§5.4）；开关每次读，设置页关掉即时生效 */
  private continuity() {
    return resolveContinuityForChannel({
      enabled: getChannelFeatures().crossChannelContinuityEnabled,
      bridge: this.bridge,
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

    const pendingKey = makePendingKey('qbot', msg.channelUserId)

    // 语音 ASR 失败：提示下载 Paraformer / 重说，不把「[语音消息]」交给 Agent
    if (isChannelVoiceAsrFailed(msg.type, msg.text)) {
      const session = this.buildSession(msg)
      log.info(`[handleMessage] 语音 ASR 失败，提示用户 channelUserId=${msg.channelUserId}`)
      await this.sendTextReply(session, getChannelVoiceAsrFailedHint()).catch((err) => {
        log.warn(`[handleMessage] 发送语音 ASR 提示失败: ${err instanceof Error ? err.message : String(err)}`)
      })
      return
    }

    // 判定「有指令」= 有用户文本（语音转录成功也会在 text 里）
    const hasCommand = userText.length > 0

    // 当前消息的附件
    const currentAttachments: PendingAttachment[] = msg.mediaPath
      ? [{ mediaPath: msg.mediaPath, fileName: msg.fileName, at: Date.now() }]
      : []

    if (!hasCommand && currentAttachments.length === 0) {
      log.info(`[handleMessage] 无文本/媒体，跳过 channelUserId=${msg.channelUserId}`)
      return
    }

    // 纯附件消息：挂起并提醒
    if (!hasCommand) {
      const isFirstOfBatch = pendingAttachments.add(pendingKey, currentAttachments)
      log.info(
        `[handleMessage] 纯附件消息已挂起 channelUserId=${msg.channelUserId} count=${pendingAttachments.count(pendingKey)}`,
      )
      if (isFirstOfBatch) {
        const session = this.buildSession(msg)
        await this.sendTextReply(session, ATTACHMENT_HELD_HINT).catch((err) => {
          log.warn(`[handleMessage] 发送附件提醒失败: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
      return
    }

    // 跨渠道接续询问（§5.4）：必须在 drain 之前扣住整条消息，
    // 否则挂起附件已被取走，重放时只剩文本，附件丢失。
    // 斜杠命令不问：它是明确的会话操作，不该被接续打断。
    if (!userText.startsWith('/')) {
      const asked = this.continuity()?.maybeAsk({
        adapter: this,
        session: this.buildSession(msg),
        replay: () => void this.handleMessage(msg),
      })
      if (asked) return
    }

    // 有指令：取出挂起的附件合并
    const pending = pendingAttachments.drain(pendingKey)
    const allMediaLines = [...pending, ...currentAttachments].map(
      (a) => `[media attached: ${a.mediaPath}${a.fileName ? ` (${a.fileName})` : ''}]`,
    )
    const parts: string[] = [userText, ...allMediaLines]
    const prompt = parts.join('\n')

    if (pending.length > 0) {
      log.info(`[handleMessage] 合并 ${pending.length} 个挂起附件 channelUserId=${msg.channelUserId}`)
    }

    const session = this.buildSession(msg)
    log.info(`[handleMessage] sessionKey=${session.sessionKey} type=${msg.type} promptLen=${prompt.length}`)

    try {
      // 转交确认（F3）：主助手提出过待确认的转交提案，本条即确认回复——
      // 必须在普通消息处理之前拦截，否则「1」会被当成新需求发给主助手。
      if (await this.tryConsumeHandoffConfirm(msg, session, userText)) return

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

  /**
   * 转交确认（F3）：主助手在本会话提出过转交提案（10 分钟内）且用户回复确认词 →
   * 消费提案，按开发上下文（含 code-dev 的 Agent 绑定，与桌面 F2 同一套配置）直达 CLI。
   * 返回 true 表示本条消息已消费。
   */
  private async tryConsumeHandoffConfirm(
    msg: QbotNormalizedMessage,
    session: ChannelSession,
    text: string,
  ): Promise<boolean> {
    if (!isHandoffConfirmText(text)) return false
    const handoff = findLatestHandoffFor(session.sessionKey, 10 * 60 * 1000)
    if (!handoff) return false
    consumeHandoff(handoff.id)

    const manualBackend = this.acpBackendManager.getBackend(msg.channelUserId, session.sessionKey)
    const devContext = resolveDevContext({
      appConfig: getCodingDevConfig(),
      accountId: msg.channelUserId,
      sessionKey: session.sessionKey,
      // 以「灵栖开发」的名义解析：命中 code-dev 的 Agent 绑定（与桌面同一套）
      agentId: 'code-dev',
      fallbackBackendId: manualBackend,
    })
    log.info(
      `[tryConsumeHandoffConfirm] 确认转交 handoffId=${handoff.id} backend=${devContext.backendId} source=${devContext.source} cwd=${devContext.projectPath ?? '(无)'}`,
    )

    if (devContext.backendId === DEFAULT_CODING_DEV_BACKEND_ID) {
      await this.sendTextReply(
        session,
        '⚠️ 灵栖开发还没有绑定项目/工具，无法直接执行。请在桌面客户端为「灵栖开发」配置开发绑定（或在本会话 /claude 切换工具）后再发起。',
      ).catch(() => undefined)
      return true
    }

    await this.sendTextReply(
      session,
      `✅ 已确认，交给灵栖开发执行${devContext.projectName ? `（项目：${devContext.projectName}）` : ''}…`,
    ).catch(() => undefined)
    await this.handleAcpPrompt(session, handoff.task, devContext.backendId, devContext.projectPath)
    return true
  }

  /**
   * ACP 直达路径（F3）：startRun + 事件回执。
   * 工具进度与完成结果按渠道习惯以短消息回 QQ；事件同时转发渲染进程（客户端对话页可见完整过程）。
   */
  private async handleAcpPrompt(
    session: ChannelSession,
    prompt: string,
    backendId: string,
    cwd?: string,
  ): Promise<void> {
    log.info(`[handleAcpPrompt] 走 ACP 路径: backendId=${backendId} sessionKey=${session.sessionKey}`)
    const runId = `qbot-acp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
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
      cwd,
      pushEvent: (event) => {
        pushAgentRuntimeEvent(event)
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
          finalText = textOfAcpContent(event.content)
          return
        }
        if (event.type === 'conversation:message:new' && event.message.role === 'assistant') {
          errorText = textOfAcpContent(event.message.content)
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
      log.warn(`[getOrCreateInstance] 缓存实例已销毁，重建: ${cachedId}`)
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
