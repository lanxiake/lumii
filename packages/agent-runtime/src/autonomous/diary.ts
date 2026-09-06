/**
 * 日记 Diary（第一人称主观视角）
 *
 * 对应设计文档 11 §9：一天一次第一人称日记，写进 evolution:main。
 * DIARY_PROMPT 是模板（含禁令），buildDiaryContext 聚合五块输入。
 */

import { readConcerns, type Concern } from './concerns.js';
import { type Mood } from './mood.js';
import type { DatabaseAdapter } from '../storage/local-database.js';

/** 日记提示词模板 —— 关键约束不可删（防写成指标报告/表演情绪） */
export const DIARY_PROMPT = [
  '你是灵栖 Lumii 的自主进化 Agent，现在写今天的日记。',
  '用第一人称写你今天的真实状态、在意的事和想法。',
  '如果今天很平淡，就写平淡，不要硬编出戏剧性。',
  '如果什么都没发生，写两句就停，别凑字数。',
  '不要出现 overall_score、满意度、成功率 等指标数字，也不要把情绪数值直接写出来。',
].join(' ');

/** 日记聚合的五块输入 */
export interface DiaryContext {
  goalsCompleted: string[];
  goalsFailed: string[];
  insights: string[];
  concerns: string[];
  mood: Mood;
}

/** 数据源（由调用方从 DB 读出，保持 buildDiaryContext 纯函数可测） */
export interface DiarySourceData {
  goals: Array<{ description: string; status: string }>;
  reflections: Array<{ primaryIssue: string }>;
  concerns: Concern[];
  mood: Mood;
}

/** 聚合日记上下文（纯函数） */
export function buildDiaryContext(data: DiarySourceData): DiaryContext {
  return {
    goalsCompleted: data.goals.filter((g) => g.status === 'completed').map((g) => g.description),
    goalsFailed: data.goals.filter((g) => g.status === 'failed').map((g) => g.description),
    insights: data.reflections.map((r) => r.primaryIssue),
    concerns: data.concerns.filter((c) => c.status === 'open').map((c) => c.description),
    mood: data.mood,
  };
}

const LAST_DIARY_KEY = 'autonomous.last_diary_date';

function dateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 今天是否已写过日记（防重） */
export function hasWrittenDiaryToday(db: DatabaseAdapter, now = new Date()): boolean {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(LAST_DIARY_KEY);
    return row?.value === dateKey(now);
  } catch {
    return false;
  }
}

/** 标记今天已写日记 */
export function markDiaryWritten(db: DatabaseAdapter, now = new Date()): void {
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LAST_DIARY_KEY, dateKey(now), new Date().toISOString());
}
