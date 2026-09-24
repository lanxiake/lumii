/**
 * AgentRuntimeBridge 对话与本地数据管理
 *
 * 拆自 bridge.ts，封装：
 * - 本地存储统计 / 导出 / 修复
 * - Conversation 生命周期（创建、恢复历史、清空、列举）
 * - 消息计数
 */

import {
  type LocalDatabase,
  type ConversationRepo,
  type TaskRepo,
  type AgentRegistry,
  getLocalStorageStats,
  exportLocalDataAsJSONL,
  estimateTokenCount,
  type LocalStorageStats,
} from '@mtbot/agent-runtime'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { channelOwnershipFromKey, isChannelOwnership } from '../channel/channel-identity'
import type { BridgeSessionModelCatalog } from './bridge-session-model-catalog'
import { agentRuntimeLog as log } from './bridge-utils'

export interface BridgeConversationManagerDeps {
  localDb: LocalDatabase
  getResolvedDbPath: () => string | null
  getConversationRepo: () => ConversationRepo | null
  getTaskRepo: () => TaskRepo | null
  getAgentRegistry: () => AgentRegistry
  getSessionModelCatalog: () => BridgeSessionModelCatalog
}

export class BridgeConversationManager {
  constructor(private readonly deps: BridgeConversationManagerDeps) {}

  // ── 本地存储 ──

  getLocalStorageStats(): LocalStorageStats {
    const p = this.deps.getResolvedDbPath()
    if (!p || !this.deps.localDb.isOpen) {
      throw new Error('AgentRuntimeBridge not initialized')
    }
    return getLocalStorageStats(this.deps.localDb.db, p)
  }

  exportLocalDataJSONL(): string {
    if (!this.deps.localDb.isOpen) {
      throw new Error('AgentRuntimeBridge not initialized')
    }
    return exportLocalDataAsJSONL(this.deps.localDb.db)
  }

  clearMalformedMessages(): number {
    const repo = this.deps.getConversationRepo()
    if (!repo) throw new Error('ConversationRepo not initialized')
    return repo.deleteMalformedMessages()
  }

  // ── Conversation 生命周期 ──

  /**
   * 建会话（存在即 no-op）。
   *
   * @param channelType 会话归属渠道（10-S2 起落库为 `conversations.channel_type`）。
   *   渠道 adapter 传自己的 `channelType`；未传时按 id 前缀推断（存量调用点与系统会话的安全网）。
   *   注意二者语义不同：**归属 = 会话从哪来**，与「此刻谁在说话」无关（见 channel-identity.ts）。
   * @param agentParticipantId 会话属于哪个 Agent 的**定义 id**。缺省 `'main'`（主助手实例）。
   *
   *   ⚠ 宠物会话必须显式传自己的 `pet:<模型ID>`。参与者这一列是**归属的唯一凭据**：
   *   宫殿归档按它解析归属（`palace-backend.ts` 的 `resolveConversationAgentId`），
   *   而 `'main'` 在 `INSTANCE_TO_DEFINITION` 里被映射成 `assistant` ——
   *   无条件写 `'main'` 的后果是宠物跑出来的内容**全部记在助手名下**：
   *   宠物侧 `memory_search` 搜不到自己的经历，助手侧检索反而多出宠物说的话。
   *   （两套 id 的坑：实例 id `main` vs 定义 id `assistant`，见
   *   `agent-runtime/bridge-types` 与仓库记忆「agent 身份有两套 id」。）
   */
  ensureConversationExists(
    conversationId: string,
    title?: string,
    channelType?: string,
    agentParticipantId = 'main',
  ): boolean {
    const repo = this.deps.getConversationRepo()
    if (!repo) {
      log.warn(`[ensureConversationExists] ConversationRepo 未初始化`)
      return false
    }
    const existing = repo.getConversation(conversationId)
    if (existing) return false

    const ownership = isChannelOwnership(channelType)
      ? channelType
      : channelOwnershipFromKey(conversationId)
    const now = new Date().toISOString()
    const db = this.deps.localDb.db
    try {
      db.prepare(
        `INSERT OR IGNORE INTO conversations (id, user_id, type, title, is_active, created_at, channel_type)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      ).run(conversationId, 'local-user', 'direct', title ?? conversationId, now, ownership)
      db.prepare(
        `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_type, participant_id, joined_at)
         VALUES (?, ?, ?, ?)`
      ).run(conversationId, 'user', 'local-user', now)
      db.prepare(
        `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_type, participant_id, joined_at)
         VALUES (?, ?, ?, ?)`
      ).run(conversationId, 'agent', agentParticipantId, now)
      log.info(`[ensureConversationExists] 新建对话记录: conversationId=${conversationId} agent=${agentParticipantId}`)
      return true
    } catch (err) {
      log.error(`[ensureConversationExists] 创建对话失败: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  restoreHistoryForInstance(instanceId: string, conversationId: string, limit = 200, excludeMessageId?: string): void {
    const instance = this.deps.getAgentRegistry().get(instanceId)
    if (!instance) {
      log.warn(`[restoreHistoryForInstance] 实例不存在: ${instanceId}`)
      return
    }
    const repo = this.deps.getConversationRepo()
    if (!repo) {
      log.warn(`[restoreHistoryForInstance] ConversationRepo 未初始化`)
      return
    }
    const piMessages = repo.loadMessagesAsPiFormat(conversationId, { limit, excludeMessageId })
    if (piMessages.length === 0) {
      log.info(`[restoreHistoryForInstance] 无历史消息: conversationId=${conversationId}`)
      return
    }

    type AgentMsg = AgentMessage
    const isCompactionSummary = (m: AgentMsg): boolean => {
      const content = (m as { content?: unknown }).content
      if (typeof content === 'string') {
        return content.includes('<conversation_summary>') ||
               content.includes('This session is being continued from a previous conversation')
      }
      if (Array.isArray(content)) {
        return content.some((b) => {
          const block = b as Record<string, unknown>
          return typeof block['text'] === 'string' && (
            (block['text'] as string).includes('<conversation_summary>') ||
            (block['text'] as string).includes('This session is being continued from a previous conversation')
          )
        })
      }
      return false
    }

    const filtered = (piMessages as AgentMsg[]).filter((m) => !isCompactionSummary(m))
    if (filtered.length < piMessages.length) {
      log.info(
        `[restoreHistoryForInstance] 过滤 compaction summary: 原 ${piMessages.length} 条 → 过滤后 ${filtered.length} 条`,
      )
    }

    if (filtered.length === 0) {
      log.info(`[restoreHistoryForInstance] 过滤后无有效历史消息: conversationId=${conversationId}`)
      return
    }

    const comp = this.deps.getSessionModelCatalog().getCompactionForRootSession(conversationId)
    const maxHistoryTokens = Math.floor(comp.contextWindow * 0.40)
    let trimmed = filtered
    const totalTokens = estimateTokenCount(trimmed)
    if (totalTokens > maxHistoryTokens) {
      while (trimmed.length > 2 && estimateTokenCount(trimmed) > maxHistoryTokens) {
        trimmed = trimmed.slice(1)
      }
      log.info(
        `[restoreHistoryForInstance] token 预算裁剪: 原 ${filtered.length} 条(估算 ${totalTokens} tokens) → 保留最近 ${trimmed.length} 条, 预算=${maxHistoryTokens}`,
      )
    }

    instance.replaceMessages(trimmed)
    log.info(`[restoreHistoryForInstance] 已注入 ${trimmed.length} 条历史消息: instanceId=${instanceId} conversationId=${conversationId}`)
  }

  clearConversationMessages(conversationId: string): void {
    const db = this.deps.localDb.db
    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId)
    log.info(`[clearConversationMessages] 已清空消息: conversationId=${conversationId}`)
  }

  listRecentConversations(
    limit = 10,
  ): readonly { id: string; title: string; updatedAt: string; channelType: string | null }[] {
    const conversations = this.deps.getConversationRepo()?.listActiveConversations('local-user', limit) ?? []
    return conversations.map((c) => ({
      id: c.id,
      title: c.title ?? '新对话',
      updatedAt: c.last_msg_at ?? c.created_at,
      // 归属落库值（可能为 NULL：老库未回填 / 非本模块创建的会话）→ 消费方按前缀回退
      channelType: c.channel_type ?? null,
    }))
  }

  getDbMessageCount(sessionKey: string): number {
    const db = this.deps.localDb.db
    const row = db.prepare<{ count: number }>(
      `SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND is_streaming = 0`
    ).get(sessionKey) as { count: number } | undefined
    return row?.count ?? 0
  }
}
