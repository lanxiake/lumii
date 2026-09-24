/**
 * 主动消息预算（纯逻辑 + runtime_state 计数，按 agent 分账）
 *
 * 对应设计文档 10 §7：主动消息每日硬顶 + 跨通道合并计数。
 * 计数存 runtime_state 键 `autonomous.outreach:<agentId>:<YYYY-MM-DD>`，跨天自动归零；
 * 「上次发送时间」存 `autonomous.outreach:<agentId>:last_sent_at`。
 *
 * **按 agent 分账**（2026-09-24）：宠物说一句话会吃掉助手的额度，还会把助手的
 * 「上次说话时间」顶掉、让 `minOutreachIntervalMinutes` 跟着误判。老库的两个全局单键
 * 由 readAgentScopedState 一次性搬给 assistant。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';
import { RuntimeStateRepo } from '../storage/runtime-state-repo.js';
import { readAgentScopedState } from './agent-scoped-state.js';

/** 分键前的老键（全局单键，分键后按「属于 assistant」处理） */
const LEGACY_LAST_OUTREACH_AT_KEY = 'autonomous.outreach.last_sent_at';

function dateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 分键后的当日计数键：`autonomous.outreach:<agentId>:<YYYY-MM-DD>` */
function outreachCountKey(agentId: string, now: Date): string {
  return `autonomous.outreach:${agentId}:${dateKey(now)}`;
}

/**
 * 分键前的老键：`autonomous.outreach.<YYYY-MM-DD>`。
 *
 * 与分键后的键**差一个分隔符**（`.` vs `:`），两个前缀因此互不为前缀。
 */
function legacyOutreachCountKey(now: Date): string {
  return `autonomous.outreach.${dateKey(now)}`;
}

/** 分键后的上次发送时间键（非日期后缀，与计数键同族同 agent） */
function lastOutreachAtKey(agentId: string): string {
  return `autonomous.outreach:${agentId}:last_sent_at`;
}

/** 某 agent 今日已发送的主动消息数 */
export function getOutreachUsedToday(db: DatabaseAdapter, agentId: string, now: Date): number {
  const raw = readAgentScopedState(db, agentId, outreachCountKey(agentId, now), legacyOutreachCountKey(now));
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** 某 agent 今日是否还能发送主动消息 */
export function canSendOutreach(db: DatabaseAdapter, agentId: string, now: Date, max: number): boolean {
  return getOutreachUsedToday(db, agentId, now) < max;
}

/** 记一次主动消息（幂等计数，并更新该 agent 的上次发送时间戳） */
export function recordOutreach(db: DatabaseAdapter, agentId: string, now: Date): void {
  const repo = new RuntimeStateRepo(db);
  repo.set(outreachCountKey(agentId, now), String(getOutreachUsedToday(db, agentId, now) + 1));
  repo.set(lastOutreachAtKey(agentId), String(now.getTime()));
}

/** 某 agent 上次发送主动消息的时间戳（epoch ms），从未发送返回 null */
export function getLastOutreachAt(db: DatabaseAdapter, agentId: string): number | null {
  const raw = readAgentScopedState(db, agentId, lastOutreachAtKey(agentId), LEGACY_LAST_OUTREACH_AT_KEY);
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
