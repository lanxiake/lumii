import { describe, expect, it } from 'vitest';
import { landPlannerPlan, resolveCronSchedule, SELF_CRON_ID_PREFIX } from '../planner-landing';
import type { PlannerPlan } from '../planner';
import { createMigratedTestDb } from '../../__tests__/helpers/sqlite-test-db.js';

function makePlan(): PlannerPlan {
  return {
    goals: [
      { description: '学习简洁表达', type: 'learning', scheduled_for: '2026-09-07T09:00:00+08:00', priority: 0.6 },
      { description: '主动问候用户', type: 'proactive-message', scheduled_for: null, priority: 0.4 },
    ],
    cronJobs: [
      { task: '每天整理资讯', scheduleType: 'every', scheduleExpr: '21600000' },
      { task: '一次性回顾', scheduleType: 'at', scheduleExpr: '2026-09-07T09:00:00+08:00' },
    ],
    todos: ['读一篇文', '整理笔记'],
  };
}

describe('resolveCronSchedule', () => {
  const now = Date.parse('2026-09-06T09:00:00Z');

  it('every 解析整数毫秒', () => {
    expect(resolveCronSchedule('every', '60000', now)).toEqual({ nextRunAt: now + 60000, intervalMs: 60000 });
  });

  it('every 非法表达式返回 null', () => {
    expect(resolveCronSchedule('every', 'abc', now)).toBeNull();
    expect(resolveCronSchedule('every', '0', now)).toBeNull();
  });

  it('at 解析 ISO 时间', () => {
    const at = Date.parse('2026-09-07T09:00:00+08:00');
    expect(resolveCronSchedule('at', '2026-09-07T09:00:00+08:00', now)).toEqual({ nextRunAt: at, intervalMs: null });
  });

  it('at 纯数字按秒转毫秒', () => {
    // now = 2026-09-06T09:00:00Z；加 1h 的秒值落在未来 24h 窗口内，验证秒→毫秒转换
    const atSec = Math.floor(now / 1000) + 3600;
    expect(resolveCronSchedule('at', String(atSec), now)).toEqual({ nextRunAt: atSec * 1000, intervalMs: null });
  });

  it('at 过去的纯数字秒值被窗口校验拒绝', () => {
    const pastSec = Math.floor(now / 1000) - 3600;
    expect(resolveCronSchedule('at', String(pastSec), now)).toBeNull();
  });
});

describe('landPlannerPlan', () => {
  // 固定 now，落在 makePlan 里 2026-09-07T09:00+08:00 之前，使 scheduled_for 处于未来 24h 窗口内
  const now = new Date('2026-09-06T09:00:00Z');

  it('目标落地 planned_by=planner + scheduled_for，走审批模式', () => {
    const db = createMigratedTestDb();
    const result = landPlannerPlan(db, 'assistant', makePlan(), { approvalMode: 'always', now });
    expect(result.goalIds).toHaveLength(2);

    const goals = db
      .prepare<{ description: string; planned_by: string | null; scheduled_for: string | null; status: string }>(
        `SELECT description, planned_by, scheduled_for, status FROM autonomous_goals`,
      )
      .all();
    expect(goals).toHaveLength(2);
    expect(goals.every((g) => g.planned_by === 'planner')).toBe(true);
    // 学习目标带计划时间，主动消息无计划时间（立即）
    expect(goals.some((g) => g.scheduled_for?.includes('2026-09-07'))).toBe(true);
    // approvalMode=always → 全部 pending
    expect(goals.every((g) => g.status === 'pending')).toBe(true);
    db.close();
  });

  it('approvalMode=never 目标直接 executing', () => {
    const db = createMigratedTestDb();
    landPlannerPlan(db, 'assistant', makePlan(), { approvalMode: 'never', now });
    const statuses = db
      .prepare<{ status: string }>(`SELECT status FROM autonomous_goals`)
      .all()
      .map((r) => r.status);
    expect(statuses.every((s) => s === 'executing')).toBe(true);
    db.close();
  });

  it('定时任务落地 agent-self: 前缀 + assistant + silent', () => {
    const db = createMigratedTestDb();
    const result = landPlannerPlan(db, 'assistant', makePlan(), { approvalMode: 'always', now });
    expect(result.cronJobs).toHaveLength(2);

    const jobs = db
      .prepare<{ id: string; agent_id: string | null; notify_targets: string | null; schedule_type: string }>(
        `SELECT id, agent_id, notify_targets, schedule_type FROM local_cron_jobs ORDER BY created_at`,
      )
      .all();
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j.id.startsWith(SELF_CRON_ID_PREFIX)).toBe(true);
      expect(j.agent_id).toBe('assistant');
      expect(j.notify_targets).toBe('silent');
    }
    db.close();
  });

  it('待办落地 agent_memories（category=reference）', () => {
    const db = createMigratedTestDb();
    const result = landPlannerPlan(db, 'assistant', makePlan(), { approvalMode: 'always', now });
    expect(result.todoCount).toBe(2);

    const rows = db
      .prepare<{ content: string; category: string }>(`SELECT content, category FROM agent_memories WHERE agent_id = 'assistant'`)
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.category === 'reference')).toBe(true);
    db.close();
  });

  it('非法 cron 表达式被跳过，不影响目标落地', () => {
    const db = createMigratedTestDb();
    const plan: PlannerPlan = {
      goals: [{ description: 'x', type: 'learning', scheduled_for: null, priority: 0.5 }],
      cronJobs: [{ task: 'bad', scheduleType: 'every', scheduleExpr: 'not-a-number' }],
      todos: [],
    };
    const result = landPlannerPlan(db, 'assistant', plan, { approvalMode: 'always' });
    expect(result.goalIds).toHaveLength(1);
    expect(result.cronJobs).toHaveLength(0);
    db.close();
  });

  it('与近 7 天目标重复（归一化比对）时跳过，不重复落库', () => {
    const db = createMigratedTestDb();
    db.prepare(
      `INSERT INTO autonomous_goals (id, agent_id, type, description, trigger_reason, status, priority, created_at)
       VALUES (?, 'assistant', 'learning', ?, 'test', 'pending', 0.5, ?)`,
    ).run('old-goal-1', '学习简洁表达。', new Date(now.getTime() - 24 * 3600_000).toISOString());

    const plan: PlannerPlan = {
      goals: [
        // 与旧目标仅差尾部标点 → 归一化后相同，应被跳过
        { description: '学习简洁表达', type: 'learning', scheduled_for: null, priority: 0.6 },
        { description: '一个全新的方向', type: 'learning', scheduled_for: null, priority: 0.5 },
      ],
      cronJobs: [],
      todos: [],
    };
    const result = landPlannerPlan(db, 'assistant', plan, { approvalMode: 'always', now });
    expect(result.goalIds).toHaveLength(1);
    const rows = db
      .prepare<{ description: string }>(`SELECT description FROM autonomous_goals ORDER BY created_at`)
      .all();
    expect(rows.map((r) => r.description)).toEqual(['学习简洁表达。', '一个全新的方向']);
    db.close();
  });

  it('超过 7 天的同描述目标不参与去重（窗口外可再排）', () => {
    const db = createMigratedTestDb();
    db.prepare(
      `INSERT INTO autonomous_goals (id, agent_id, type, description, trigger_reason, status, priority, created_at)
       VALUES (?, 'assistant', 'learning', ?, 'test', 'completed', 0.5, ?)`,
    ).run('old-goal-2', '很久以前的方向', new Date(now.getTime() - 10 * 24 * 3600_000).toISOString());

    const plan: PlannerPlan = {
      goals: [{ description: '很久以前的方向', type: 'learning', scheduled_for: null, priority: 0.5 }],
      cronJobs: [],
      todos: [],
    };
    const result = landPlannerPlan(db, 'assistant', plan, { approvalMode: 'always', now });
    expect(result.goalIds).toHaveLength(1);
    db.close();
  });
});
