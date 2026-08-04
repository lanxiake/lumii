/**
 * IpcChannelAdapter — IPC 通道适配器（Windows 客户端）
 *
 * 封装 IPC 通道的消息通知逻辑，实现 IChannelAdapter 接口。
 * 使用 StatefulContextStrategy（增量同步，不清空内存）。
 */

import type { BrowserWindow } from 'electron'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { IChannelAdapter, ChannelSession, ContextStrategy } from '../types'
import { StatefulContextStrategy } from '../context-strategy/stateful-strategy'
import { SessionManager } from '../session-manager'
import { AcpBackendManager } from '../acp-backend-manager'

const log = {
  info: (...args: unknown[]) => console.log('[IpcChannelAdapter]', ...args),
  warn: (...args: unknown[]) => console.warn('[IpcChannelAdapter]', ...args),
  error: (...args: unknown[]) => console.error('[IpcChannelAdapter]', ...args),
}

export class IpcChannelAdapter implements IChannelAdapter {
  readonly channelType = 'ipc'

  private readonly contextStrategy: StatefulContextStrategy
  readonly sessionManager: SessionManager

  constructor(
    private readonly bridge: AgentRuntimeBridge,
    private readonly acpBackendManager: AcpBackendManager,
    private readonly getMainWindow: () => BrowserWindow | null,
  ) {
    this.contextStrategy = new StatefulContextStrategy(bridge)
    this.sessionManager = new SessionManager(bridge)
  }

  async sendTextReply(_session: ChannelSession, _text: string): Promise<void> {
    // IPC 通道不需要主动推送文字回复：Agent 输出通过 agent-runtime:event 流式推送到渲染进程
    log.warn(`[sendTextReply] IPC 通道不支持主动文字回复，忽略`)
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
   * 通过 SessionManager 发送消息（含并发保护 + 增量同步）。
   * 返回 runId，调用方可用于追踪。
   *
   * @param imageAttachmentPaths 图片附件 workspace 绝对路径，
   *   仅在选用模型支持视觉输入时由 IPC 层透传，会被 bridge.prompt 读盘转 base64 注入 LLM。
   */
  async sendPrompt(
    instanceId: string,
    sessionKey: string,
    message: string,
    imageAttachmentPaths?: readonly string[],
    pendingUserMsgId?: string,
  ): Promise<void> {
    const session: ChannelSession = {
      sessionKey,
      channelType: 'ipc',
      channelUserId: 'local-user',
      instanceId,
    }
    await this.sessionManager.prompt({
      instanceId,
      sessionKey,
      message,
      strategy: this.contextStrategy,
      adapter: this,
      session,
      imageAttachmentPaths,
      pendingUserMsgId,
    })
  }
}
