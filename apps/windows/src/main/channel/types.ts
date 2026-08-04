/**
 * Channel 层核心类型定义
 *
 * 设计文档：.qoder/design/channel/2026-04-19-windows-channel-unified-architecture.md
 */

import type { AgentRuntimeBridge } from '../agent-runtime/bridge'
import type { AcpBackendManager } from './acp-backend-manager'
import type { WeixinSessionBindingManager } from './weixin-session-binding'

// ── 通道会话 ──────────────────────────────────────────────────────────────────

/**
 * 通道会话上下文，封装一次消息处理所需的路由信息。
 */
export interface ChannelSession {
  /** 全局唯一会话键，对应 DB conversationId */
  sessionKey: string
  /** 通道类型标识 */
  channelType: 'ipc' | 'weixin' | string
  /** 通道内用户 ID（微信 channelUserId / IPC peerId） */
  channelUserId: string
  /** 当前绑定的 Agent 实例 ID（null 表示尚未创建） */
  instanceId: string | null
  /** 通道特有的回复上下文（微信：contextToken/botToken/ilinkBaseUrl） */
  replyContext?: Record<string, unknown>
}

// ── 上下文策略 ────────────────────────────────────────────────────────────────

/**
 * 上下文管理策略接口。
 * - StatelessStrategy（微信）：每轮前从 DB 恢复，每轮后清空内存
 * - StatefulStrategy（IPC）：增量同步，不清空内存
 */
export interface ContextStrategy {
  /**
   * @param pendingUserMsgId 本轮正在处理、已先行持久化到 DB 的用户消息 id。
   *        恢复历史时需排除它，避免它既被 restore 注入内存、又被 instance.prompt() 追加，导致重复。
   */
  beforePrompt(instanceId: string, sessionKey: string, pendingUserMsgId?: string): Promise<void>
  afterPrompt(instanceId: string, sessionKey: string): Promise<void>
}

// ── 斜杠命令 ──────────────────────────────────────────────────────────────────

/**
 * 斜杠命令执行上下文，注入命令处理所需的所有依赖。
 */
export interface CommandContext {
  session: ChannelSession
  adapter: IChannelAdapter
  bridge: AgentRuntimeBridge
  acpBackendManager: AcpBackendManager
  /** 命令参数（去掉命令名后的剩余文本，已 trim） */
  args: string
  /** 微信会话绑定管理器（仅微信通道注入，IPC 通道为 undefined） */
  bindingManager?: WeixinSessionBindingManager
}

/**
 * 斜杠命令处理器接口
 */
export interface CommandHandler {
  description: string
  execute(ctx: CommandContext): Promise<void>
}

// ── 通道适配器 ────────────────────────────────────────────────────────────────

/**
 * 通道适配器接口，封装各通道的消息收发与通知逻辑。
 */
export interface IChannelAdapter {
  readonly channelType: string
  /** 向通道用户发送文本回复 */
  sendTextReply(session: ChannelSession, text: string): Promise<void>
  /** 向通道用户发送文件（可选） */
  sendFileReply?(session: ChannelSession, filePath: string): Promise<void>
  /** 通知渲染进程有新消息（用于侧边栏同步） */
  notifyIncomingMessage(session: ChannelSession, text: string): void
  /** 通知渲染进程导航到指定会话 */
  notifyNavigateToSession(session: ChannelSession): void
  /** 返回该通道使用的上下文策略 */
  getContextStrategy(): ContextStrategy
  /** 切换活跃 sessionKey（/new、/resume、/link 命令调用，可选） */
  setActiveSessionKey?(channelUserId: string, sessionKey: string): void
}
