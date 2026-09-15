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
import { resumeCommand } from '../slash-commands/resume'
import { linkCommand, unlinkCommand } from '../slash-commands/link'
import { backCommand } from '../slash-commands/back'
import { AcpBackendManager } from '../acp-backend-manager'
import {
  getChannelInteractionHub,
  tryHandleChannelOutOfBand,
} from '../channel-interaction-hub'
import {
  CHANNEL_ACK_TEXT,
  buildChannelErrorMessage,
} from '../channel-error-helper'
import {
  consumeHandoff,
  findLatestHandoffFor,
  isHandoffConfirmText,
} from '../../agent-runtime/handoff-store'
import { getCodingDevConfig, resolveDevContext } from '../../coding-dev-env.js'
import { DEFAULT_CODING_DEV_BACKEND_ID } from '../../coding-dev-backends-stub/contracts.js'
import {
  NO_CLI_BINDING_HINT,
  formatHandoffReport,
  runDevHandoff,
} from '../../ipc/agent-runtime/dev-handoff-executor'
import { resolveContinuityForChannel } from '../cross-channel-continuity'
import { getChannelSessionStore, type RouteSource } from '../channel-session-store'
import { ChannelRouteService } from '../channel-route'
import { registerChannelAdapter } from '../channel-adapter-registry'
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
    bridge.ensureConversationExists(newSessionKey, newTitle, adapter.channelType)
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
  /** 会话路由：唯一决策点（进程单例的路由表 + 本渠道的兜底规则） */
  private readonly route: ChannelRouteService
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
    this.route = new ChannelRouteService({
      channelType: 'qbot',
      store: getChannelSessionStore({
        repo: bridge.runtimeStateRepo,
        listRecent: (limit) => bridge.listRecentConversations(limit),
        conversationExists: (id) => Boolean(bridge.conversationRepo.getConversation(id)),
      }),
    })
    this.registry = this.buildRegistry()
    registerChannelAdapter(this)
  }

  async sendTextReply(session: ChannelSession, text: string): Promise<void> {
    const chatId = session.replyContext?.chatId as string | undefined
    if (!chatId) {
      log.warn(`[sendTextReply] 缺少 chatId: channelUserId=${session.channelUserId}`)
      return
    }
    // Markdown 由登录层编译为单条；平台未开通时自动降级纯文本
    const ok = await this.qbotLoginService.replyMarkdown(chatId, text)
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

  /** 当前活跃 sessionKey（路由表 > /link 绑定 > 渠道默认；决策在 ChannelRouteService） */
  getActiveSessionKey(channelUserId: string): string {
    return this.route.activeKey(channelUserId)
  }

  /** 切换路由（由 /new、/resume 命令与跨渠道接续调用；来源用于 /back 与诊断） */
  setActiveSessionKey(
    channelUserId: string,
    sessionKey: string,
    source: RouteSource = 'own',
  ): void {
    this.route.setActive(channelUserId, sessionKey, source)
  }

  /** 回到本渠道自己的会话（跨渠道接续被拒、/back、/unlink 调用） */
  resetToChannelSession(channelUserId: string): string {
    return this.route.resetToOwn(channelUserId)
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

      this.bridge.ensureConversationExists(session.sessionKey, `QQ - ${msg.channelUserId}`, this.channelType)

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
      sessionKey: session.sessionKey,
      // 以「灵栖开发」的名义解析：命中 code-dev 的 Agent 绑定（与桌面同一套）
      agentId: 'code-dev',
      fallbackBackendId: manualBackend,
    })
    log.info(
      `[tryConsumeHandoffConfirm] 确认转交 handoffId=${handoff.id} backend=${devContext.backendId} source=${devContext.source} cwd=${devContext.projectPath ?? '(无)'}`,
    )

    if (devContext.backendId === DEFAULT_CODING_DEV_BACKEND_ID) {
      await this.sendTextReply(session, NO_CLI_BINDING_HINT).catch(() => undefined)
      return true
    }

    // 提案指定的项目优先于渠道会话自身的 /project 选择（主助手已确认项目归属）
    const effectiveProjectName = handoff.projectName ?? devContext.projectName

    await this.sendTextReply(
      session,
      `✅ 已确认，交给灵栖开发执行${effectiveProjectName ? `（项目：${effectiveProjectName}）` : ''}…`,
    ).catch(() => undefined)

    // 执行空间 = 灵栖开发的开发会话（新建/复用最近）；完成后异步把结果汇报回本会话
    try {
      await runDevHandoff({
        bridge: this.bridge,
        task: handoff.task,
        sessionMode: handoff.sessionMode,
        title: handoff.summary,
        ...(handoff.projectName ? { projectName: handoff.projectName } : {}),
        report: (payload) =>
          this.sendTextReply(session, formatHandoffReport(handoff.summary, payload)).catch((err) => {
            log.warn(
              `[tryConsumeHandoffConfirm] 完成汇报失败: ${err instanceof Error ? err.message : String(err)}`,
            )
          }),
      })
    } catch (err) {
      await this.sendTextReply(
        session,
        `❌ 转交发起失败：${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => undefined)
    }
    return true
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
    // 会话切换与跨渠道接续回退
    registry.register('resume', resumeCommand)
    registry.register('back', backCommand)
    registry.register('link', linkCommand)
    registry.register('unlink', unlinkCommand)
    return registry
  }
}
