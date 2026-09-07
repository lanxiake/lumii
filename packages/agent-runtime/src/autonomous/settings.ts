/**
 * 自主进化可配置参数（设置页暴露，算法权重不暴露）
 *
 * 对应设计文档 11 §1：三档参数暴露。用户可调的是心跳频率、配额、审批模式等；
 * 算法权重（SATISFACTION_WEIGHTS / EMA_ALPHA / UCB_CONFIDENCE）绝不暴露。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';

export interface AutonomousSettings {
  enabled: boolean;
  tickIntervalMinutes: number;      // 默认 10，范围 5-60
  quietHours: [number, number];     // 默认 [23, 8]
  maxOutreachPerDay: number;        // 默认 20，范围 0-50
  minOutreachIntervalMinutes: number; // 默认 60
  outreachChannels: string[];       // 默认 ['system']
  maxTokensPerDay: number;          // 默认 100000
  maxGoalsPerDay: number;           // 默认 7，范围 1-20
  approvalMode: 'always' | 'risky-only' | 'never';
  /** 反思建议目标采纳阈值（0~1）：suggestedGoals 的 priority 达到该值才落成真实目标 */
  reflectionGoalPriorityThreshold: number;
}

export const DEFAULT_SETTINGS: AutonomousSettings = {
  enabled: true,
  tickIntervalMinutes: 10,
  quietHours: [23, 8],
  maxOutreachPerDay: 20,
  minOutreachIntervalMinutes: 60,
  outreachChannels: ['system'],
  maxTokensPerDay: 100000,
  maxGoalsPerDay: 7,
  approvalMode: 'always',
  reflectionGoalPriorityThreshold: 0.5,
};

const SETTINGS_KEY = 'autonomous.settings';

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return fallback;
  return Math.round(n);
}

function clampFloat(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return fallback;
  return n;
}

/** 读设置：用户覆盖合并默认值，非法值回落默认 */
export function readSettings(db: DatabaseAdapter): AutonomousSettings {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(SETTINGS_KEY);
    if (!row) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(row.value) as Partial<AutonomousSettings>;
    const qh = Array.isArray(parsed.quietHours) ? parsed.quietHours : DEFAULT_SETTINGS.quietHours;
    return {
      enabled: parsed.enabled !== false,
      tickIntervalMinutes: clampInt(parsed.tickIntervalMinutes, 5, 60, DEFAULT_SETTINGS.tickIntervalMinutes),
      quietHours: [
        clampInt(qh[0], 0, 23, DEFAULT_SETTINGS.quietHours[0]),
        clampInt(qh[1], 0, 23, DEFAULT_SETTINGS.quietHours[1]),
      ],
      maxOutreachPerDay: clampInt(parsed.maxOutreachPerDay, 0, 50, DEFAULT_SETTINGS.maxOutreachPerDay),
      minOutreachIntervalMinutes: clampInt(
        parsed.minOutreachIntervalMinutes,
        0,
        24 * 60,
        DEFAULT_SETTINGS.minOutreachIntervalMinutes,
      ),
      outreachChannels: Array.isArray(parsed.outreachChannels)
        ? parsed.outreachChannels.filter((c): c is string => typeof c === 'string')
        : DEFAULT_SETTINGS.outreachChannels,
      maxTokensPerDay: clampInt(parsed.maxTokensPerDay, 0, 1_000_000, DEFAULT_SETTINGS.maxTokensPerDay),
      maxGoalsPerDay: clampInt(parsed.maxGoalsPerDay, 1, 20, DEFAULT_SETTINGS.maxGoalsPerDay),
      approvalMode:
        parsed.approvalMode === 'risky-only' || parsed.approvalMode === 'never'
          ? parsed.approvalMode
          : 'always',
      reflectionGoalPriorityThreshold: clampFloat(
        parsed.reflectionGoalPriorityThreshold,
        0,
        1,
        DEFAULT_SETTINGS.reflectionGoalPriorityThreshold,
      ),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 写设置（部分覆盖） */
export function writeSettings(db: DatabaseAdapter, settings: Partial<AutonomousSettings>): void {
  const merged = { ...readSettings(db), ...settings };
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(SETTINGS_KEY, JSON.stringify(merged), new Date().toISOString());
}
