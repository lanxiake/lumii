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
import { resumeCommand } from '../slash-commands/resume'
import { linkCommand, unlinkCommand } from '../slash-commands/link'
import { backCommand } from '../slash-commands/back'
import {
  getChannelInteractionHub,
  tryHandleChannelOutOfBand,
} from '../channel-interaction-hub'
import {
  CHANNEL_ACK_TEXT,
  buildChannelErrorMessage,
} from '../channel-error-helper'
import { compileForWecom } from '../format/channel-message-compiler'
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
  /** 会话路由：唯一决策点（进程单例的路由表 + 本渠道的兜底规则） */
  private readonly route: ChannelRouteService
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
    this.route = new ChannelRouteService({
      channelType: 'wecom',
      store: getChannelSessionStore({
        repo: bridge.runtimeStateRepo,
        listRecent: (limit) => bridge.listRecentConversations(limit),
        conversationExists: (id) => Boolean(bridge.conversationRepo.getConversation(id)),
      }),
    })
    this.registry = this.buildRegistry()
    registerChannelAdapter(this)
  }

  /**
   * 向企微用户发送文本回复（通过 WS replyStream，content 原生支持 Markdown；
   * 表格/代码块等不支持语法由编译器降级为文本行）。
   */
  async sendTextReply(session: ChannelSession, text: string): Promise<void> {
    const rawFrame = session.replyContext?.rawFrame
    if (!rawFrame) {
      log.warn(`[sendTextReply] 缺少 rawFrame: channelUserId=${session.channelUserId}`)
      return
    }
    const ok = await this.wecomLoginService.replyText(rawFrame, compileForWecom(text))
    if (!ok) {
      log.error(`[sendTextReply] 回复失败: channelUserId=${session.channelUserId}`)
    }
  }

  /**
   * 向企微用户发送文件回复（P1.2，LoginService.replyMediaFile 封装 upload+reply）。
   */
  async sendFileReply(session: ChannelSession, filePath: string): Promise<void> {
    const rawFrame = session.replyContext?.rawFrame
    if (!rawFrame) {
      log.warn(`[sendFileReply] 缺少 rawFrame: channelUserId=${session.channelUserId}`)
      return
    }
    const ok = await this.wecomLoginService.replyMediaFile(rawFrame, filePath)
    if (!ok) {
      log.error(`[sendFileReply] 回复失败: channelUserId=${session.channelUserId}`)
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

  /** 插队处理提问/审批/接续答复与 /stop（详见 tryHandleChannelOutOfBand） */
  private tryHandleOutOfBand(msg: WecomNormalizedMessage): boolean {
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

  /**
   * 处理入站文本/媒体消息。
   */
  private async handleMessage(msg: WecomNormalizedMessage): Promise<void> {
    const userText = msg.text?.trim() ?? ''
    const pendingKey = makePendingKey('wecom', msg.channelUserId)

    // 判定「有指令」= 有用户文本
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

    // 跨渠道接续提示（§5.4 / 10-S4 方案 A）：**只提示，不扣消息** ——
    // 用户回 1 是下一次发言才生效的事，本条照常处理（旧版会扣住并重放整条消息）。
    // 斜杠命令不问：它是明确的会话操作，不该被打断。
    if (!userText.startsWith('/')) {
      const noticeSession = this.buildSession(msg)
      this.continuity()?.maybeNotice({
        adapter: this,
        session: noticeSession,
        // 该会话正等审批/提问答复时不发接续提示：两套「回复…」不抢同一条消息（10-S5 消歧）
        hasPendingInteraction: this.interactionHub.hasPending(noticeSession.sessionKey),
      })
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
      this.bridge.ensureConversationExists(session.sessionKey, `企业微信 - ${msg.channelUserId}`, this.channelType)

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
      let streamError: string | null = null
      this.bridge.registerNodeStreamCallback(instanceId, (event) => {
        const evt = event as Record<string, unknown>
        if (evt.type === 'message:end') {
          if (typeof evt.fullText === 'string' && evt.fullText.trim()) {
            finalTexts.push(evt.fullText)
          }
          const llmErr = evt.llmError as { message?: unknown } | undefined
          if (llmErr && typeof llmErr.message === 'string' && llmErr.message.trim()) {
            streamError = llmErr.message
          }
        } else if (evt.type === 'agent:end') {
          if (typeof evt.error === 'string' && evt.error.trim()) {
            streamError = evt.error
          }
        } else if (evt.type === 'agent:error') {
          if (typeof evt.error === 'string' && evt.error.trim()) {
            streamError = evt.error
          }
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
      log.warn(`[getOrCreateInstance] 缓存实例已销毁，重建: ${cachedId}`)
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
    // 会话切换与跨渠道接续回退
    registry.register('resume', resumeCommand)
    registry.register('back', backCommand)
    registry.register('link', linkCommand)
    registry.register('unlink', unlinkCommand)
    return registry
  }
}
