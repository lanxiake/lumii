/**
 * PalaceIndexRepo — palace_drawers_fts 派生索引的写入维护、重建与健康检查
 *
 * 与 `memory-index.ts`（agent_memories_fts）**同构**：FTS5 的 unicode61 分词器把中文
 * 连续串当成一整个 token（不切分），2 字关键词永远命不中，所以预分词只能在 JS 侧用
 * `tokenizeBigram` 做、索引维护只能由应用代码在写入点手动调用（不用 SQL 触发器——
 * 触发器里跑不了 JS）。
 *
 * 与工作记忆索引的唯一差别是承载的表名。刻意保持同构而不是抽公共基类：两者的
 * 重建谓词、健康判据将来可能各自演化（如宫殿要排除被取代的段），提前抽象会把两处
 * 约束绑死。
 *
 * 设计：`docs/plans/记忆系统/2026-09-17-自建记忆宫殿实施计划.md` §2.3 / T2
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { bigramJoin } from "./memory-index.js";

export interface PalaceFtsHealth {
  readonly isHealthy: boolean;
  readonly reason?: string;
}

export class PalaceIndexRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /** 写入/覆盖一条索引行（先删后插：FTS5 不支持原地覆盖） */
  upsertRow(rowid: number | bigint, content: string): void {
    this.db.prepare("DELETE FROM palace_drawers_fts WHERE rowid = ?").run(rowid);
    this.db
      .prepare("INSERT INTO palace_drawers_fts (rowid, content) VALUES (?, ?)")
      .run(rowid, bigramJoin(content));
  }

  /** 删除单条索引行 */
  deleteRow(rowid: number | bigint): void {
    this.db.prepare("DELETE FROM palace_drawers_fts WHERE rowid = ?").run(rowid);
  }

  /** 批量删除索引行 */
  deleteRows(rowids: readonly (number | bigint)[]): void {
    if (rowids.length === 0) return;
    const stmt = this.db.prepare("DELETE FROM palace_drawers_fts WHERE rowid = ?");
    for (const rowid of rowids) stmt.run(rowid);
  }

  /**
   * 全量重建：清空后从 `palace_drawers` 重新分词灌入。
   *
   * **只索引未写墓碑的行**——与 `MemoryIndexRepo.rebuildFts()` 同一条教训：
   * 墓碑行在 FTS 里必须缺席，否则重建一次就把删掉的原文重新变成可检索的。
   */
  rebuildFts(): number {
    this.db.exec("DELETE FROM palace_drawers_fts");
    const rows = this.db
      .prepare<{ rowid: number; content: string }>(
        "SELECT rowid, content FROM palace_drawers WHERE deleted_at IS NULL",
      )
      .all();
    const insert = this.db.prepare(
      "INSERT INTO palace_drawers_fts (rowid, content) VALUES (?, ?)",
    );
    for (const row of rows) {
      insert.run(row.rowid, bigramJoin(row.content));
    }
    return rows.length;
  }

  /**
   * 健康检查：比对**活跃**主表条数与 FTS 行数。
   * 虚表缺失（如手动 DROP）时视为不健康，不抛异常。
   */
  checkFtsHealth(): PalaceFtsHealth {
    let mainCount: number;
    let ftsCount: number;
    try {
      mainCount =
        this.db
          .prepare<{ c: number }>(
            "SELECT COUNT(*) as c FROM palace_drawers WHERE deleted_at IS NULL",
          )
          .get()?.c ?? 0;
    } catch {
      return { isHealthy: false, reason: "palace_drawers 主表不可读" };
    }
    try {
      ftsCount =
        this.db
          .prepare<{ c: number }>("SELECT COUNT(*) as c FROM palace_drawers_fts")
          .get()?.c ?? 0;
    } catch {
      return { isHealthy: false, reason: "palace_drawers_fts 虚表不存在或不可读" };
    }
    if (mainCount !== ftsCount) {
      return {
        isHealthy: false,
        reason: `条数不一致：活跃主表 ${mainCount} 条，索引 ${ftsCount} 条`,
      };
    }
    return { isHealthy: true };
  }
}
