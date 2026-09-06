/**
 * 心跳感知信号与决策（纯逻辑，无副作用）
 *
 * 对应设计文档 10 §4.2：每个 tick 走「感知 → 决策 → 执行」。
 * 这里只放感知信号类型、信号收集（纯读库）与决策纯函数；
 * 执行动作（落独白 / 跑目标 / 发消息 / 反思）留在 windows 侧的 evolution-tick.ts。
 */

import { AutonomousRepo } from '../storage/autonomous-repo.js';
import type { DatabaseAdapter } from '../storage/local-database.js';
import { getOutreachUsedToday } from './outreach-budget.js';
import { MAX_OUTREACH_PER_DAY, REFLECTION_MIN_INTERVAL_HOURS } from './config.js';
import { hasWrittenDiaryToday } from './diary.js';

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
  /** 是否该触发反思（静默时段 + 距上次反思满 24h） */
  reflectionDue: boolean;
  /** 是否该写日记（静默时段 + 今天尚未写过） */
  diaryDue: boolean;
}

/** 单次心跳的决策结果 */
export interface TickAction {
  kind: 'idle' | 'execute-goal' | 'outreach' | 'reflect' | 'diary';
  reason: string;
  /** execute-goal / outreach 时携带要处理的目标 */
  goal?: ApprovedGoalSignal;
}

/**
 * 收集心跳感知信号。纯读库，不写任何状态。
 */
export function collectTickSignals(db: DatabaseAdapter, agentId: string, now = new Date()): TickSignals {
  const repo = new AutonomousRepo(db);
  // approve 命令经 notifyAutonomousGoalApproved 把目标流转到 executing，
  // 心跳必须消费 executing 状态，否则目标会永远卡住不被执行
  const approved = repo.listGoals(agentId, 'executing');
  return {
    approvedGoalCount: approved.length,
    approvedGoals: approved.map((g) => ({ id: g.id, type: g.type, description: g.description })),
    outreachUsedToday: getOutreachUsedToday(db, now),
    outreachLimit: MAX_OUTREACH_PER_DAY,
    reflectionDue: computeReflectionDue(repo, agentId, now),
    diaryDue: computeDiaryDue(db, now),
  };
}

/** 静默时段内且今天尚未写日记才触发 */
function computeDiaryDue(db: DatabaseAdapter, now: Date): boolean {
  const hour = now.getHours();
  const inQuietHours = hour >= 23 || hour < 8;
  return inQuietHours && !hasWrittenDiaryToday(db, now);
}

/** 静默时段（默认 23:00-08:00）内且距上次反思满 24h 才触发反思 */
function computeReflectionDue(repo: AutonomousRepo, agentId: string, now: Date): boolean {
  const hour = now.getHours();
  const inQuietHours = hour >= 23 || hour < 8;
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
 */
export function decideAction(signals: TickSignals): TickAction {
  const proactive = signals.approvedGoals.find((g) => g.type === 'proactive-message');
  if (proactive && signals.outreachUsedToday < signals.outreachLimit) {
    return { kind: 'outreach', reason: 'proactive-message-pending', goal: proactive };
  }
  const executable = signals.approvedGoals.find((g) => g.type !== 'proactive-message');
  if (executable) {
    return { kind: 'execute-goal', reason: 'approved-goal-pending', goal: executable };
  }
  if (signals.diaryDue) {
    return { kind: 'diary', reason: 'diary-due' };
  }
  if (signals.reflectionDue) {
    return { kind: 'reflect', reason: 'reflection-due' };
  }
  return { kind: 'idle', reason: 'no-action-needed' };
}
