/**
 * 主动消息每日预算（纯逻辑 + runtime_state 计数）
 *
 * 对应设计文档 10 §7：主动消息每日硬顶 + 跨通道合并计数。
 * 计数存 runtime_state 键 autonomous.outreach.{YYYY-MM-DD}，跨天自动归零。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';

const OUTREACH_KEY_PREFIX = 'autonomous.outreach.';

function dateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${OUTREACH_KEY_PREFIX}${y}-${m}-${d}`;
}

/** 今日已发送的主动消息数 */
export function getOutreachUsedToday(db: DatabaseAdapter, now: Date): number {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(dateKey(now));
    if (!row) return 0;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** 今日是否还能发送主动消息 */
export function canSendOutreach(db: DatabaseAdapter, now: Date, max: number): boolean {
  return getOutreachUsedToday(db, now) < max;
}

/** 记一次主动消息（幂等计数） */
export function recordOutreach(db: DatabaseAdapter, now: Date): void {
  const key = dateKey(now);
  const next = getOutreachUsedToday(db, now) + 1;
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, String(next), new Date().toISOString());
}
