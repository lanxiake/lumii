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
import type { AgentMessage } from '@mariozechner/pi-agent-core'
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

  ensureConversationExists(conversationId: string, title?: string): boolean {
    const repo = this.deps.getConversationRepo()
    if (!repo) {
      log.warn(`[ensureConversationExists] ConversationRepo 未初始化`)
      return false
    }
    const existing = repo.getConversation(conversationId)
    if (existing) return false

    const now = new Date().toISOString()
    const db = this.deps.localDb.db
    try {
      db.prepare(
        `INSERT OR IGNORE INTO conversations (id, user_id, type, title, is_active, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`
      ).run(conversationId, 'local-user', 'direct', title ?? conversationId, now)
      db.prepare(
        `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_type, participant_id, joined_at)
         VALUES (?, ?, ?, ?)`
      ).run(conversationId, 'user', 'local-user', now)
      db.prepare(
        `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_type, participant_id, joined_at)
         VALUES (?, ?, ?, ?)`
      ).run(conversationId, 'agent', 'main', now)
      log.info(`[ensureConversationExists] 新建对话记录: conversationId=${conversationId}`)
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

  listRecentConversations(limit = 10): readonly { id: string; title: string; updatedAt: string }[] {
    const conversations = this.deps.getConversationRepo()?.listActiveConversations('local-user', limit) ?? []
    return conversations.map((c) => ({
      id: c.id,
      title: c.title ?? '新对话',
      updatedAt: c.last_msg_at ?? c.created_at,
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
