/**
 * RuntimeStateRepo — KV 状态存取
 *
 * 通用键值存储，用于保存运行时状态信息。
 */

import type { DatabaseAdapter } from "./local-database.js";

// ─── Repo 实现 ───

export class RuntimeStateRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * 获取字符串值
   */
  get(key: string): string | undefined {
    const row = this.db
      .prepare<{ value: string }>("SELECT value FROM runtime_state WHERE key = ?")
      .get(key);
    return row?.value;
  }

  /**
   * 获取 JSON 值
   */
  getJson<T>(key: string): T | undefined {
    const raw = this.get(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * 设置字符串值（upsert）
   */
  set(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runtime_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  /**
   * 设置 JSON 值
   */
  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  /**
   * 删除值
   */
  delete(key: string): boolean {
    const result = this.db.prepare("DELETE FROM runtime_state WHERE key = ?").run(key);
    return result.changes > 0;
  }

  /**
   * 检查键是否存在
   */
  has(key: string): boolean {
    const row = this.db
      .prepare<{ key: string }>("SELECT key FROM runtime_state WHERE key = ?")
      .get(key);
    return row !== undefined;
  }

  /**
   * 按前缀列出键值对
   */
  listByPrefix(prefix: string): ReadonlyArray<{ key: string; value: string }> {
    return this.db
      .prepare<{ key: string; value: string }>(
        "SELECT key, value FROM runtime_state WHERE key LIKE ? ORDER BY key",
      )
      .all(`${prefix}%`);
  }
}
