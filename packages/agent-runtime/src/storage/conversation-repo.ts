/**
 * ConversationRepo — 对话 CRUD + 消息读写
 *
 * 适配 node:sqlite DatabaseSync API（同步调用）。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { DatabaseAdapter } from "./local-database.js";
import { withTransaction } from "./local-database.js";
import { providerPromptTokens } from "../compact/token-estimate.js";
import type {
  AssistantPart,
  AssistantPartsContent,
  ToolAssistantPart,
} from "./assistant-parts.js";
import {
  parseMessageContentJson,
  type ToolCallRecord,
  type TextMessageContent,
  type ToolResultContent,
  type MessageContentJson,
} from "./message-content-json.js";
export {
  parseMessageContentJson,
  type ToolCallRecord,
  type TextMessageContent,
  type ToolResultContent,
  type MessageContentJson,
};

// ─── 类型定义 ───

export interface ConversationRow {
  readonly id: string;
  readonly user_id: string;
  readonly title: string | null;
  readonly is_active: number;
  readonly is_pinned: number;
  readonly created_at: string;
  readonly last_msg_at: string | null;
}

export interface MessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly agent_id: string | null;
  readonly role: string;
  readonly content_json: string;
  readonly timestamp: string;
  /** 1 表示流式未完成行，UI 与 pi 历史加载应忽略 */
  readonly is_streaming: number;
}

/** pi-agent Message 格式（用于构造 Agent 调用的 messages 参数） */
export interface PiMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly PiContentBlock[];
}

export interface PiContentBlock {
  readonly type: "text" | "tool_use" | "tool_result" | "toolCall" | "thinking";
  readonly [key: string]: unknown;
}

/** 近期会话与消息列表的 LRU 缓存（提升重复读性能） */
class LruCache<K, V> {
  constructor(private readonly max: number) {}

  private readonly map = new Map<K, V>();

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value as K | undefined;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** 删除所有满足谓词的键（用于按 conversationId 失效消息缓存） */
  deleteWhere(predicate: (key: K) => boolean): void {
    for (const key of [...this.map.keys()]) {
      if (predicate(key)) this.map.delete(key);
    }
  }
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly hasMore: boolean;
}

// ─── Repo 实现 ───

export class ConversationRepo {
  private readonly conversationCache = new LruCache<string, ConversationRow>(100);
  private readonly messageCache = new LruCache<string, MessageRow[]>(10);

  constructor(private readonly db: DatabaseAdapter) {}

  // ── 对话生命周期 ──

  createConversation(params: {
    readonly userId: string;
    readonly title?: string;
    readonly participants: ReadonlyArray<{ readonly type: "user" | "agent"; readonly id: string }>;
  }): ConversationRow {
    const id = generateId();
    const now = new Date().toISOString();

    const insertConv = this.db.prepare(
      `INSERT INTO conversations (id, user_id, title, is_active, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    );
    const insertParticipant = this.db.prepare(
      `INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, joined_at)
       VALUES (?, ?, ?, ?)`,
    );

    withTransaction(this.db, () => {
      insertConv.run(id, params.userId, params.title ?? null, now);
      for (const p of params.participants) {
        insertParticipant.run(id, p.type, p.id, now);
      }
    });

    const row: ConversationRow = {
      id,
      user_id: params.userId,
      title: params.title ?? null,
      is_active: 1,
      is_pinned: 0,
      created_at: now,
      last_msg_at: null,
    };
    this.conversationCache.set(id, row);
    return row;
  }

  getConversation(conversationId: string): ConversationRow | undefined {
    const hit = this.conversationCache.get(conversationId);
    if (hit) return hit;
    const row = this.db
      .prepare<ConversationRow>("SELECT * FROM conversations WHERE id = ?")
      .get(conversationId);
    if (row) this.conversationCache.set(conversationId, row);
    return row;
  }

  /**
   * 解析对话中绑定的 Agent 参与者 ID（用于记忆等作用域与 UI 列表）
   */
  getAgentParticipantId(conversationId: string): string | undefined {
    const row = this.db
      .prepare<{ participant_id: string }>(
        `SELECT participant_id FROM conversation_participants
       WHERE conversation_id = ? AND participant_type = 'agent'
       LIMIT 1`,
      )
      .get(conversationId);
    return row?.participant_id;
  }

  closeConversation(conversationId: string): void {
    this.db.prepare("UPDATE conversations SET is_active = 0 WHERE id = ?").run(conversationId);
    this.conversationCache.delete(conversationId);
    this.messageCache.deleteWhere((k) => k.startsWith(`${conversationId}|`));
  }

  listActiveConversations(userId: string, limit = 50): readonly ConversationRow[] {
    return this.db
      .prepare<ConversationRow>(
        `SELECT * FROM conversations
       WHERE user_id = ? AND is_active = 1
       ORDER BY is_pinned DESC, last_msg_at DESC NULLS LAST
       LIMIT ?`,
      )
      .all(userId, limit);
  }

  togglePinned(conversationId: string): boolean {
    this.db
      .prepare(
        `UPDATE conversations
       SET is_pinned = CASE WHEN is_pinned = 1 THEN 0 ELSE 1 END
       WHERE id = ?`,
      )
      .run(conversationId);
    const row = this.db
      .prepare<{ is_pinned: number }>(`SELECT is_pinned FROM conversations WHERE id = ?`)
      .get(conversationId);
    this.conversationCache.delete(conversationId);
    return row?.is_pinned === 1;
  }

  updateTitle(conversationId: string, title: string): void {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, conversationId);
    this.conversationCache.delete(conversationId);
    this.messageCache.deleteWhere((k) => k.startsWith(`${conversationId}|`));
  }

  /**
   * 统计某对话下用户消息条数（用于首条消息时自动更新标题等）。
   */
  countUserMessages(conversationId: string): number {
    const row = this.db
      .prepare<{ count: number }>(
        `SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND role = 'user'`,
      )
      .get(conversationId);
    return row?.count ?? 0;
  }

  /**
   * 获取最近一条带 usage 的助手消息的 prompt tokens（提供商真实读数）。
   * 用于重启或切换会话后恢复上下文用量展示。
   *
   * 必须把 cacheRead/cacheWrite 一起算：开了 prompt cache 后系统提示词等稳定前缀
   * 记在缓存字段里，inputTokens 只剩本轮增量，单取它会让上下文读数虚低一个量级。
   */
  getLastAssistantProviderInputTokens(conversationId: string): number | undefined {
    const rows = this.db
      .prepare<Pick<MessageRow, "content_json">>(
        `SELECT content_json FROM messages
         WHERE conversation_id = ? AND role = 'assistant' AND is_streaming = 0
         ORDER BY timestamp DESC
         LIMIT 30`,
      )
      .all(conversationId);

    for (const row of rows) {
      const parsed = parseMessageContentJson(row.content_json);
      const usage = parsed?.type === "text" ? parsed.usage : undefined;
      if (!usage) continue;
      const promptTokens = providerPromptTokens(usage);
      if (promptTokens > 0) {
        return promptTokens;
      }
    }
    return undefined;
  }

  // ── 消息读取 ──

  /**
   * 加载消息并转换为 pi-agent 的 Message 格式。
   * 仅返回 role = 'user' | 'assistant' 的消息。
   */
  loadMessagesAsPiFormat(
    conversationId: string,
    options?: { readonly limit?: number; readonly beforeTimestamp?: string; readonly excludeMessageId?: string },
  ): readonly AgentMessage[] {
    const limit = options?.limit ?? 100;
    const before = options?.beforeTimestamp;
    const excludeMessageId = options?.excludeMessageId;

    const rows: readonly MessageRow[] = before
      ? this.db
          .prepare<MessageRow>(
            `SELECT * FROM messages
           WHERE conversation_id = ? AND role IN ('user', 'assistant') AND timestamp < ?
             AND is_streaming = 0
           ORDER BY timestamp ASC
           LIMIT ?`,
          )
          .all(conversationId, before, limit)
      : this.db
          .prepare<MessageRow>(
            `SELECT * FROM (
               SELECT * FROM messages
               WHERE conversation_id = ? AND role IN ('user', 'assistant')
                 AND is_streaming = 0
               ORDER BY timestamp DESC
               LIMIT ?
             ) ORDER BY timestamp ASC`,
          )
          .all(conversationId, limit);

    // 排除指定消息（用于恢复历史时剔除"当前正在处理的用户消息"，
    // 避免它既被 restore 注入内存、又被 instance.prompt() 追加一次，导致重复）
    const effectiveRows = excludeMessageId
      ? rows.filter((row) => row.id !== excludeMessageId)
      : rows;

    return effectiveRows.flatMap((row) => messageRowToAgentMessages(row));
  }

  /**
   * 将异常退出/LLM 错误时遗留的 is_streaming=1 消息标记为已完成，保留已有内容供历史恢复。
   * 返回被 finalize 的消息数量。
   */
  finalizeAllStreamingMessages(): number {
    const rows = this.db
      .prepare<MessageRow>("SELECT * FROM messages WHERE is_streaming = 1")
      .all() as MessageRow[];

    console.log(`[finalizeAllStreamingMessages] 查询到 ${rows.length} 条流式残留消息`)
    if (rows.length > 0) {
      console.log('[finalizeAllStreamingMessages] 残留消息明细:', rows.map(r => ({
        id: r.id,
        conversation_id: r.conversation_id,
        role: r.role,
        timestamp: r.timestamp,
        content_json_length: r.content_json?.length ?? 0
      })))
    }

    if (rows.length === 0) return 0;

    const now = new Date().toISOString();
    withTransaction(this.db, () => {
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE messages SET is_streaming = 0, timestamp = ? WHERE id = ? AND conversation_id = ?`,
          )
          .run(now, row.id, row.conversation_id);
        this.db
          .prepare("UPDATE conversations SET last_msg_at = ? WHERE id = ?")
          .run(now, row.conversation_id);
      }
    });
    for (const row of rows) {
      this.conversationCache.delete(row.conversation_id);
      this.messageCache.deleteWhere((k) => k.startsWith(`${row.conversation_id}|`));
    }
    console.log(`[finalizeAllStreamingMessages] 已将 ${rows.length} 条消息标记为已完成`)
    return rows.length;
  }

  /**
   * 回读某段落的原文（按 message-id 区间，记忆系统升级阶段① 段落总结用）。
   *
   * 用 start/end 两条消息的 timestamp 圈定区间，取其间 user/assistant 文本消息，
   * 拼成 "role: text" 多行文本。区间消息不存在则返回空串。
   */
  loadSegmentText(conversationId: string, startMessageId: string, endMessageId: string): string {
    const bound = this.db.prepare<{ id: string; timestamp: string }>(
      "SELECT id, timestamp FROM messages WHERE id = ? AND conversation_id = ?",
    );
    const startRow = bound.get(startMessageId, conversationId);
    const endRow = bound.get(endMessageId, conversationId);
    if (!startRow) return "";
    const startTs = startRow.timestamp;
    const endTs = endRow?.timestamp ?? startTs;
    const [lo, hi] = startTs <= endTs ? [startTs, endTs] : [endTs, startTs];

    const rows = this.db
      .prepare<MessageRow>(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND role IN ('user', 'assistant')
           AND is_streaming = 0 AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(conversationId, lo, hi);

    const lines: string[] = [];
    for (const row of rows) {
      const parsed = parseMessageContentJson(row.content_json);
      const text = parsed && parsed.type === "text" ? (parsed.text ?? "").trim() : "";
      if (text) lines.push(`${row.role}: ${text}`);
    }
    return lines.join("\n");
  }

  /**
   * 加载消息用于 UI 展示（分页，包含所有 role）。
   */
  loadMessagesForUI(conversationId: string, page = 1, pageSize = 50): PaginatedResult<MessageRow> {
    const cacheKey = `${conversationId}|${page}|${pageSize}` as const;
    const hit = this.messageCache.get(cacheKey);
    if (hit) {
      const countRow = this.db
        .prepare<{ count: number }>(
          "SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?",
        )
        .get(conversationId);
      const total = countRow?.count ?? 0;
      const offset = (page - 1) * pageSize;
      return {
        items: hit,
        total,
        hasMore: offset + pageSize < total,
      };
    }

    const offset = (page - 1) * pageSize;

    const countRow = this.db
      .prepare<{ count: number }>(
        "SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND is_streaming = 0",
      )
      .get(conversationId);
    const total = countRow?.count ?? 0;

    const items = this.db
      .prepare<MessageRow>(
        `SELECT * FROM messages
       WHERE conversation_id = ? AND is_streaming = 0
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
      )
      .all(conversationId, pageSize, offset);

    const ordered = [...items].reverse() as MessageRow[];
    this.messageCache.set(cacheKey, ordered);

    return {
      items: ordered,
      total,
      hasMore: offset + pageSize < total,
    };
  }

  /**
   * 加载最近 N 条消息（用于记忆提取等场景）
   * @param includeStreaming 是否包含流式中（is_streaming=1）的消息，用于会话切换时恢复未完成的 AI 回复
   */
  loadRecentMessages(
    conversationId: string,
    limit = 10,
    includeStreaming = false,
  ): readonly MessageRow[] {
    const rows = includeStreaming
      ? this.db
          .prepare<MessageRow>(
            `SELECT * FROM messages
           WHERE conversation_id = ?
           ORDER BY timestamp DESC
           LIMIT ?`,
          )
          .all(conversationId, limit)
      : this.db
          .prepare<MessageRow>(
            `SELECT * FROM messages
           WHERE conversation_id = ? AND is_streaming = 0
           ORDER BY timestamp DESC
           LIMIT ?`,
          )
          .all(conversationId, limit);
    return [...rows].reverse();
  }

  // ── 消息写入 ──

  saveMessage(params: {
    /** 客户端指定的消息 ID（可选），不传则自动生成 */
    readonly id?: string;
    readonly conversationId: string;
    readonly agentId?: string;
    readonly role: "user" | "assistant" | "system";
    readonly contentJson: MessageContentJson;
    /** 为 true 时表示流式中的助手行，重启后应忽略 */
    readonly isStreaming?: boolean;
  }): MessageRow {
    const id = params.id ?? generateId();
    const now = new Date().toISOString();
    const contentStr = JSON.stringify(params.contentJson);
    const streamFlag = params.isStreaming ? 1 : 0;

    withTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, agent_id, role, content_json, timestamp, is_streaming)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.conversationId,
          params.agentId ?? null,
          params.role,
          contentStr,
          now,
          streamFlag,
        );

      this.db
        .prepare("UPDATE conversations SET last_msg_at = ? WHERE id = ?")
        .run(now, params.conversationId);
    });

    this.conversationCache.delete(params.conversationId);
    this.messageCache.deleteWhere((k) => k.startsWith(`${params.conversationId}|`));

    return {
      id,
      conversation_id: params.conversationId,
      agent_id: params.agentId ?? null,
      role: params.role,
      content_json: contentStr,
      timestamp: now,
      is_streaming: streamFlag,
    };
  }

  /**
   * 更新已存在消息（流式 delta / message:end / agent:end 收尾）。
   */
  updateMessageContent(params: {
    readonly messageId: string;
    readonly conversationId: string;
    readonly contentJson: MessageContentJson;
    readonly isStreaming: boolean;
  }): void {
    const contentStr = JSON.stringify(params.contentJson);
    const now = new Date().toISOString();
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE messages SET content_json = ?, is_streaming = ?, timestamp = ?
         WHERE id = ? AND conversation_id = ?`,
        )
        .run(contentStr, params.isStreaming ? 1 : 0, now, params.messageId, params.conversationId);
      this.db
        .prepare("UPDATE conversations SET last_msg_at = ? WHERE id = ?")
        .run(now, params.conversationId);
    });
    this.conversationCache.delete(params.conversationId);
    this.messageCache.deleteWhere((k) => k.startsWith(`${params.conversationId}|`));
  }

  /**
   * 删除指定消息之后的所有消息（不含该消息本身）。
   * 用于「编辑用户消息后重新回答」分支：清除原本的后续对话。
   */
  deleteMessagesAfter(messageId: string, conversationId: string): number {
    const anchor = this.db
      .prepare<{ timestamp: string }>(
        "SELECT timestamp FROM messages WHERE id = ? AND conversation_id = ?",
      )
      .get(messageId, conversationId);
    if (!anchor) return 0;

    const result = this.db
      .prepare(
        "DELETE FROM messages WHERE conversation_id = ? AND timestamp > ? AND id != ?",
      )
      .run(conversationId, anchor.timestamp, messageId);

    this.messageCache.deleteWhere((k) => k.startsWith(`${conversationId}|`));
    return (result as { changes: number }).changes ?? 0;
  }

  /**
   * 将某会话中截止到指定消息（含）的历史复制到新会话，并追加一条新的 user 消息。
   * 用于「基于当前历史创建新对话」分支：保留上下文，以编辑后的内容重新开始。
   *
   * @returns 新会话的 ID
   */
  forkConversation(params: {
    readonly sourceConversationId: string;
    readonly uptoMessageId: string;
    readonly newUserContent: string;
    readonly userId: string;
    readonly agentId?: string;
  }): string {
    const { sourceConversationId, uptoMessageId, newUserContent, userId, agentId } = params;

    // 读锚点消息的 timestamp
    const anchor = this.db
      .prepare<{ timestamp: string }>(
        "SELECT timestamp FROM messages WHERE id = ? AND conversation_id = ?",
      )
      .get(uptoMessageId, sourceConversationId);
    if (!anchor) {
      throw new Error(`forkConversation: message ${uptoMessageId} not found`);
    }

    // 读要复制的消息（timestamp <= anchor，排除 streaming 行）
    const rows = this.db
      .prepare<MessageRow>(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND is_streaming = 0 AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(sourceConversationId, anchor.timestamp) as MessageRow[];

    // 新建对话
    const newConv = this.createConversation({
      userId,
      title: null as unknown as undefined,
      participants: [
        { type: "user", id: userId },
        ...(agentId ? [{ type: "agent" as const, id: agentId }] : []),
      ],
    });

    const now = new Date().toISOString();
    const insertMsg = this.db.prepare(
      `INSERT INTO messages (id, conversation_id, agent_id, role, content_json, timestamp, is_streaming)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    withTransaction(this.db, () => {
      // 复制历史消息，保留相对时间顺序（timestamp 不变，仅 conversation_id 替换）
      for (const row of rows) {
        insertMsg.run(
          generateId(),
          newConv.id,
          row.agent_id,
          row.role,
          row.content_json,
          row.timestamp,
          0,
        );
      }
      // 追加新 user 消息
      insertMsg.run(
        generateId(),
        newConv.id,
        null,
        "user",
        JSON.stringify({ type: "text", text: newUserContent }),
        now,
        0,
      );
      this.db
        .prepare("UPDATE conversations SET last_msg_at = ? WHERE id = ?")
        .run(now, newConv.id);
    });

    this.messageCache.deleteWhere((k) => k.startsWith(`${newConv.id}|`));
    return newConv.id;
  }

  /**
   * 删除单条消息（流式失败或中止时清理未完成行）。
   */
  deleteMessage(messageId: string, conversationId: string): void {
    this.db
      .prepare("DELETE FROM messages WHERE id = ? AND conversation_id = ?")
      .run(messageId, conversationId);
    this.conversationCache.delete(conversationId);
    this.messageCache.deleteWhere((k) => k.startsWith(`${conversationId}|`));
  }

  /**
   * 保存工具执行结果作为 tool role 消息。
   */
  saveToolResult(params: {
    readonly conversationId: string;
    readonly agentId: string;
    readonly toolUseId: string;
    readonly toolName: string;
    readonly result: unknown;
    readonly isError?: boolean;
  }): MessageRow {
    return this.saveMessage({
      conversationId: params.conversationId,
      agentId: params.agentId,
      role: "system",
      contentJson: {
        type: "tool_result",
        tool_use_id: params.toolUseId,
        tool_name: params.toolName,
        result: params.result,
        is_error: params.isError ?? false,
      },
    });
  }

  /**
   * 获取对话中的消息数量
   */
  getMessageCount(conversationId: string): number {
    const row = this.db
      .prepare<{ count: number }>(
        "SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND is_streaming = 0",
      )
      .get(conversationId);
    return row?.count ?? 0;
  }

  /**
   * 删除对话及其所有消息（级联删除）
   */
  deleteConversation(conversationId: string): void {
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
    this.conversationCache.delete(conversationId);
    this.messageCache.deleteWhere((k) => k.startsWith(`${conversationId}|`));
  }

  /**
   * 删除 content_json 无法解析为 JSON 的消息（数据修复用）。
   */
  /**
   * 查询 content_json 文本中含特定子串的消息（用于迁移扫描，避免全表解析）。
   */
  loadMessagesContaining(substr: string, role?: string): readonly MessageRow[] {
    const like = `%${substr}%`;
    if (role) {
      return this.db
        .prepare<MessageRow>("SELECT * FROM messages WHERE role = ? AND content_json LIKE ?")
        .all(role, like) as MessageRow[];
    }
    return this.db
      .prepare<MessageRow>("SELECT * FROM messages WHERE content_json LIKE ?")
      .all(like) as MessageRow[];
  }

  /**
   * 直接用原始 JSON 字符串更新消息内容（仅供迁移使用）。
   */
  updateMessageContentRaw(messageId: string, contentJson: string): void {
    this.db
      .prepare("UPDATE messages SET content_json = ? WHERE id = ?")
      .run(contentJson, messageId);
    this.messageCache.deleteWhere((k) => k.includes("|"));
  }

  deleteMalformedMessages(): number {
    const rows = this.db
      .prepare<{ id: string; content_json: string }>("SELECT id, content_json FROM messages")
      .all();
    const bad: string[] = [];
    for (const row of rows) {
      try {
        JSON.parse(row.content_json);
      } catch {
        bad.push(row.id);
      }
    }
    if (bad.length === 0) return 0;
    let removed = 0;
    const del = this.db.prepare("DELETE FROM messages WHERE id = ?");
    withTransaction(this.db, () => {
      for (const id of bad) {
        removed += del.run(id).changes;
      }
    });
    this.messageCache.clear();
    return removed;
  }
}

// ─── 工具函数 ───

/**
 * 将 DB 消息行转换为 pi-agent AgentMessage 序列。
 * assistant_parts 按时间线顺序转换为内容块，并展开已完成工具的 toolResult 消息，
 * 确保 restoreHistoryForInstance 能恢复完整的工具执行上下文。
 */
export function messageRowToAgentMessages(row: MessageRow): readonly AgentMessage[] {
  const parsed = parseMessageContentJson(row.content_json);
  if (!parsed) {
    return [];
  }

  if (parsed.type === "text") {
    if (row.role !== "user") {
      return [];
    }
    return [{ role: "user", content: [{ type: "text", text: parsed.text }] } as AgentMessage];
  }

  if (parsed.type !== "assistant_parts" || row.role !== "assistant") {
    return [];
  }

  const assistantBlocks = parsed.parts.map((part) => assistantPartToPiBlock(part));
  const result: AgentMessage[] = [
    { role: "assistant", content: assistantBlocks } as unknown as AgentMessage,
  ];

  for (const part of parsed.parts) {
    if (
      part.type !== "tool" ||
      part.status === "running" ||
      part.result === undefined
    ) {
      continue;
    }
    const resultText =
      typeof part.result === "string" ? part.result : JSON.stringify(part.result);
    result.push({
      role: "toolResult",
      toolCallId: part.id,
      toolName: part.name,
      content: [{ type: "text", text: resultText }],
      ...(part.isError ? { isError: true } : {}),
    } as AgentMessage);
  }

  return result;
}

/**
 * 将单个助手时间线 part 转换为 pi-agent 内容块。
 */
function assistantPartToPiBlock(part: AssistantPart): PiContentBlock {
  if (part.type === "thinking") {
    return {
      type: "thinking",
      thinking: part.text,
      thinkingSignature: "reasoning_content",
    };
  }
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  return toolAssistantPartToPiBlock(part);
}

/**
 * 将工具 part 转换为 pi-agent toolCall 内容块。
 */
function toolAssistantPartToPiBlock(part: ToolAssistantPart): PiContentBlock {
  return {
    type: "toolCall",
    id: part.id,
    name: part.name,
    arguments: part.args,
  };
}

/**
 * 生成消息、会话使用的随机十六进制 ID。
 */
function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
