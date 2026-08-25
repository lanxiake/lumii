/**
 * MemoryIndexRepo — agent_memories_fts 派生索引的写入维护、重建与健康检查
 *
 * FTS5 内置分词器（unicode61 按 Unicode 字符切分、trigram 要求查询词 >=3 字符）
 * 均无法直接支持中文 2 字关键词搜索（已用 node:sqlite 3.53.3 实测验证）。
 * 采用应用层预分词方案：写入前用项目已有的 `tokenizeBigram` 对中文按 bigram 切分、
 * 空格拼接后存入 FTS5 列，FTS5 侧仍用默认 unicode61（按空格切分英文/数字/bigram token）。
 *
 * 分词发生在 JS 侧，SQL 触发器做不到，因此索引维护改为应用代码在写入点手动调用
 * （见 memory-repo.ts 的 saveCandidate / updateContentById / removeById / clearAllForAgent），
 * 不再用 SQL 触发器自动同步。
 *
 * 设计：`docs/design/记忆设计/2026-08-24-memory-design.md` §3.2（已按此调整，见文档内说明）
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { tokenizeBigram } from "./segmentation.js";

export interface FtsHealth {
  readonly isHealthy: boolean;
  readonly reason?: string;
}

/** 中文按 bigram、英文/数字按整词分词后用空格拼接，供 FTS5 unicode61 按空格切分 */
export function bigramJoin(text: string | null | undefined): string {
  if (!text) return "";
  return [...tokenizeBigram(text)].join(" ");
}

export class MemoryIndexRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /** 写入/覆盖一条索引行（先删后插，FTS5 不支持原地 UPDATE 语义之外的直接覆盖） */
  upsertRow(rowid: number | bigint, content: string, tags: string | null): void {
    this.db.prepare("DELETE FROM agent_memories_fts WHERE rowid = ?").run(rowid);
    this.db
      .prepare("INSERT INTO agent_memories_fts (rowid, content, tags) VALUES (?, ?, ?)")
      .run(rowid, bigramJoin(content), bigramJoin(tags));
  }

  /** 删除单条索引行 */
  deleteRow(rowid: number | bigint): void {
    this.db.prepare("DELETE FROM agent_memories_fts WHERE rowid = ?").run(rowid);
  }

  /** 批量删除索引行 */
  deleteRows(rowids: readonly (number | bigint)[]): void {
    if (rowids.length === 0) return;
    const stmt = this.db.prepare("DELETE FROM agent_memories_fts WHERE rowid = ?");
    for (const rowid of rowids) stmt.run(rowid);
  }

  /**
   * 全量重建：清空后从 agent_memories 重新分词灌入。
   * 用于：迁移后老数据补齐索引、`agent:memories:rebuildIndex` 命令、索引不健康时的手动修复。
   */
  rebuildFts(): void {
    this.db.exec("DELETE FROM agent_memories_fts");
    const rows = this.db
      .prepare<{ rowid: number; content: string; tags: string | null }>(
        "SELECT rowid, content, tags FROM agent_memories",
      )
      .all();
    const insert = this.db.prepare(
      "INSERT INTO agent_memories_fts (rowid, content, tags) VALUES (?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(row.rowid, bigramJoin(row.content), bigramJoin(row.tags));
    }
  }

  /**
   * 健康检查：比对主表条数与 FTS 行数是否一致。
   * FTS 表缺失（如手动 DROP）时视为不健康，不抛异常。
   */
  checkFtsHealth(): FtsHealth {
    let mainCount: number;
    let ftsCount: number;
    try {
      mainCount =
        this.db.prepare<{ c: number }>("SELECT COUNT(*) as c FROM agent_memories").get()?.c ?? 0;
    } catch {
      return { isHealthy: false, reason: "agent_memories 主表不可读" };
    }
    try {
      ftsCount =
        this.db.prepare<{ c: number }>("SELECT COUNT(*) as c FROM agent_memories_fts").get()?.c ??
        0;
    } catch {
      return { isHealthy: false, reason: "agent_memories_fts 虚表不存在或不可读" };
    }
    if (mainCount !== ftsCount) {
      return {
        isHealthy: false,
        reason: `条数不一致：主表 ${mainCount} 条，索引 ${ftsCount} 条`,
      };
    }
    return { isHealthy: true };
  }
}
