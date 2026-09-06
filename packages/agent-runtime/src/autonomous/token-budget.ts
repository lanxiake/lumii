/**
 * 每日自主进化 token 预算（预估式）
 *
 * 心跳 tick 里真实烧 LLM 的动作只有三个：目标执行（完整 Agent 循环）、反思、
 * 日记。主动消息走系统通知不烧 LLM。这里用固定预估成本做「上限保护」，
 * 避免自主进化在后台无节制消耗 token —— 不是精确计费，够用即可。
 *
 * 预算上限来自 readSettings().maxTokensPerDay，今日已消耗落
 * runtime_state 键 autonomous.tokens.{YYYY-MM-DD}，跨天自然重置。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';

/** 各动作预估 token 成本（偏保守，向上取整） */
export const TOKEN_COST = {
  /** 目标执行：完整 Agent 循环 + 工具调用，是最大头 */
  executeGoal: 8000,
  /** 反思：输入（满意度/能力/会话摘要）约 3000 + 输出上限 2000 */
  reflect: 5000,
  /** 日记：单次生成，输入素材 + 输出正文 */
  writeDiary: 2000,
  /** 主动消息：系统通知不调 LLM，几乎为 0 */
  outreach: 0,
} as const;

const TOKEN_KEY_PREFIX = 'autonomous.tokens.';

function dayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 读取今日已消耗 token（无记录或脏数据按 0） */
export function readTodayTokenUsage(db: DatabaseAdapter, now: Date): number {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(TOKEN_KEY_PREFIX + dayKey(now));
    if (!row) return 0;
    const n = Number(row.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 累加今日 token 消耗（幂等：以 value 存累计值，非增量记录） */
export function recordTokenUsage(db: DatabaseAdapter, now: Date, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const key = TOKEN_KEY_PREFIX + dayKey(now);
  const current = readTodayTokenUsage(db, now);
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, String(current + tokens), now.toISOString());
}

/** 检查预算：本次动作预估成本加上今日已消耗，是否仍在每日上限内 */
export function canSpendTokens(
  db: DatabaseAdapter,
  now: Date,
  cost: number,
  maxPerDay: number,
): boolean {
  return readTodayTokenUsage(db, now) + cost <= maxPerDay;
}
