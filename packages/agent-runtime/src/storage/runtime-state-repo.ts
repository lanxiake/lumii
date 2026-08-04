/**
 * RuntimeStateRepo — KV 状态存取
 *
 * 通用键值存储，用于保存运行时状态信息。
 * 支持带 TTL 的值与过期清理。
 */

import type { DatabaseAdapter } from "./local-database.js";

/** 带过期时间的内部包装结构 */
const TTL_KEY = "__ar_ttl_v1" as const;

interface TtlWrapped {
  readonly [TTL_KEY]: true;
  readonly exp: number;
  readonly data: unknown;
}

function isTtlWrapped(v: unknown): v is TtlWrapped {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o[TTL_KEY] === true && typeof o.exp === "number";
}

/**
 * 解析一行 value：区分 TTL 包装与普通 JSON / 纯文本。
 */
function parseStoredValue(raw: string): {
  readonly expired: boolean;
  readonly ttlPayload: unknown | undefined;
} {
  try {
    const j: unknown = JSON.parse(raw);
    if (isTtlWrapped(j)) {
      if (Date.now() > j.exp) {
        return { expired: true, ttlPayload: undefined };
      }
      return { expired: false, ttlPayload: j.data };
    }
  } catch {
    /* 非 JSON，当作普通字符串 */
  }
  return { expired: false, ttlPayload: undefined };
}

// ─── Repo 实现 ───

export class RuntimeStateRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * 获取字符串值（非 TTL 键为原始存储；TTL 键解包为 string）
   */
  getString(key: string): string | undefined {
    const raw = this.get(key);
    if (raw === undefined) return undefined;
    const { expired, ttlPayload } = parseStoredValue(raw);
    if (expired) {
      this.delete(key);
      return undefined;
    }
    if (ttlPayload !== undefined) {
      return typeof ttlPayload === "string" ? ttlPayload : String(ttlPayload);
    }
    try {
      const j: unknown = JSON.parse(raw);
      if (typeof j === "string") return j;
    } catch {
      return raw;
    }
    return undefined;
  }

  /**
   * 获取数值（支持 TTL 包装或纯数字字符串）
   */
  getNumber(key: string): number | undefined {
    const raw = this.get(key);
    if (raw === undefined) return undefined;
    const { expired, ttlPayload } = parseStoredValue(raw);
    if (expired) {
      this.delete(key);
      return undefined;
    }
    if (ttlPayload !== undefined) {
      if (typeof ttlPayload === "number" && Number.isFinite(ttlPayload)) return ttlPayload;
      const n = Number(ttlPayload);
      return Number.isFinite(n) ? n : undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  /**
   * 获取 JSON 对象（与 getJson 行为一致，优先支持 TTL 包装）
   */
  getObject<T>(key: string): T | undefined {
    const raw = this.get(key);
    if (raw === undefined) return undefined;
    const { expired, ttlPayload } = parseStoredValue(raw);
    if (expired) {
      this.delete(key);
      return undefined;
    }
    if (ttlPayload !== undefined) {
      return ttlPayload as T;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

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
    return this.getObject<T>(key);
  }

  /**
   * 设置带过期时间的任意可 JSON 序列化值。
   */
  setWithExpiry(key: string, value: unknown, ttlMs: number): void {
    const exp = Date.now() + Math.max(0, ttlMs);
    const wrapped: TtlWrapped = {
      [TTL_KEY]: true,
      exp,
      data: value,
    };
    this.set(key, JSON.stringify(wrapped));
  }

  /**
   * 扫描并删除所有已过期的 TTL 键。
   */
  cleanupExpired(): number {
    let removed = 0;
    for (const key of this.keys()) {
      const raw = this.get(key);
      if (!raw) continue;
      const { expired } = parseStoredValue(raw);
      if (expired) {
        if (this.delete(key)) removed += 1;
      }
    }
    return removed;
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
   * 列出所有键
   */
  keys(): readonly string[] {
    return this.db
      .prepare<{ key: string }>("SELECT key FROM runtime_state ORDER BY key")
      .all()
      .map((r) => r.key);
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
