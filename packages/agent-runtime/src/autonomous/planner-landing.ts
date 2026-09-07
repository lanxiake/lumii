/**
 * 主动规划落地（纯 db 写入，无 LLM）
 *
 * 把 PlannerPlan 落成三样东西：
 * - goals       → autonomous_goals（planned_by='planner' + scheduled_for，走既有审批模式）
 * - cronJobs    → local_cron_jobs（id='agent-self:<uuid>'、agent_id='assistant'、notify_targets='silent' 静默）
 * - todos       → agent_memories（工作记忆，category='reference'）
 *
 * 只负责写库与调度表达式解析，返回新建的 cron 行供 windows 侧调用 cronScheduler.scheduleJob 启动计时器。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';
import type { PlannerPlan, PlannerCronJob } from './planner';

/** 落地后需要交给调度器启动计时器的 cron 行 */
export interface LandedCronJob {
  id: string;
  name: string;
  task_text: string;
  agent_id: string;
  schedule_type: 'at' | 'every';
  schedule_expr: string;
  next_run_at: number;
  interval_ms: number | null;
  notify_targets: string;
}

export interface PlannerLandingResult {
  goalIds: string[];
  cronJobs: LandedCronJob[];
  todoCount: number;
}

export interface PlannerLandingOptions {
  approvalMode: 'always' | 'risky-only' | 'never';
  now?: Date;
}

/** 自建任务的 id 前缀（cron_delete 守卫只允许删这个命名空间） */
export const SELF_CRON_ID_PREFIX = 'agent-self:';

const GOAL_TYPE_PROACTIVE = 'proactive-message';

function shouldRequireApproval(type: string, mode: PlannerLandingOptions['approvalMode']): boolean {
  if (mode === 'never') return false;
  if (mode === 'risky-only') return type === GOAL_TYPE_PROACTIVE;
  return true;
}

function generateId(prefix: string): string {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 目标计划时间约束到未来 24h 窗口内；非法/越界一律回落 null（尽快） */
function clampScheduledFor(scheduledFor: string | null, nowMs: number): string | null {
  if (!scheduledFor) return null;
  const parsed = Date.parse(scheduledFor);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < nowMs || parsed > nowMs + MAX_EVERY_INTERVAL_MS) return null;
  return scheduledFor;
}

/** 定时任务的最大周期：24 小时（毫秒）。规划器只排未来 24h，跨天/跨周周期一律拒绝。 */
const MAX_EVERY_INTERVAL_MS = 24 * 3_600_000;

/** 解析调度表达式为绝对时间 + 间隔。非法表达式返回 null（该 cron 跳过）。 */
export function resolveCronSchedule(
  scheduleType: 'at' | 'every',
  scheduleExpr: string,
  now: number,
): { nextRunAt: number; intervalMs: number | null } | null {
  const expr = scheduleExpr.trim();
  if (scheduleType === 'every') {
    if (!/^\d+$/.test(expr)) return null;
    const ms = Number(expr);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    // 只允许 < 24h 的周期；跨天/跨周（每 1 天、每 7 天…）是长期习惯，不属于未来 24h 排期
    if (ms >= MAX_EVERY_INTERVAL_MS) return null;
    return { nextRunAt: now + ms, intervalMs: ms };
  }
  // 'at'：纯数字字符串按「秒 < 1e12 转毫秒，否则毫秒」处理（对齐 bridge 侧 parseAtScheduleExpr 口径）
  if (/^\d+$/.test(expr)) {
    const direct = Number(expr);
    const atMs = direct > 0 && direct < 1_000_000_000_000 ? direct * 1000 : direct;
    return atMs >= now && atMs <= now + MAX_EVERY_INTERVAL_MS ? { nextRunAt: atMs, intervalMs: null } : null;
  }
  const parsed = Date.parse(expr);
  if (!Number.isFinite(parsed)) return null;
  // 一次性任务必须落在未来 24h 窗口内（不排过去、不跨天）
  if (parsed < now || parsed > now + MAX_EVERY_INTERVAL_MS) return null;
  return { nextRunAt: parsed, intervalMs: null };
}

/** 写入单个 planner 目标，返回目标 id */
function insertGoal(
  db: DatabaseAdapter,
  agentId: string,
  goal: { description: string; type: string; scheduled_for: string | null; priority: number },
  status: 'pending' | 'executing',
  now: string,
): string {
  const id = generateId('goal-');
  db.prepare(
    `INSERT INTO autonomous_goals
     (id, agent_id, type, description, trigger_reason, status, priority, metadata,
      scheduled_for, planned_by, created_at)
     VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, 'planner', ?)`,
  ).run(
    id,
    agentId,
    goal.type,
    goal.description,
    status,
    goal.priority,
    JSON.stringify({ plannedBy: 'planner' }),
    goal.scheduled_for,
    now,
  );
  return id;
}

/**
 * 落地一个规划：目标 → autonomous_goals、定时任务 → local_cron_jobs、待办 → agent_memories。
 * 任何单条失败都记日志跳过，不因一条坏数据拖垮整次落地。
 */
export function landPlannerPlan(
  db: DatabaseAdapter,
  agentId: string,
  plan: PlannerPlan,
  opts: PlannerLandingOptions,
): PlannerLandingResult {
  const nowMs = opts.now?.getTime() ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // 1. 目标
  const goalIds: string[] = [];
  for (const g of plan.goals) {
    const status = shouldRequireApproval(g.type, opts.approvalMode) ? 'pending' : 'executing';
    // scheduled_for 必须落在未来 24h 窗口内，否则按「尽快」处理（跨天/跨周计划不属于未来 24h 排期）
    const scheduledFor = clampScheduledFor(g.scheduled_for, nowMs);
    try {
      goalIds.push(insertGoal(db, agentId, { ...g, scheduled_for: scheduledFor }, status, nowIso));
    } catch (err) {
      console.warn('[landPlannerPlan] 写入目标失败，跳过:', err instanceof Error ? err.message : err);
    }
  }

  // 2. 定时任务（静默：notify_targets='silent'，自建任务不打扰用户）
  const cronJobs: LandedCronJob[] = [];
  for (const cj of plan.cronJobs) {
    const resolved = resolveCronSchedule(cj.scheduleType, cj.scheduleExpr, nowMs);
    if (!resolved) continue;
    const id = generateId(SELF_CRON_ID_PREFIX);
    const row: LandedCronJob = {
      id,
      name: cj.task.slice(0, 40),
      task_text: cj.task,
      agent_id: 'assistant',
      schedule_type: cj.scheduleType,
      schedule_expr: cj.scheduleExpr,
      next_run_at: resolved.nextRunAt,
      interval_ms: resolved.intervalMs,
      notify_targets: 'silent',
    };
    try {
      db.prepare(
        `INSERT INTO local_cron_jobs
         (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        row.id,
        row.name,
        row.task_text,
        row.agent_id,
        row.schedule_type,
        row.schedule_expr,
        row.next_run_at,
        row.interval_ms,
        nowMs,
        row.notify_targets,
      );
      cronJobs.push(row);
    } catch (err) {
      console.warn('[landPlannerPlan] 写入定时任务失败，跳过:', err instanceof Error ? err.message : err);
    }
  }

  // 3. 待办 → 工作记忆（category='reference'）
  let todoCount = 0;
  const insertTodo = db.prepare(
    `INSERT INTO agent_memories
     (id, agent_id, user_id, category, content, importance, created_at, last_used)
     VALUES (?, ?, 'local', 'reference', ?, 0.5, ?, ?)`,
  );
  for (const todo of plan.todos) {
    try {
      insertTodo.run(generateId('mem-'), agentId, todo, nowIso, nowIso);
      todoCount++;
    } catch (err) {
      console.warn('[landPlannerPlan] 写入待办失败，跳过:', err instanceof Error ? err.message : err);
    }
  }

  return { goalIds, cronJobs, todoCount };
}
