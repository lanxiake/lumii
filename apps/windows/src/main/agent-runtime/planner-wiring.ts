/**
 * 主动规划器编排（windows 侧）
 *
 * 把纯逻辑（planner.ts）与落地（planner-landing.ts）串起来：
 * 读真实原料（反思/目标/牵挂/Mood/预算）→ 构造提示词 → callLLM → 解析 → 预算裁剪 → 落库 → 调度 cron。
 *
 * 触发点在 bridge 侧：反思之后（force）与心跳 24h 兜底（fallback）。
 */

import {
  AutonomousRepo,
  buildPlannerPrompt,
  parsePlannerOutput,
  enforcePlanBudget,
  landPlannerPlan,
  readMood,
  readConcerns,
  readSettings,
  readTodayTokenUsage,
  getOutreachUsedToday,
  MAX_SELF_CRON_JOBS,
  PLANNER_MIN_INTERVAL_HOURS,
  type DatabaseAdapter,
  type LandedCronJob,
  type PlannerPlan,
  type PlannerInput,
  type PlannerBudget,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

export interface PlannerWiringDeps {
  db: DatabaseAdapter
  callLLM: (prompt: string) => Promise<string>
  /** 落地后启动 cron 计时器 */
  scheduleCron: (job: LandedCronJob) => void
  /** 当前 agent-self:* 自建任务数（预算上限用） */
  countAgentSelfCronJobs: () => number
}

const LAST_PLAN_KEY = 'autonomous.last_plan_at'

function readLastPlanAt(db: DatabaseAdapter): string | null {
  try {
    const row = db
      .prepare<{ value: string }>('SELECT value FROM runtime_state WHERE key = ?')
      .get(LAST_PLAN_KEY)
    return row?.value ?? null
  } catch {
    return null
  }
}

function writeLastPlanAt(db: DatabaseAdapter, now: Date): void {
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LAST_PLAN_KEY, now.toISOString(), now.toISOString())
}

function isInQuietHours(hour: number, quietHours: [number, number]): boolean {
  const [start, end] = quietHours;
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** 今天是否还没有 planner 产出的目标（planner 目标按 created_at 落在今天） */
function hasPlannerGoalsToday(db: DatabaseAdapter, now: Date): boolean {
  try {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const row = db
      .prepare<{ count: number }>(
        `SELECT COUNT(*) as count FROM autonomous_goals
          WHERE planned_by = 'planner' AND created_at >= ? AND agent_id = 'assistant'`,
      )
      .get(todayStart);
    return (row?.count ?? 0) > 0;
  } catch {
    return true;
  }
}

/** 心跳兜底判定：静默时段内且距上次规划满 24h（从未规划也视为到期），或今天还没主动规划过 */
export function shouldFallbackPlan(db: DatabaseAdapter, now: Date): boolean {
  // 今天还没有 planner 目标 → 触发一次规划（启动 / 心跳首次兜底），不再受静默时段与 24h 门槛限制
  if (!hasPlannerGoalsToday(db, now)) return true;
  const settings = readSettings(db);
  if (!isInQuietHours(now.getHours(), settings.quietHours)) return false;
  const last = readLastPlanAt(db);
  if (!last) return true;
  return now.getTime() - new Date(last).getTime() >= PLANNER_MIN_INTERVAL_HOURS * 3_600_000;
}

function safeParseArray(raw: string): unknown[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 计算剩余预算：token / 主动消息 / 目标配额 / 自建 cron 槽位 */
function computePlannerBudget(
  db: DatabaseAdapter,
  countAgentSelfCronJobs: () => number,
  now: Date,
): PlannerBudget {
  const settings = readSettings(db);
  const repo = new AutonomousRepo(db);
  // 卡单即停发：统计全部 open 目标（历史 pending 卡住时不再产新，防重复累积；
  // 修复前只统计当天新建，旧目标卡死反而每天继续产新——2026-09-12 EVO 缺陷 #4）
  const openCount = repo
    .listGoals('assistant')
    .filter(
      (g) => g.status === 'pending' || g.status === 'approved' || g.status === 'executing',
    ).length;
  return {
    tokensRemaining: settings.maxTokensPerDay - readTodayTokenUsage(db, now),
    outreachRemaining: settings.maxOutreachPerDay - getOutreachUsedToday(db, now),
    goalsRemaining: Math.max(0, settings.maxGoalsPerDay - openCount),
    cronSlotsRemaining: Math.max(0, MAX_SELF_CRON_JOBS - countAgentSelfCronJobs()),
  };
}

/**
 * 跑一次主动规划：读原料 → LLM → 解析 → 裁剪 → 落库 → 调度 cron。
 * 全程 try-catch，失败只记日志并返回 null，绝不影响调用方（反思/心跳）。
 */
export async function runPlanner(deps: PlannerWiringDeps): Promise<PlannerPlan | null> {
  const db = deps.db;
  try {
    const now = new Date();
    const settings = readSettings(db);
    const repo = new AutonomousRepo(db);

    // 1. 原料：最近反思 / 未完成目标 / open 牵挂 / Mood / 预算
    const recent = repo.reflections('assistant', 1)[0];
    const recs = recent ? safeParseArray(recent.recommendations) : [];
    const suggested = recent ? safeParseArray(recent.suggested_goals) : [];
    const reflection = recent
      ? {
          primaryIssue: recent.primary_issue,
          rootCause: recent.root_cause,
          recommendations: recs.map((r) =>
            typeof (r as { description?: string })?.description === 'string'
              ? (r as { description: string }).description
              : String(r),
          ),
          suggestedGoals: suggested.map((g) => {
            const o = g as { type?: string; description?: string; priority?: number };
            return {
              type: o?.type ?? 'learning',
              description: o?.description ?? '',
              priority: typeof o?.priority === 'number' ? o.priority : 0.5,
            };
          }),
        }
      : null;

    const openGoals = repo
      .listGoals('assistant')
      .filter((g) => g.status === 'pending' || g.status === 'executing' || g.status === 'approved');
    const currentGoals = openGoals.map((g) => ({
      description: g.description,
      status: g.status,
      scheduledFor: g.scheduled_for,
    }));

    // 近 7 天已完成/已拒绝的目标：作为提示词原料显式排除，防规划重复自我
    const sevenDaysAgoIso = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
    const recentDone = repo
      .listGoals('assistant')
      .filter(
        (g) => (g.status === 'completed' || g.status === 'rejected') && g.created_at >= sevenDaysAgoIso,
      )
      .slice(0, 20)
      .map((g) => ({ description: g.description, status: g.status }));

    const concerns = readConcerns(db)
      .filter((c) => c.status === 'open')
      .map((c) => ({ description: c.description, origin: c.origin }));

    const mood = readMood(db, now.getTime());
    const budget = computePlannerBudget(db, deps.countAgentSelfCronJobs, now);

    const input: PlannerInput = {
      reflection,
      currentGoals,
      recentDone,
      concerns,
      mood: { energy: mood.energy, valence: mood.valence, arousal: mood.arousal },
      budget,
      now,
      quietHours: settings.quietHours,
    };

    // 2. LLM → 解析 → 预算裁剪
    const prompt = buildPlannerPrompt(input);
    const raw = await deps.callLLM(prompt);
    const plan = enforcePlanBudget(parsePlannerOutput(raw), budget);

    // 3. 落库 + 调度 cron
    const landed = landPlannerPlan(db, 'assistant', plan, {
      approvalMode: settings.approvalMode,
      now,
    });
    for (const job of landed.cronJobs) deps.scheduleCron(job);

    // 4. 记录本次规划时间（兜底判定依赖）
    writeLastPlanAt(db, now);

    log.info(
      `[runPlanner] 规划完成 goals=${landed.goalIds.length} cron=${landed.cronJobs.length} todos=${landed.todoCount}`,
    );
    return plan;
  } catch (err) {
    log.warn('[runPlanner] 规划失败:', err instanceof Error ? err.message : err);
    return null;
  }
}
