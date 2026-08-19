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
import { backendCommand } from '../slash-commands/backend'
import { createSwitchBackendCommand, lumiiCommand } from '../slash-commands/switch-backend'
import { linkCommand, unlinkCommand } from '../slash-commands/link'
import { runCodingDevAcpPrompt } from '../../coding-dev-backends-stub/run-coding-dev-acp-prompt.js'
import { resolveAcpTimeoutMs } from '../../coding-dev-backends-stub/acp-config.js'
import { DEFAULT_CODING_DEV_BACKEND_ID } from '../../coding-dev-backends-stub/contracts.js'
import {
  CHANNEL_ACK_TEXT,
  buildChannelErrorMessage,
} from '../channel-error-helper'

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
  /** channelUserId → 当前活跃 sessionKey */
  private readonly activeSession = new Map<string, string>()
  /** channelUserId → 待合并的媒体附件行列表 */
  private readonly pendingMediaLines = new Map<string, string[]>()
  /** channelUserId → 串行处理队列 */
  private readonly userQueues = new Map<string, Promise<void>>()

  private readonly contextStrategy: StatelessContextStrategy
  private readonly registry: SlashCommandRegistry
  private readonly sessionManager: SessionManager
  readonly bindingManager: WeixinSessionBindingManager

  /** 入站时 upsert context_token，供 channel_send 伪 Push */
  private replyContextStore: WeixinReplyContextStore | null = null

  constructor(
    private readonly weixinLoginService: WeixinLoginService,
    private readonly bridge: AgentRuntimeBridge,
    private readonly acpBackendManager: AcpBackendManager,
    replyContextStore?: WeixinReplyContextStore | null,
  ) {
    this.replyContextStore = replyContextStore ?? null
    this.contextStrategy = new StatelessContextStrategy(bridge)
    this.sessionManager = new SessionManager(bridge)
    this.bindingManager = new WeixinSessionBindingManager(bridge.runtimeStateRepo)
    this.bindingManager.initialize()
    this.registry = this.buildRegistry()
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
    })
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
      const prev = this.userQueues.get(userId) ?? Promise.resolve()
      const next = prev.then(() => this.handleMessage(msg)).catch((err) => {
        log.error(`[startListening] 消息处理失败: ${err instanceof Error ? err.message : String(err)}`)
      })
      this.userQueues.set(userId, next)
    })
    log.info('[startListening] 微信消息监听已启动')
  }

  // ── 内部消息处理 ──────────────────────────────────────────────────────────

  private async handleMessage(msg: WeixinNormalizedMessage): Promise<void> {
    const rawText = msg.text?.trim() ?? ''
    if (!rawText) {
      log.info(`[handleMessage] 消息无文本内容，跳过 channelUserId=${msg.channelUserId}`)
      return
    }

    // 媒体附件缓存逻辑
    const extractMediaLines = (text: string): string[] =>
      text.split('\n').filter((l: string) => /^\[media attached:/.test(l.trim()))

    const extractTranscriptLine = (text: string): string | null => {
      const line = text.split('\n').find((l: string) => /^\[语音转录:/.test(l.trim()))
      if (!line) return null
      // 提取 [语音转录: xxx] 中的内容
      const m = line.trim().match(/^\[语音转录:\s*(.*)\]$/)
      return m ? m[1].trim() : null
    }

    // 语音消息（含 ASR 转录）：直接将转录文字发送给 Agent，跳过媒体缓存
    const voiceTranscript = extractTranscriptLine(rawText)
    if (msg.type === 'media' && voiceTranscript) {
      log.info(`[handleMessage] 语音消息已转录，直接发给 Agent: "${voiceTranscript}" channelUserId=${msg.channelUserId}`)
      // 用转录文字替代 rawText，让后续正常消息处理流程执行
      // 注意：此处不修改 msg 对象（immutable），直接 fall through 到下方的合并逻辑
      // 先清除可能存在的历史缓存（避免旧媒体附件混入语音消息）
      const session = this.buildSession(msg)
      this.bridge.ensureConversationExists(session.sessionKey, `微信对话 - ${msg.channelUserId}`)

      // 语音转录：先回复即时回执（有转录内容说明，与其他路径一致）
      await this.sendTextReply(session, CHANNEL_ACK_TEXT).catch((err) => {
        log.warn(`[handleMessage] 发送语音回执失败: ${err instanceof Error ? err.message : String(err)}`)
      })

      this.bridge.notifyIncomingMessage(session.sessionKey, voiceTranscript)
      this.bridge.notifyNavigateToSession(session.sessionKey)

      const currentBackend = this.acpBackendManager.getBackend(msg.channelUserId, session.sessionKey)
      if (currentBackend !== DEFAULT_CODING_DEV_BACKEND_ID) {
        try {
          await this.handleAcpPrompt(msg, session, voiceTranscript, currentBackend)
        } catch (err) {
          log.error(`[handleMessage] 语音转录 ACP 异常: ${err instanceof Error ? err.message : String(err)}`)
          try {
            await this.sendTextReply(session, buildChannelErrorMessage(err))
          } catch (replyErr) {
            log.warn(`[handleMessage] 发送语音转录错误回传失败: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`)
          }
        }
        return
      }

      const instanceId = await this.getOrCreateInstance(session.sessionKey)
      const activeSession = { ...session, instanceId }

      try {
        this.bridge.conversationRepo.saveMessage({
          conversationId: session.sessionKey,
          role: 'user',
          contentJson: { type: 'text', text: voiceTranscript },
        })
      } catch (err) {
        log.error(`[handleMessage] 持久化语音转录消息失败: ${err instanceof Error ? err.message : String(err)}`)
      }

      const finalTexts: string[] = []
      this.bridge.registerNodeStreamCallback(instanceId, (event) => {
        const evt = event as Record<string, unknown>
        if (evt.type === 'message:end' && typeof evt.fullText === 'string') {
          finalTexts.push(evt.fullText)
        }
      })

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
        try {
          await this.sessionManager.prompt({
            instanceId,
            sessionKey: session.sessionKey,
            message: voiceTranscript,
            strategy: this.contextStrategy,
            adapter: this,
            session: activeSession,
          })
        } finally {
          this.bridge.unregisterNodeStreamCallback(instanceId)
          this.bridge.setWeixinMessageContext(null)
        }

        const replyText = finalTexts.join('\n').trim()
        log.info(`[handleMessage] 语音转录 Agent 处理完成，回复长度=${replyText.length}`)
        const sentViaTool = this.bridge.getWeixinMessageSentViaTool()
        if (!replyText || replyText === 'NO_REPLY') {
          if (sentViaTool) {
            log.info(`[handleMessage] 本轮已通过 message 工具发送，跳过空/NO_REPLY 文本回复`)
          }
        } else {
          await this.sendTextReply(activeSession, replyText)
        }
      } catch (err) {
        log.error(`[handleMessage] 语音转录 Agent 异常: ${err instanceof Error ? err.message : String(err)}`)
        try {
          await this.sendTextReply(session, buildChannelErrorMessage(err))
        } catch (replyErr) {
          log.warn(`[handleMessage] 发送语音转录错误回传失败: ${replyErr instanceof Error ? replyErr.message : String(replyErr)}`)
        }
      }
      return
    }

    const isPureMedia = msg.type === 'media' && extractMediaLines(rawText).length > 0
    if (isPureMedia) {
      const mediaLines = extractMediaLines(rawText)
      const existing = this.pendingMediaLines.get(msg.channelUserId) ?? []
      this.pendingMediaLines.set(msg.channelUserId, [...existing, ...mediaLines])
      log.info(`[handleMessage] 纯媒体消息：缓存 ${mediaLines.length} 个附件 channelUserId=${msg.channelUserId}`)
      const fileNames = mediaLines.map((l: string) => l.match(/\(([^)]+)\)\]$/)?.[1] ?? l).join('、')
      const session = this.buildSession(msg)
      // 通知渲染进程展示用户发来的文件消息，避免客户端对话出现消息断层
      this.bridge.ensureConversationExists(session.sessionKey, `微信对话 - ${msg.channelUserId}`)
      this.bridge.notifyIncomingMessage(session.sessionKey, rawText)
      this.bridge.notifyNavigateToSession(session.sessionKey)
      await this.sendTextReply(session, `📎 已收到文件：${fileNames}\n请发送文字说明你想如何处理这些文件。`)
      return
    }

    // 合并缓存的媒体附件
    const pending = this.pendingMediaLines.get(msg.channelUserId) ?? []
    this.pendingMediaLines.delete(msg.channelUserId)
    const currentMediaLines = extractMediaLines(rawText)
    const userTextOnly = rawText.split('\n').filter((l) => !/^\[media attached:/.test(l.trim())).join('\n').trim()
    const allMediaLines = [...pending, ...currentMediaLines]
    const prompt = allMediaLines.length > 0 ? `${userTextOnly}\n${allMediaLines.join('\n')}`.trim() : rawText

    const session = this.buildSession(msg)
    log.info(`[handleMessage] 开始处理消息: sessionKey=${session.sessionKey} promptLen=${prompt.length}`)

    try {
      this.bridge.ensureConversationExists(session.sessionKey, `微信对话 - ${msg.channelUserId}`)

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

      // 非斜杠命令：先回复即时回执，避免用户发完无响应产生重复发送
      await this.sendTextReply(session, CHANNEL_ACK_TEXT).catch((err) => {
        log.warn(`[handleMessage] 发送即时回执失败: ${err instanceof Error ? err.message : String(err)}`)
      })

      // 普通消息：推送到渲染进程
      this.bridge.notifyIncomingMessage(session.sessionKey, prompt)
      this.bridge.notifyNavigateToSession(session.sessionKey)

      // 检查当前后端：非主代理走 ACP 子进程路径
      const currentBackend = this.acpBackendManager.getBackend(msg.channelUserId, session.sessionKey)
      if (currentBackend !== DEFAULT_CODING_DEV_BACKEND_ID) {
        try {
          await this.handleAcpPrompt(msg, session, prompt, currentBackend)
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
      const activeSession = { ...session, instanceId }

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

      // 收集 Agent 输出
      const finalTexts: string[] = []
      this.bridge.registerNodeStreamCallback(instanceId, (event) => {
        const evt = event as Record<string, unknown>
        if (evt.type === 'message:end' && typeof evt.fullText === 'string') {
          finalTexts.push(evt.fullText)
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
          session: activeSession,
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
        }
      } else {
        await this.sendTextReply(activeSession, replyText)
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

  /** 获取当前活跃 sessionKey（优先级：activeSession > 绑定会话 > 默认） */
  getActiveSessionKey(channelUserId: string): string {
    // 1. /new 或 /resume 切换后的活跃会话（优先级最高）
    const active = this.activeSession.get(channelUserId)
    if (active) return active

    // 2. /link 绑定的 Windows 会话
    const bound = this.bindingManager.getBoundConversationId(channelUserId)
    if (bound) return bound

    // 3. 默认：基于 channelUserId 的独立会话
    return `weixin:${channelUserId}`
  }

  /** 设置活跃 sessionKey（由 /new、/resume、/link 命令调用） */
  setActiveSessionKey(channelUserId: string, sessionKey: string): void {
    this.activeSession.set(channelUserId, sessionKey)
    log.info(`[setActiveSessionKey] channelUserId=${channelUserId} → sessionKey=${sessionKey}`)
  }

  /** 清除 activeSession 覆盖（/unlink 后恢复绑定路由或默认路由） */
  clearActiveSession(channelUserId: string): void {
    this.activeSession.delete(channelUserId)
    log.info(`[clearActiveSession] channelUserId=${channelUserId} 已清除 activeSession 覆盖`)
  }

  /** 清除媒体附件缓存（切换会话时调用） */
  clearPendingMedia(channelUserId: string): void {
    this.pendingMediaLines.delete(channelUserId)
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
    // 跨通道绑定
    registry.register('link', linkCommand)
    registry.register('unlink', unlinkCommand)
    return registry
  }
}
