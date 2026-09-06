/**
 * 心跳感知信号与决策（纯逻辑，无副作用）
 *
 * 对应设计文档 10 §4.2：每个 tick 走「感知 → 决策 → 执行」。
 * 这里只放感知信号类型、信号收集（纯读库）与决策纯函数；
 * 执行动作（落独白 / 跑目标 / 发消息 / 反思）留在 windows 侧的 evolution-tick.ts。
 */

import { AutonomousRepo } from '../storage/autonomous-repo.js';
import type { DatabaseAdapter } from '../storage/local-database.js';
import { getOutreachUsedToday, getLastOutreachAt } from './outreach-budget.js';
import { REFLECTION_MIN_INTERVAL_HOURS } from './config.js';
import { hasWrittenDiaryToday } from './diary.js';
import { readSettings } from './settings.js';
import { TOKEN_COST, readTodayTokenUsage } from './token-budget.js';
import { readMood, moodToDecisionParams, circadianEnergy } from './mood.js';

/** 一条待执行的已批准目标（最小信号） */
export interface ApprovedGoalSignal {
  id: string;
  type: string;
  description: string;
}

/** 单次心跳感知到的信号 */
export interface TickSignals {
  /** 已批准、待执行（executing 状态）的目标数 */
  approvedGoalCount: number;
  /** 已批准、待执行目标列表（executing 状态，按创建时间倒序） */
  approvedGoals: ApprovedGoalSignal[];
  /** 今日主动消息已用量 */
  outreachUsedToday: number;
  /** 今日主动消息上限 */
  outreachLimit: number;
  /** 上次主动消息发送时间戳（epoch ms），从未发送为 null */
  outreachLastSentAt: number | null;
  /** 主动消息最小间隔（分钟） */
  minOutreachIntervalMinutes: number;
  /** 是否该触发反思（静默时段 + 距上次反思满 24h） */
  reflectionDue: boolean;
  /** 是否该写日记（静默时段 + 今天尚未写过） */
  diaryDue: boolean;
  /** 今日自主进化已消耗 token（预估累计） */
  tokenUsedToday: number;
  /** 每日自主进化 token 上限（readSettings().maxTokensPerDay） */
  tokenLimit: number;
  /** 是否有精力做重活（低 energy 时 false，来自 moodToDecisionParams） */
  willDoHeavyWork: boolean;
  /** 主动打扰系数（低 valence 时 0.5，来自 moodToDecisionParams） */
  outreachMultiplier: number;
  /** 心情差时更审慎（低 valence 时 true，来自 moodToDecisionParams） */
  selfCheckBias: boolean;
}

/** 单次心跳的决策结果 */
export interface TickAction {
  kind: 'idle' | 'execute-goal' | 'outreach' | 'reflect' | 'diary';
  reason: string;
  /** execute-goal / outreach 时携带要处理的目标 */
  goal?: ApprovedGoalSignal;
  /** execute-goal 时携带：心情差时提示审慎复查 */
  selfCheckBias?: boolean;
}

/**
 * 收集心跳感知信号。纯读库，不写任何状态。
 */
export function collectTickSignals(db: DatabaseAdapter, agentId: string, now = new Date()): TickSignals {
  const repo = new AutonomousRepo(db);
  // approve 命令经 notifyAutonomousGoalApproved 把目标流转到 executing，
  // 心跳必须消费 executing 状态，否则目标会永远卡住不被执行
  const approved = repo.listGoals(agentId, 'executing');
  const settings = readSettings(db);
  const mood = readMood(db, now.getTime());
  // 昼夜节律调制 energy：深夜自然不干重活、午间更活跃（设计 §7.2，零存储零 token）
  const effectiveMood = {
    ...mood,
    energy: Math.max(0, Math.min(1, mood.energy * circadianEnergy(now.getHours()))),
  };
  const decisionParams = moodToDecisionParams(effectiveMood);
  return {
    approvedGoalCount: approved.length,
    approvedGoals: approved.map((g) => ({ id: g.id, type: g.type, description: g.description })),
    outreachUsedToday: getOutreachUsedToday(db, now),
    outreachLimit: settings.maxOutreachPerDay,
    outreachLastSentAt: getLastOutreachAt(db),
    minOutreachIntervalMinutes: settings.minOutreachIntervalMinutes,
    reflectionDue: computeReflectionDue(repo, agentId, now, settings.quietHours),
    diaryDue: computeDiaryDue(db, now, settings.quietHours),
    tokenUsedToday: readTodayTokenUsage(db, now),
    tokenLimit: settings.maxTokensPerDay,
    willDoHeavyWork: decisionParams.willDoHeavyWork,
    outreachMultiplier: decisionParams.outreachMultiplier,
    selfCheckBias: decisionParams.selfCheckBias,
  };
}

/** 静默时段判定：支持跨午夜（如 [23,8] = 23:00-次日 8:00） */
function isInQuietHours(hour: number, start: number, end: number): boolean {
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** 静默时段内且今天尚未写日记才触发 */
function computeDiaryDue(db: DatabaseAdapter, now: Date, quietHours: [number, number]): boolean {
  const inQuietHours = isInQuietHours(now.getHours(), quietHours[0], quietHours[1]);
  return inQuietHours && !hasWrittenDiaryToday(db, now);
}

/** 静默时段内且距上次反思满 24h 才触发反思 */
function computeReflectionDue(
  repo: AutonomousRepo,
  agentId: string,
  now: Date,
  quietHours: [number, number],
): boolean {
  const inQuietHours = isInQuietHours(now.getHours(), quietHours[0], quietHours[1]);
  if (!inQuietHours) return false;

  const recent = repo.reflections(agentId, 1);
  const lastAt = recent[0]?.created_at;
  if (!lastAt) return true; // 从未反思
  const hoursSince = (now.getTime() - new Date(lastAt).getTime()) / 3_600_000;
  return hoursSince >= REFLECTION_MIN_INTERVAL_HOURS;
}

/**
 * 纯函数决策：信号 → 动作。
 *
 * 优先级：目标（主动消息 / 执行）优先于反思；无目标且该反思时才反思。
 * 主动消息预算用尽时跳过，不影响学习/能力类目标照常执行。
 * 烧 LLM 的动作（执行 / 日记 / 反思）受每日 token 预算约束，超限降级为 idle，
 * 避免后台无节制消耗；主动消息走系统通知不烧 LLM，不受 token 预算限制。
 */
export function decideAction(signals: TickSignals, now = new Date()): TickAction {
  // 低 valence 时减少主动打扰（outreachMultiplier 0.5 → 有效上限减半）
  const effectiveOutreachLimit = Math.floor(signals.outreachLimit * signals.outreachMultiplier);
  const proactive = signals.approvedGoals.find((g) => g.type === 'proactive-message');
  if (proactive && signals.outreachUsedToday < effectiveOutreachLimit && outreachIntervalSatisfied(signals, now)) {
    return { kind: 'outreach', reason: 'proactive-message-pending', goal: proactive };
  }
  const executable = signals.approvedGoals.find((g) => g.type !== 'proactive-message');
  if (executable) {
    // 低 energy 时跳过重活（目标执行），不影响主动消息/日记/反思
    if (!signals.willDoHeavyWork) {
      return { kind: 'idle', reason: 'low-energy' };
    }
    if (!tokenAllowed(signals, TOKEN_COST.executeGoal)) {
      return { kind: 'idle', reason: 'token-budget-exhausted' };
    }
    return { kind: 'execute-goal', reason: 'approved-goal-pending', goal: executable, selfCheckBias: signals.selfCheckBias };
  }
  if (signals.diaryDue) {
    if (!tokenAllowed(signals, TOKEN_COST.writeDiary)) {
      return { kind: 'idle', reason: 'token-budget-exhausted' };
    }
    return { kind: 'diary', reason: 'diary-due' };
  }
  if (signals.reflectionDue) {
    if (!tokenAllowed(signals, TOKEN_COST.reflect)) {
      return { kind: 'idle', reason: 'token-budget-exhausted' };
    }
    return { kind: 'reflect', reason: 'reflection-due' };
  }
  return { kind: 'idle', reason: 'no-action-needed' };
}

/** 本次动作预估成本 + 今日已消耗是否仍在每日 token 上限内 */
function tokenAllowed(signals: TickSignals, cost: number): boolean {
  return signals.tokenUsedToday + cost <= signals.tokenLimit;
}

/** 主动消息最小间隔是否满足（间隔 ≤ 0 或从未发送视为满足） */
function outreachIntervalSatisfied(signals: TickSignals, now: Date): boolean {
  const intervalMin = signals.minOutreachIntervalMinutes;
  if (intervalMin <= 0) return true;
  const last = signals.outreachLastSentAt;
  if (last == null) return true;
  const elapsedMin = (now.getTime() - last) / 60_000;
  return elapsedMin >= intervalMin;
}
