/**
 * 情绪状态 Mood（小时级波动，与月级的 Big Five 特质分层）
 *
 * 对应设计文档 11 §7。三维：energy（精力 0..1）、valence（心情 -1..1）、
 * arousal（兴趣唤起 0..1）。半衰期 4 小时向基线回归；昼夜节律是零存储纯函数；
 * 事件冲击是独立事件源（不复用 Big Five 的 5 个事件）。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';

/** 情绪状态 */
export interface Mood {
  energy: number;   // 0..1
  valence: number;  // -1..1
  arousal: number;  // 0..1
  updatedAt: number;
}

/** 决策参数（情绪必须影响决策，不只影响措辞） */
export interface DecisionParams {
  /** 是否有精力做重活（低 energy 时 false） */
  willDoHeavyWork: boolean;
  /** 主动打扰系数（低 valence 时 < 1，少打扰） */
  outreachMultiplier: number;
  /** 心情差时更审慎，倾向复查自己的结论（valence < -0.2 时 true） */
  selfCheckBias: boolean;
}

/** 桌宠表情（对齐 emotionMap 标准 key，见 renderer PetEmotionMapper） */
export type PetEmotion = 'joy' | 'sadness' | 'surprise' | 'neutral';

const MOOD_HALF_LIFE_MS = 4 * 60 * 60 * 1000;

const BASELINE: Omit<Mood, 'updatedAt'> = { energy: 0.6, valence: 0, arousal: 0.5 };

const MOOD_STATE_KEY = 'autonomous.mood';

/** 事件冲击表 —— 独立事件源，语义与 Big Five delta 不同 */
const MOOD_IMPACT: Record<string, { energy?: number; valence?: number; arousal?: number }> = {
  task_failed: { valence: -0.35, arousal: +0.2 }, // 失败让人在意：降心情、升唤起
  repeated_failure: { valence: -0.5, energy: -0.2 }, // 连续失败：更重打击，且耗竭精力
  task_perfect: { valence: +0.3, energy: +0.1 },
  praise: { valence: +0.4, energy: +0.15 },
  proactive_ignored: { valence: -0.2, energy: -0.1 },
  ask_silence: { valence: -0.3, energy: -0.3 },
  user_initiates: { arousal: +0.25, energy: +0.1 },
  novel_concept_found: { arousal: +0.4 }, // 发现新东西：唤起兴趣
  goal_completed: { valence: +0.25, arousal: -0.15 },
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 情绪随时间向基线衰减（半衰期 4h），返回新对象 */
export function decayMood(mood: Mood, now: number): Mood {
  const dt = Math.max(0, now - mood.updatedAt);
  const decay = Math.pow(0.5, dt / MOOD_HALF_LIFE_MS);
  return {
    energy: BASELINE.energy + (mood.energy - BASELINE.energy) * decay,
    valence: BASELINE.valence + (mood.valence - BASELINE.valence) * decay,
    arousal: BASELINE.arousal + (mood.arousal - BASELINE.arousal) * decay,
    updatedAt: now,
  };
}

/** 昼夜节律（纯函数，零存储）：午间最高、深夜最低，返回 0..1 */
export function circadianEnergy(hour: number): number {
  const phase = ((hour - 12) / 24) * 2 * Math.PI;
  return 0.5 + 0.5 * Math.cos(phase);
}

/** 事件冲击：按 MOOD_IMPACT 叠加，返回新对象 */
export function applyMoodImpact(mood: Mood, event: string): Mood {
  const impact = MOOD_IMPACT[event];
  if (!impact) return mood;
  return {
    energy: clamp(mood.energy + (impact.energy ?? 0), 0, 1),
    valence: clamp(mood.valence + (impact.valence ?? 0), -1, 1),
    arousal: clamp(mood.arousal + (impact.arousal ?? 0), 0, 1),
    updatedAt: mood.updatedAt,
  };
}

/** 情绪 → 决策参数（影响行为，不只措辞） */
export function moodToDecisionParams(mood: Mood): DecisionParams {
  return {
    willDoHeavyWork: mood.energy > 0.4,
    outreachMultiplier: mood.valence >= 0 ? 1 : 0.5,
    selfCheckBias: mood.valence < -0.2,
  };
}

/** 情绪 → 桌宠表情（不把 mood 数值展示给用户，只通过表情透出） */
export function moodToPetEmotion(mood: Mood): PetEmotion {
  if (mood.valence > 0.3 && mood.energy > 0.6) return 'joy';
  if (mood.arousal > 0.6) return 'surprise'; // 好奇/唤起
  if (mood.energy < 0.3) return 'neutral'; // 困倦
  if (mood.valence < -0.3) return 'sadness'; // 低落
  return 'neutral';
}

/** 读情绪状态（未写过返回基线） */
export function readMood(db: DatabaseAdapter, now = Date.now()): Mood {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(MOOD_STATE_KEY);
    if (!row) return { ...BASELINE, updatedAt: now };
    const parsed = JSON.parse(row.value) as Mood;
    return {
      energy: clamp(parsed.energy, 0, 1),
      valence: clamp(parsed.valence, -1, 1),
      arousal: clamp(parsed.arousal, 0, 1),
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return { ...BASELINE, updatedAt: now };
  }
}

/** 写情绪状态 */
export function writeMood(db: DatabaseAdapter, mood: Mood): void {
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(MOOD_STATE_KEY, JSON.stringify(mood), new Date().toISOString());
}
