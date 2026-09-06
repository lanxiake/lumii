/**
 * 牵挂 Concerns（跨时间连续性）
 *
 * 对应设计文档 11 §8：让 Agent 记得自己在意、但还没结论的事。
 * 复用 runtime_state JSON 存储（零 schema 迁移），不塞进 autonomous_goals
 * （其 type 列 CHECK 约束不允许 follow-up 之外的自定义类型）。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';

/** 一条牵挂 */
export interface Concern {
  id: string;
  description: string;
  origin: string; // 来源会话 / 目标 id
  arousalWeight: number; // 产生时 mood.arousal
  raisedCount: number;
  nextRaiseAfter: number; // 下次可提起的时间戳（ms）
  status: 'open' | 'resolved' | 'dropped';
}

const CONCERNS_KEY = 'autonomous.concerns';
/** 同一件事最多提 2 次，第 2 次无回应 → dropped */
const MAX_RAISES = 2;

/**
 * 挑一条当前可提起的牵挂：open、未超 2 次、已到可提起时间。
 * 按 arousalWeight 降序取最在意的一条；无可提返回 null。
 */
export function pickConcernToRaise(concerns: Concern[], now: number): Concern | null {
  const eligible = concerns.filter(
    (c) => c.status === 'open' && c.raisedCount < MAX_RAISES && now >= c.nextRaiseAfter,
  );
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => b.arousalWeight - a.arousalWeight)[0] ?? null;
}

/** 读全部牵挂 */
export function readConcerns(db: DatabaseAdapter): Concern[] {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(CONCERNS_KEY);
    if (!row) return [];
    return JSON.parse(row.value) as Concern[];
  } catch {
    return [];
  }
}

/** 写全部牵挂 */
export function writeConcerns(db: DatabaseAdapter, concerns: Concern[]): void {
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(CONCERNS_KEY, JSON.stringify(concerns), new Date().toISOString());
}

/** 记一次提起：raisedCount+1，第 2 次后 dropped；间隔递增（24h → 72h） */
export function markConcernRaised(concerns: Concern[], id: string, now: number): Concern[] {
  return concerns.map((c) => {
    if (c.id !== id) return c;
    const raisedCount = c.raisedCount + 1;
    const status: Concern['status'] = raisedCount >= MAX_RAISES ? 'dropped' : 'open';
    const nextRaiseAfter = raisedCount === 1 ? now + 72 * 3_600_000 : c.nextRaiseAfter;
    return { ...c, raisedCount, status, nextRaiseAfter };
  });
}
