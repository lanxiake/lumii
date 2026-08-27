/**
 * WikiIndexRepo — wiki_pages_fts 派生索引的写入维护、重建与健康检查
 *
 * 与 memory-index.ts 同一方案：中文按 bigram、英文/数字按整词分词后空格拼接存入，
 * FTS5 侧仍用默认 unicode61（按空格切分）。理由见该文件与 schema.ts V16 注释——
 * unicode61/trigram 均无法直接支持中文 2 字词检索，已实测验证。
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { tokenizeBigram } from "../memory/segmentation.js";

export interface WikiFtsHealth {
  readonly isHealthy: boolean;
  readonly reason?: string;
}

export function wikiBigramJoin(text: string | null | undefined): string {
  if (!text) return "";
  return [...tokenizeBigram(text)].join(" ");
}

export class WikiIndexRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /** 写入/覆盖一条索引行（先删后插） */
  upsertRow(rowid: number | bigint, title: string, contentMd: string): void {
    this.db.prepare("DELETE FROM wiki_pages_fts WHERE rowid = ?").run(rowid);
    this.db
      .prepare("INSERT INTO wiki_pages_fts (rowid, title_tokens, content_tokens) VALUES (?, ?, ?)")
      .run(rowid, wikiBigramJoin(title), wikiBigramJoin(contentMd));
  }

  /** 删除单条索引行 */
  deleteRow(rowid: number | bigint): void {
    this.db.prepare("DELETE FROM wiki_pages_fts WHERE rowid = ?").run(rowid);
  }

  /**
   * 全量重建：清空后从 wiki_pages 重新分词灌入。
   * 用于：迁移后老数据补齐索引、`wiki:index:rebuild` 命令、索引不健康时的手动修复。
   */
  rebuildFts(): number {
    this.db.exec("DELETE FROM wiki_pages_fts");
    const rows = this.db
      .prepare<{ rowid: number; title: string; content_md: string }>(
        "SELECT rowid, title, content_md FROM wiki_pages",
      )
      .all();
    const insert = this.db.prepare(
      "INSERT INTO wiki_pages_fts (rowid, title_tokens, content_tokens) VALUES (?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(row.rowid, wikiBigramJoin(row.title), wikiBigramJoin(row.content_md));
    }
    return rows.length;
  }

  /** 健康检查：比对主表条数与 FTS 行数是否一致 */
  checkFtsHealth(): WikiFtsHealth {
    let mainCount: number;
    let ftsCount: number;
    try {
      mainCount = this.db.prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_pages").get()?.c ?? 0;
    } catch {
      return { isHealthy: false, reason: "wiki_pages 主表不可读" };
    }
    try {
      ftsCount =
        this.db.prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_pages_fts").get()?.c ?? 0;
    } catch {
      return { isHealthy: false, reason: "wiki_pages_fts 虚表不存在或不可读" };
    }
    if (mainCount !== ftsCount) {
      return { isHealthy: false, reason: `条数不一致：主表 ${mainCount} 条，索引 ${ftsCount} 条` };
    }
    return { isHealthy: true };
  }

  // ── wiki_sources_fts：资料层独立索引 ─────────────────────

  /** 写入/覆盖一条资料索引行（先删后插） */
  upsertSourceRow(rowid: number | bigint, title: string, extractedText: string | null): void {
    this.db.prepare("DELETE FROM wiki_sources_fts WHERE rowid = ?").run(rowid);
    this.db
      .prepare("INSERT INTO wiki_sources_fts (rowid, title_tokens, content_tokens) VALUES (?, ?, ?)")
      .run(rowid, wikiBigramJoin(title), wikiBigramJoin(extractedText));
  }

  /** 删除单条资料索引行 */
  deleteSourceRow(rowid: number | bigint): void {
    this.db.prepare("DELETE FROM wiki_sources_fts WHERE rowid = ?").run(rowid);
  }

  /**
   * 全量重建资料索引：清空后从 wiki_sources 重新分词灌入。
   * 用于：迁移后老数据补齐索引、`wiki:index:rebuild` 命令、索引不健康时的手动修复。
   */
  rebuildSourceFts(): number {
    this.db.exec("DELETE FROM wiki_sources_fts");
    const rows = this.db
      .prepare<{ rowid: number; title: string; extracted_text: string | null }>(
        "SELECT rowid, title, extracted_text FROM wiki_sources",
      )
      .all();
    const insert = this.db.prepare(
      "INSERT INTO wiki_sources_fts (rowid, title_tokens, content_tokens) VALUES (?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(row.rowid, wikiBigramJoin(row.title), wikiBigramJoin(row.extracted_text));
    }
    return rows.length;
  }

  /** 健康检查：比对 wiki_sources 主表条数与资料 FTS 行数是否一致 */
  checkSourceFtsHealth(): WikiFtsHealth {
    let mainCount: number;
    let ftsCount: number;
    try {
      mainCount = this.db.prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_sources").get()?.c ?? 0;
    } catch {
      return { isHealthy: false, reason: "wiki_sources 主表不可读" };
    }
    try {
      ftsCount =
        this.db.prepare<{ c: number }>("SELECT COUNT(*) as c FROM wiki_sources_fts").get()?.c ?? 0;
    } catch {
      return { isHealthy: false, reason: "wiki_sources_fts 虚表不存在或不可读" };
    }
    if (mainCount !== ftsCount) {
      return { isHealthy: false, reason: `条数不一致：主表 ${mainCount} 条，索引 ${ftsCount} 条` };
    }
    return { isHealthy: true };
  }
}
