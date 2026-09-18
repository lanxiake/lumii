/**
 * WeixinChannelAdapter — 微信通道适配器
 *
 * 封装微信通道的消息收发、会话路由、媒体附件缓存逻辑。
 * 使用 StatelessContextStrategy（每轮前从 DB 恢复，每轮后清空内存）。
 */

import type { WeixinLoginService, WeixinNormalizedMessage } from '../../weixin-login-service'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { IChannelAdapter, ChannelSession, ContextStrategy } from '../types'
import type { WeixinReplyContextStore } from '../weixin-reply-context-store'
import { StatelessContextStrategy } from '../context-strategy/stateless-strategy'
import { SlashCommandRegistry } from '../slash-command-registry'
import { AcpBackendManager } from '../acp-backend-manager'
import { SessionManager } from '../session-manager'
import { WeixinSessionBindingManager } from '../weixin-session-binding'
import { clearCommand } from '../slash-commands/clear'
import { newCommand } from '../slash-commands/new'
import { resumeCommand } from '../slash-commands/resume'
import { createHelpCommand } from '../slash-commands/help'
import { compactCommand } from '../slash-commands/compact'
import { stopCommand } from '../slash-commands/stop'
import {
  getChannelInteractionHub,
  tryHandleChannelOutOfBand,
} from '../channel-interaction-hub'
import { backendCommand } from '../slash-commands/backend'
import { createSwitchBackendCommand, lumiiCommand } from '../slash-commands/switch-backend'
import { projectCommand } from '../slash-commands/project'
import { getCodingDevConfig, resolveDevContext } from '../../coding-dev-env.js'
import { linkCommand, unlinkCommand } from '../slash-commands/link'
import { backCommand } from '../slash-commands/back'
import { runCodingDevAcpPrompt } from '../../coding-dev-backends-stub/run-coding-dev-acp-prompt.js'
import { resolveAcpTimeoutMs } from '../../coding-dev-backends-stub/acp-config.js'
import { DEFAULT_CODING_DEV_BACKEND_ID } from '../../coding-dev-backends-stub/contracts.js'
import {
  CHANNEL_ACK_TEXT,
  buildChannelErrorMessage,
} from '../channel-error-helper'
import {
  extractMediaAttachmentLines,
  isPureMediaMessage,
} from '../../weixin-message-utils.js'
import {
  pendingAttachments,
  makePendingKey,
  ATTACHMENT_HELD_HINT,
  type PendingAttachment,
} from '../pending-attachments'
import { resolveContinuityForChannel } from '../cross-channel-continuity'
import { getChannelSessionStore, type RouteSource } from '../channel-session-store'
import { ChannelRouteService } from '../channel-route'
import { registerChannelAdapter } from '../channel-adapter-registry'
import { getChannelFeatures } from '../channel-feature-store'
import {
  getChannelVoiceAsrFailedHint,
  isWeixinSilkAsrFailed,
} from '../channel-voice-asr-hint.js'

const log = {
  info: (...args: unknown[]) => console.log('[WeixinChannelAdapter]', ...args),
  warn: (...args: unknown[]) => console.warn('[WeixinChannelAdapter]', ...args),
  error: (...args: unknown[]) => console.error('[WeixinChannelAdapter]', ...args),
  debug: (...args: unknown[]) => console.debug('[WeixinChannelAdapter]', ...args),
}

export class WeixinChannelAdapter implements IChannelAdapter {
  readonly channelType = 'weixin'

  /** sessionKey → instanceId */
  private readonly sessionToInstance = new Map<string, string>()
  /** channelUserId → 串行处理队列 */
  private readonly userQueues = new Map<string, Promise<void>>()

  private readonly contextStrategy: StatelessContextStrategy
  private readonly registry: SlashCommandRegistry
  private readonly sessionManager: SessionManager
  readonly bindingManager: WeixinSessionBindingManager
  /** 会话路由：唯一决策点（路由表 > /link 绑定 > 渠道默认；微信是唯一有绑定层的渠道） */
  private readonly route: ChannelRouteService

  /** 入站时 upsert context_token，供 channel_send 伪 Push */
  private replyContextStore: WeixinReplyContextStore | null = null

  private readonly interactionHub: ReturnType<typeof getChannelInteractionHub>

  constructor(
    private readonly weixinLoginService: WeixinLoginService,
    private readonly bridge: AgentRuntimeBridge,
    private readonly acpBackendManager: AcpBackendManager,
    replyContextStore?: WeixinReplyContextStore | null,
  ) {
    this.replyContextStore = replyContextStore ?? null
    this.contextStrategy = new StatelessContextStrategy(bridge)
    this.sessionManager = new SessionManager(bridge)
    this.interactionHub = getChannelInteractionHub(bridge)
    this.bindingManager = new WeixinSessionBindingManager(bridge.runtimeStateRepo)
    this.bindingManager.initialize()
    this.route = new ChannelRouteService({
      channelType: 'weixin',
      store: getChannelSessionStore({
        repo: bridge.runtimeStateRepo,
        listRecent: (limit) => bridge.listRecentConversations(limit),
        conversationExists: (id) => Boolean(bridge.conversationRepo.getConversation(id)),
      }),
      // /link 绑定层：只有微信有（其它渠道传 undefined，走同一段回落代码）
      binding: this.bindingManager,
    })
    this.registry = this.buildRegistry()
    registerChannelAdapter(this)
  }

  /**
   * 绑定/替换微信 reply context 持久化 store（Hub 晚于 adapter 装配时用）。
   */
  setReplyContextStore(store: WeixinReplyContextStore | null): void {
    this.replyContextStore = store
  }

  /**
   * 将入站 context_token 写入 store（不落凭证到 info 日志）。
   */
  private persistReplyContext(msg: WeixinNormalizedMessage): void {
    if (!this.replyContextStore || !msg.contextToken) return
    this.replyContextStore.upsert({
      channelUserId: msg.channelUserId,
      contextToken: msg.contextToken,
      updatedAt: Date.now(),
      ...(msg.botToken ? { botToken: msg.botToken } : {}),
      ...(msg.ilinkBaseUrl ? { ilinkBaseUrl: msg.ilinkBaseUrl } : {}),
      ...(msg.nickname ? { lastNickname: msg.nickname } : {}),
    })
  }

  /**
   * 会话活跃时把默认会话标题刷成用户昵称（与 App 内「微信对话 - id」对齐；
   * 用户 /new 自建的会话也有频道专属标题，不在此处改名）。
   */
  private syncConversationTitleToNickname(msg: WeixinNormalizedMessage): void {
    const nickname = msg.nickname?.trim()
    if (!nickname) return
    const sessionKey = this.getActiveSessionKey(msg.channelUserId)
    const repo = this.bridge.conversationRepo
    const existing = repo?.getConversation(sessionKey)
    if (!existing) return
    const desired = `微信对话 - ${nickname}`
    if (existing.title === desired) return
    repo.updateTitle(sessionKey, desired)
  }

  // ── IChannelAdapter 接口实现 ──────────────────────────────────────────────

  async sendTextReply(session: ChannelSession, text: string): Promise<void> {
    const ctx = session.replyContext as { contextToken?: string; botToken?: string; ilinkBaseUrl?: string } | undefined
    if (!ctx?.contextToken) {
      log.warn(`[sendTextReply] 缺少 contextToken，无法发送回复: channelUserId=${session.channelUserId}`)
      return
    }
    const ok = await this.weixinLoginService.sendTextReply(
      session.channelUserId,
      text,
      ctx.contextToken,
      ctx.botToken,
      ctx.ilinkBaseUrl,
    )
    if (!ok) {
      log.error(`[sendTextReply] 回复发送失败: channelUserId=${session.channelUserId}`)
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

  // ── 消息入口 ──────────────────────────────────────────────────────────────

  /** 启动微信消息监听（在 WeixinLoginService 初始化后调用） */
  startListening(): void {
    this.weixinLoginService.on('message', (msg: WeixinNormalizedMessage) => {
      const userId = msg.channelUserId
      // 入站即落盘 reply context：出站 token 的保鲜只应以「用户发过消息」为准，
      // 不能依赖后续处理路径（斜杠命令/接续提示会提前 return）
      this.persistReplyContext(msg)
      this.syncConversationTitleToNickname(msg)
      // 插队路径：答复挂起的提问/审批、以及 /stop 打断，都必须绕过 userQueues。
      // 正在运行的那一轮还占着队列，排队等于永远等不到。
      if (this.tryHandleOutOfBand(msg)) return
      const prev = this.userQueues.get(userId) ?? Promise.resolve()
      const next = prev.then(() => this.handleMessage(msg)).catch((err) => {
        log.error(`[startListening] 消息处理失败: ${err instanceof Error ? err.message : String(err)}`)
      })
      this.userQueues.set(userId, next)
    })
    log.info('[startListening] 微信消息监听已启动')
  }

  /** 插队处理提问/审批/接续答复与 /stop（详见 tryHandleChannelOutOfBand） */
  private tryHandleOutOfBand(msg: WeixinNormalizedMessage): boolean {
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

  // ── 内部消息处理 ──────────────────────────────────────────────────────────

  private async handleMessage(msg: WeixinNormalizedMessage): Promise<void> {
    const rawText = msg.text?.trim() ?? ''
    if (!rawText) {
      log.info(`[handleMessage] 消息无文本内容，跳过 channelUserId=${msg.channelUserId}`)
      return
    }

    const pendingKey = makePendingKey('weixin', msg.channelUserId)

    // 微信特殊：媒体行已在 login-service 并入 text，要拆回来
    const mediaLines = extractMediaAttachmentLines(rawText)
    const userTextOnly = rawText
      .split('\n')
      .filter((l) => !/^\[media attached:/.test(l.trim()) && !/^\[语音转录:/.test(l.trim()))
      .join('\n')
      .trim()

    // 语音转录文字（hasUserText=true 时才有意义）
    const transcriptMatch = rawText.match(/\[语音转录:\s*([^\]]+)\]/)
    const transcript = transcriptMatch?.[1]?.trim() ?? ''

    // 判定「有指令」= msg.hasUserText（这才是真实判空，避开媒体行干扰）
    const hasCommand = msg.hasUserText === true

    // 当前消息的附件（排除 .silk，Agent 读不了）
    const currentAttachments: PendingAttachment[] = mediaLines
      .filter((l) => !/^\[media attached: [^\]]*\.silk(?:\s*\([^)]*\))?\]$/.test(l.trim()))
      .map((line) => {
        const pathMatch = line.match(/\[media attached:\s*([^\]()]+)/)
        const fileMatch = line.match(/\(([^)]+)\)\]$/)
        return {
          mediaPath: pathMatch?.[1]?.trim() ?? '',
          fileName: fileMatch?.[1],
          at: Date.now(),
        }
      })
      .filter((a) => a.mediaPath)

    // SILK 语音 ASR 失败：提示下载 Paraformer / 重说（可同时挂起其它附件）
    if (
      isWeixinSilkAsrFailed({
        mediaLines,
        transcript,
        hasUserText: hasCommand,
      })
    ) {
      const session = this.buildSession(msg)
      log.info(`[handleMessage] 语音 ASR 失败，提示用户 channelUserId=${msg.channelUserId}`)
      this.bridge.ensureConversationExists(session.sessionKey, `微信对话 - ${msg.channelUserId}`, this.channelType)
      this.bridge.notifyIncomingMessage(session.sessionKey, rawText)
      this.bridge.notifyNavigateToSession(session.sessionKey)
      if (currentAttachments.length > 0) {
        pendingAttachments.add(pendingKey, currentAttachments)
      }
      await this.sendTextReply(session, getChannelVoiceAsrFailedHint()).catch((err) => {
        log.warn(`[handleMessage] 发送语音 ASR 提示失败: ${err instanceof Error ? err.message : String(err)}`)
      })
      return
    }

    if (!hasCommand && currentAttachments.length === 0) {
      log.info(`[handleMessage] 无指令/附件，跳过 channelUserId=${msg.channelUserId}`)
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
        // 通知渲染进程展示用户消息，避免对话断层
        this.bridge.ensureConversationExists(session.sessionKey, `微信对话 - ${msg.channelUserId}`, this.channelType)
        this.bridge.notifyIncomingMessage(session.sessionKey, rawText)
        this.bridge.notifyNavigateToSession(session.sessionKey)
        await this.sendTextReply(session, ATTACHMENT_HELD_HINT).catch((err) => {
          log.warn(`[handleMessage] 发送附件提醒失败: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
      return
    }

    // 跨渠道接续提示（§5.4 / 10-S4 方案 A）：**只提示，不扣消息** ——
    // 用户回 1 是下一次发言才生效的事，本条照常处理（旧版会扣住并重放整条消息）。
    // 斜杠命令不问：它是明确的会话操作，不该被打断。
    // 接续只改路由，不写 bindingManager（那是 /link 的显式绑定）。
    if (!userTextOnly.startsWith('/')) {
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
    // 指令部分 = 用户纯文本 + 语音转录（如果有）
    const commandParts: string[] = []
    if (userTextOnly) commandParts.push(userTextOnly)
    if (transcript) commandParts.push(`[语音转录: ${transcript}]`)
    const prompt = [...commandParts, ...allMediaLines].join('\n')

    if (pending.length > 0) {
      log.info(`[handleMessage] 合并 ${pending.length} 个挂起附件 channelUserId=${msg.channelUserId}`)
    }

    const session = this.buildSession(msg)
    log.info(`[handleMessage] 开始处理消息: sessionKey=${session.sessionKey} promptLen=${prompt.length}`)

    try {      this.bridge.ensureConversationExists(session.sessionKey, `微信对话 - ${msg.channelUserId}`, this.channelType)

      // 斜杠命令处理
      if (prompt.startsWith('/')) {
        const args = SlashCommandRegistry.parseArgs(prompt)
        const cmdCtx = {
          session,
          adapter: this as IChannelAdapter,
          bridge: this.bridge,
          acpBackendManager: this.acpBackendManager,
          bindingManager: this.bindingManager,
          sessionManager: this.sessionManager,
          args,
        }
        const handled = await this.registry.execute(cmdCtx, prompt)
        if (!handled) {
          const cmds = this.registry.listCommands()
          const lines = cmds.map((c: { cmd: string; description: string }) => `${c.cmd} — ${c.description}`)
          await this.sendTextReply(session, `未知命令。可用命令：\n${lines.join('\n')}`)
        }
        return
      }

      // 刷新交互回复上下文：replyContext 是一次性的，必须每轮更新
      this.interactionHub.trackSession(this, session)

      // 非斜杠命令：先回复即时回执，避免用户发完无响应产生重复发送
      await this.sendTextReply(session, CHANNEL_ACK_TEXT).catch((err) => {
        log.warn(`[handleMessage] 发送即时回执失败: ${err instanceof Error ? err.message : String(err)}`)
      })

      // 普通消息：推送到渲染进程
      this.bridge.notifyIncomingMessage(session.sessionKey, prompt)
      this.bridge.notifyNavigateToSession(session.sessionKey)

      // 检查当前后端：会话开发上下文（项目/工具）> peer 级后端选择；非主代理走 ACP 子进程路径
      const manualBackend = this.acpBackendManager.getBackend(msg.channelUserId, session.sessionKey)
      const devContext = resolveDevContext({
        appConfig: getCodingDevConfig(),
        sessionKey: session.sessionKey,
        fallbackBackendId: manualBackend,
      })
      const currentBackend = devContext.backendId
      if (currentBackend !== DEFAULT_CODING_DEV_BACKEND_ID) {
        try {
          await this.handleAcpPrompt(msg, session, prompt, currentBackend, devContext.projectPath)
        } catch (err) {
          log.error(`[handleMessage] ACP 处理异常: ${err instanceof Error ? err.message : String(err)}`)
          try {
            await this.sendTextReply(session, buildChannelErrorMessage(err))
          } catch (replyErr) {
            log.warn(`[handleMessage] 发送 ACP 错误回传失败: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`)
          }
        }
        return
      }

      // 主代理：走原有 bridge.prompt() 路径
      const instanceId = await this.getOrCreateInstance(session.sessionKey)
      const sessionWithInstance = { ...session, instanceId }

      // 持久化用户消息
      try {
        this.bridge.conversationRepo.saveMessage({
          conversationId: session.sessionKey,
          role: 'user',
          contentJson: { type: 'text', text: prompt },
        })
      } catch (err) {
        log.error(`[handleMessage] 持久化用户消息失败: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 收集 Agent 输出 + 捕获错误信号（模型未配置/Key 失效等不抛异常，而是以事件收尾）
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

      // 注入微信会话上下文
      if (msg.contextToken) {
        this.persistReplyContext(msg)
        this.bridge.setWeixinMessageContext({
          channelUserId: msg.channelUserId,
          contextToken: msg.contextToken,
          ...(msg.botToken ? { botToken: msg.botToken } : {}),
          ...(msg.ilinkBaseUrl ? { ilinkBaseUrl: msg.ilinkBaseUrl } : {}),
        })
      }

      try {
        // 通过 SessionManager 统一调用（含并发保护 + beforePrompt/afterPrompt 编排）
        await this.sessionManager.prompt({
          instanceId,
          sessionKey: session.sessionKey,
          message: prompt,
          strategy: this.contextStrategy,
          adapter: this,
          session: sessionWithInstance,
        })
      } finally {
        this.bridge.unregisterNodeStreamCallback(instanceId)
        this.bridge.setWeixinMessageContext(null)
      }

      const replyText = finalTexts.join('\n').trim()
      log.info(`[handleMessage] Agent 处理完成，回复长度=${replyText.length}`)
      // NO_REPLY 协议：Agent 通过 message 工具直接发送后回复 NO_REPLY，避免重复投递
      // sentViaTool 只跳过空回复或 NO_REPLY，有实质内容的文本仍需发送（如发完文件后的确认语）
      const sentViaTool = this.bridge.getWeixinMessageSentViaTool()
      if (!replyText || replyText === 'NO_REPLY') {
        if (sentViaTool) {
          log.info(`[handleMessage] 本轮已通过 message 工具发送，跳过空/NO_REPLY 文本回复`)
        } else if (streamError) {
          await this.sendTextReply(sessionWithInstance, buildChannelErrorMessage(streamError))
        }
      } else {
        await this.sendTextReply(sessionWithInstance, replyText)
      }
    } catch (err) {
      log.error(`[handleMessage] Agent 处理异常: ${err instanceof Error ? err.message : String(err)}`)
      try {
        const session = (() => {
          try {
            return this.buildSession(msg)
          } catch {
            return null
          }
        })()
        if (session) {
          await this.sendTextReply(session, buildChannelErrorMessage(err))
        }
      } catch (replyErr) {
        log.warn(`[handleMessage] 发送错误回传失败: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`)
      }
    }
  }

  // ── 会话管理 ──────────────────────────────────────────────────────────────

  /**
   * 当前活跃 sessionKey：路由表（/new、/resume、/link、接续写过的那份，重启后仍在）
   * > `/link` 绑定 > 渠道默认会话。决策在 `ChannelRouteService`，四个渠道共用同一段代码。
   */
  getActiveSessionKey(channelUserId: string): string {
    return this.route.activeKey(channelUserId)
  }

  /** 切换路由（由 /new、/resume、/link 命令与跨渠道接续调用；来源用于 /back 与诊断） */
  setActiveSessionKey(
    channelUserId: string,
    sessionKey: string,
    source: RouteSource = 'own',
  ): void {
    this.route.setActive(channelUserId, sessionKey, source)
    log.info(
      `[setActiveSessionKey] channelUserId=${channelUserId} → sessionKey=${sessionKey} source=${source}`,
    )
  }

  /**
   * 回到本渠道自己的会话（跨渠道接续被拒、`/back`、`/unlink` 调用）。
   *
   * 「只在当前路由恰好是那条 /link 绑定时才解绑」这条保护规则已上提到
   * `ChannelRouteService.resetToOwn`——四个渠道共用，微信不再是特例。
   */
  resetToChannelSession(channelUserId: string): string {
    return this.route.resetToOwn(channelUserId)
  }

  /** 清除媒体附件缓存（切换会话时调用） */
  clearPendingMedia(channelUserId: string): void {
    pendingAttachments.clear(makePendingKey('weixin', channelUserId))
  }

  /** 获取或创建 Agent 实例（复用同一实例保持对话历史） */
  private async getOrCreateInstance(sessionKey: string): Promise<string> {
    const cachedId = this.sessionToInstance.get(sessionKey)
    if (cachedId) {
      const instances = this.bridge.getInstances()
      if (instances.some((i: { id: string }) => i.id === cachedId)) {
        log.info(`[getOrCreateInstance] 复用现有实例: sessionKey=${sessionKey} instanceId=${cachedId}`)
        return cachedId
      }
      this.sessionToInstance.delete(sessionKey)
      log.info(`[getOrCreateInstance] 实例已失效，重新创建: sessionKey=${sessionKey}`)
    }
    const instanceId = await this.bridge.createInstanceById('main', sessionKey, sessionKey)
    this.sessionToInstance.set(sessionKey, instanceId)
    log.info(`[getOrCreateInstance] 新建实例: sessionKey=${sessionKey} instanceId=${instanceId}`)
    return instanceId
  }

  /**
   * ACP 子进程路径：通过 emitProgress 推送工具进度，60 分钟可配置超时。
   * 工具执行状态以短消息推送，最终结果一次性回复。
   */
  private async handleAcpPrompt(
    msg: WeixinNormalizedMessage,
    session: ChannelSession,
    prompt: string,
    backendId: string,
    cwd?: string,
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
        accountId: msg.channelUserId,
        peerId: session.sessionKey,
        senderId: msg.channelUserId,
        contextToken: msg.contextToken,
        timestamp: msg.timestamp,
        cwd,
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

  /** 销毁指定 sessionKey 的实例缓存 */
  destroyInstance(sessionKey: string): void {
    const id = this.sessionToInstance.get(sessionKey)
    if (id) {
      try { this.bridge.destroy(id) } catch { /* ignore */ }
      this.sessionToInstance.delete(sessionKey)
    }
  }

  // ── 私有辅助 ──────────────────────────────────────────────────────────────

  private buildSession(msg: WeixinNormalizedMessage): ChannelSession {
    const sessionKey = this.getActiveSessionKey(msg.channelUserId)
    return {
      sessionKey,
      channelType: 'weixin',
      channelUserId: msg.channelUserId,
      instanceId: this.sessionToInstance.get(sessionKey) ?? null,
      replyContext: {
        contextToken: msg.contextToken,
        botToken: msg.botToken,
        ilinkBaseUrl: msg.ilinkBaseUrl,
      },
    }
  }

  private buildRegistry(): SlashCommandRegistry {
    const registry = new SlashCommandRegistry()
    registry.register('clear', clearCommand)
    registry.register('new', newCommand)
    registry.register('resume', resumeCommand)
    registry.register('help', createHelpCommand(registry))
    registry.register('compact', compactCommand)
    registry.register('stop', stopCommand, ['abort'])
    registry.register('backend', backendCommand)
    // 切回主代理
    registry.register('lumii', lumiiCommand)
    // ACP 后端切换（含别名）
    const claudeCmd = createSwitchBackendCommand('claude')
    registry.register('claude', claudeCmd)
    registry.register('claude-code', claudeCmd)       // 别名
    registry.register('codex', createSwitchBackendCommand('codex'))
    registry.register('opencode', createSwitchBackendCommand('opencode'))
    registry.register('cursor', createSwitchBackendCommand('cursor'))
    // 开发项目切换（对话级，写 dev-context）
    registry.register('project', projectCommand)
    // 跨通道绑定
    registry.register('link', linkCommand)
    registry.register('unlink', unlinkCommand)
    // 回到本渠道自己的会话（取消跨渠道接续）
    registry.register('back', backCommand)
    return registry
  }
}
