/**
 * FileRepo — 客户端本地文件元数据 CRUD
 *
 * 管理 client_files 表，存储 Agent 生成文件和跨通道接收文件的元数据。
 * localPath 仅存相对于客户端数据根目录的路径，读取时由调用方拼接绝对路径。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseAdapter } from "./local-database.js";

// ─── 类型定义 ───

export type FileSourceType = "agent_output" | "channel_upload" | "user_upload";
export type FileCategory = "upload" | "output";

export interface ClientFileRow {
  readonly id: string;
  readonly user_id: string;
  readonly agent_id: string | null;
  readonly conversation_id: string | null;
  readonly message_id: string | null;
  readonly channel: string;
  readonly source_type: FileSourceType;
  readonly file_name: string;
  readonly file_size: number | null;
  readonly mime_type: string | null;
  readonly local_path: string;
  readonly category: FileCategory;
  readonly metadata: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

export interface ClientFile {
  readonly id: string;
  readonly userId: string;
  readonly agentId: string | null;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly channel: string;
  readonly sourceType: FileSourceType;
  readonly fileName: string;
  readonly fileSize: number | null;
  readonly mimeType: string | null;
  readonly localPath: string;
  readonly category: FileCategory;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface RegisterFileParams {
  readonly userId: string;
  readonly agentId?: string | null;
  readonly conversationId?: string | null;
  readonly messageId?: string | null;
  readonly channel?: string;
  readonly sourceType: FileSourceType;
  readonly fileName: string;
  readonly fileSize?: number | null;
  readonly mimeType?: string | null;
  readonly localPath: string;
  readonly category?: FileCategory;
  readonly metadata?: Record<string, unknown> | null;
}

export interface ListFilesOpts {
  readonly agentId?: string;
  readonly channel?: string;
  readonly category?: FileCategory;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SearchFilesOpts {
  readonly agentId?: string;
  readonly conversationId?: string;
  readonly channel?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

// ─── 工具函数 ───

function toClientFile(row: ClientFileRow): ClientFile {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      // 忽略解析错误，metadata 保持 null
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    channel: row.channel,
    sourceType: row.source_type as FileSourceType,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    localPath: row.local_path,
    category: row.category as FileCategory,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

// ─── 仓储类 ───

export class FileRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * 幂等注册文件
   *
   * 以 (conversationId, localPath) 为业务唯一键：
   * - 存在则更新 fileSize / mimeType / updatedAt / metadata
   * - 不存在则新建记录
   * 返回文件 ID。
   */
  registerOrUpdate(params: RegisterFileParams): string {
    const now = new Date().toISOString();
    const {
      userId,
      agentId = null,
      conversationId = null,
      messageId = null,
      channel = "windows",
      sourceType,
      fileName,
      fileSize = null,
      mimeType = null,
      localPath,
      category = "output",
      metadata = null,
    } = params;
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    // 若 conversationId 非空，先按唯一键查找
    if (conversationId) {
      const existing = this.db
        .prepare<{ id: string }>(
          "SELECT id FROM client_files WHERE conversation_id = ? AND local_path = ? AND deleted_at IS NULL",
        )
        .get(conversationId, localPath);

      if (existing) {
        this.db
          .prepare(
            `UPDATE client_files
             SET file_name = ?, file_size = ?, mime_type = ?, metadata = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(fileName, fileSize, mimeType, metadataJson, now, existing.id);
        return existing.id;
      }
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO client_files
           (id, user_id, agent_id, conversation_id, message_id, channel, source_type,
            file_name, file_size, mime_type, local_path, category, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        agentId,
        conversationId,
        messageId,
        channel,
        sourceType,
        fileName,
        fileSize,
        mimeType,
        localPath,
        category,
        metadataJson,
        now,
        now,
      );
    return id;
  }

  /** 按 ID 查询（不过滤软删除） */
  findById(fileId: string): ClientFile | null {
    const row = this.db
      .prepare<ClientFileRow>("SELECT * FROM client_files WHERE id = ?")
      .get(fileId);
    return row ? toClientFile(row) : null;
  }

  /** 按用户分页查询（过滤软删除） */
  listByUser(userId: string, opts: ListFilesOpts = {}): { files: ClientFile[]; total: number } {
    const { agentId, channel, category, limit = 50, offset = 0 } = opts;
    const conditions: string[] = ["user_id = ?", "deleted_at IS NULL"];
    const bindings: unknown[] = [userId];

    if (agentId) {
      conditions.push("agent_id = ?");
      bindings.push(agentId);
    }
    if (channel) {
      conditions.push("channel = ?");
      bindings.push(channel);
    }
    if (category) {
      conditions.push("category = ?");
      bindings.push(category);
    }

    const where = conditions.join(" AND ");

    const totalRow = this.db
      .prepare<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM client_files WHERE ${where}`)
      .get(...bindings);
    const total = totalRow?.cnt ?? 0;

    const rows = this.db
      .prepare<ClientFileRow>(
        `SELECT * FROM client_files WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...bindings, limit, offset);

    return { files: rows.map(toClientFile), total };
  }

  /** 按对话查询所有文件（不过滤软删除，用于级联删除） */
  listByConversation(conversationId: string): ClientFile[] {
    const rows = this.db
      .prepare<ClientFileRow>(
        "SELECT * FROM client_files WHERE conversation_id = ? AND deleted_at IS NULL",
      )
      .all(conversationId);
    return rows.map(toClientFile);
  }

  /** 查询指定时间前的软删除文件（用于定期硬删除） */
  listSoftDeletedBefore(threshold: Date): ClientFile[] {
    const rows = this.db
      .prepare<ClientFileRow>(
        "SELECT * FROM client_files WHERE deleted_at IS NOT NULL AND deleted_at < ?",
      )
      .all(threshold.toISOString());
    return rows.map(toClientFile);
  }

  /** 软删除文件 */
  softDelete(fileId: string, deletedAt: Date): void {
    this.db
      .prepare("UPDATE client_files SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(deletedAt.toISOString(), new Date().toISOString(), fileId);
  }

  /** 硬删除文件（从数据库彻底移除） */
  hardDelete(fileId: string): void {
    this.db.prepare("DELETE FROM client_files WHERE id = ?").run(fileId);
  }

  /** 标记文件丢失（在 metadata 中记录） */
  markMissing(fileId: string): void {
    const now = new Date().toISOString();
    const existing = this.findById(fileId);
    if (!existing) return;
    const metadata = existing.metadata ?? {};
    const newMeta = JSON.stringify({ ...metadata, missing: true, missingAt: now });
    this.db
      .prepare("UPDATE client_files SET metadata = ?, updated_at = ? WHERE id = ?")
      .run(newMeta, now, fileId);
  }

  /**
   * 按关键词 + 过滤条件搜索文件
   *
   * 支持文件名模糊匹配（LIKE）和元数据过滤。
   */
  search(userId: string, query: string, opts: SearchFilesOpts = {}): ClientFile[] {
    const { agentId, conversationId, channel, dateFrom, dateTo } = opts;
    const conditions: string[] = ["user_id = ?", "deleted_at IS NULL"];
    const bindings: unknown[] = [userId];

    if (query) {
      conditions.push("file_name LIKE ?");
      bindings.push(`%${query}%`);
    }
    if (agentId) {
      conditions.push("agent_id = ?");
      bindings.push(agentId);
    }
    if (conversationId) {
      conditions.push("conversation_id = ?");
      bindings.push(conversationId);
    }
    if (channel) {
      conditions.push("channel = ?");
      bindings.push(channel);
    }
    if (dateFrom) {
      conditions.push("created_at >= ?");
      bindings.push(dateFrom);
    }
    if (dateTo) {
      conditions.push("created_at <= ?");
      bindings.push(dateTo);
    }

    const where = conditions.join(" AND ");
    const rows = this.db
      .prepare<ClientFileRow>(
        `SELECT * FROM client_files WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
      )
      .all(...bindings);
    return rows.map(toClientFile);
  }
}
