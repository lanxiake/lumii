/**
 * 自主进化只读/审批仓储
 *
 * 面向 CLI 与前端仪表板的查询入口，直接读 V28-V31 迁移建立的正式表：
 * autonomous_satisfaction_scores / autonomous_goals / capability_dimensions /
 * reflections / prompt_variants。
 */

import type { DatabaseAdapter } from "./local-database.js";

export interface SatisfactionRow {
  overall_score: number;
  task_completion: number;
  user_feedback: number;
  efficiency: number;
  knowledge_growth: number;
  created_at: string;
}

export interface GoalRow {
  id: string;
  agent_id: string;
  type: string;
  description: string;
  trigger_reason: string;
  status: string;
  priority: number;
  created_at: string;
  approved_at: string | null;
}

export interface CapabilityRow {
  dimension: string;
  level: number;
  confidence: number;
  boundary: number;
  test_count: number;
  last_updated: string;
}

export interface ReflectionRow {
  id: string;
  primary_issue: string;
  affected_dimensions: string;
  root_cause: string;
  recommendations: string;
  suggested_goals: string;
  created_at: string;
}

export interface PromptVariantRow {
  id: string;
  baseline_prompt_id: string;
  variant_text: string;
  is_baseline: number;
  trial_count: number;
  success_count: number;
  avg_satisfaction: number | null;
  ucb_score: number | null;
}

const GOAL_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
  "executing",
  "completed",
  "failed",
]);

export class AutonomousRepo {
  constructor(private readonly db: DatabaseAdapter) {}

  /** 最新一条满意度评分 */
  latestSatisfaction(agentId: string): SatisfactionRow | undefined {
    return this.db
      .prepare<SatisfactionRow>(
        `SELECT overall_score, task_completion, user_feedback, efficiency,
                knowledge_growth, created_at
           FROM autonomous_satisfaction_scores
          WHERE agent_id = ?
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(agentId);
  }

  /** 满意度历史（起始时间之后，升序） */
  satisfactionHistory(agentId: string, since: string): SatisfactionRow[] {
    return this.db
      .prepare<SatisfactionRow>(
        `SELECT overall_score, task_completion, user_feedback, efficiency,
                knowledge_growth, created_at
           FROM autonomous_satisfaction_scores
          WHERE agent_id = ? AND created_at >= ?
          ORDER BY created_at ASC`,
      )
      .all(agentId, since);
  }

  /**
   * 目标列表。status 由白名单校验后才拼入 SQL，非法值按“不过滤”处理，
   * 避免把 CLI 传入的任意字符串带进查询条件。
   */
  listGoals(agentId: string, status?: string): GoalRow[] {
    const validStatus = status && GOAL_STATUSES.has(status) ? status : undefined;
    if (validStatus) {
      return this.db
        .prepare<GoalRow>(
          `SELECT id, agent_id, type, description, trigger_reason, status,
                  priority, created_at, approved_at
             FROM autonomous_goals
            WHERE agent_id = ? AND status = ?
            ORDER BY created_at DESC`,
        )
        .all(agentId, validStatus);
    }
    return this.db
      .prepare<GoalRow>(
        `SELECT id, agent_id, type, description, trigger_reason, status,
                priority, created_at, approved_at
           FROM autonomous_goals
          WHERE agent_id = ?
          ORDER BY created_at DESC`,
      )
      .all(agentId);
  }

  countGoalsByStatus(agentId: string, status: string): number {
    const row = this.db
      .prepare<{ count: number }>(
        `SELECT COUNT(*) as count FROM autonomous_goals
          WHERE agent_id = ? AND status = ?`,
      )
      .get(agentId, status);
    return row?.count ?? 0;
  }

  /** 批准目标；返回是否命中记录（仅 pending 可流转） */
  approveGoal(goalId: string, note?: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE autonomous_goals
            SET status = 'approved', approved_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(now, goalId);
    if (result.changes === 0) return false;
    // 审批备注落在 autonomous_approvals（goal 表无备注列）
    if (note) {
      this.db
        .prepare(
          `UPDATE autonomous_approvals
              SET decision_note = ?, decided_by = 'user', decided_at = ?, status = 'approved'
            WHERE goal_id = ?`,
        )
        .run(note, Date.now(), goalId);
    }
    return true;
  }

  /** 拒绝目标；返回是否命中记录（仅 pending 可流转） */
  rejectGoal(goalId: string, reason?: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE autonomous_goals
            SET status = 'rejected'
          WHERE id = ? AND status = 'pending'`,
      )
      .run(goalId);
    if (result.changes === 0) return false;
    if (reason) {
      this.db
        .prepare(
          `UPDATE autonomous_approvals
              SET decision_note = ?, decided_by = 'user', decided_at = ?, status = 'rejected'
            WHERE goal_id = ?`,
        )
        .run(reason, Date.now(), goalId);
    }
    return true;
  }

  capabilities(agentId: string): CapabilityRow[] {
    return this.db
      .prepare<CapabilityRow>(
        `SELECT dimension, level, confidence, boundary, test_count, last_updated
           FROM capability_dimensions
          WHERE agent_id = ?
          ORDER BY dimension ASC`,
      )
      .all(agentId);
  }

  reflections(agentId: string, limit: number): ReflectionRow[] {
    return this.db
      .prepare<ReflectionRow>(
        `SELECT id, primary_issue, affected_dimensions, root_cause,
                recommendations, suggested_goals, created_at
           FROM reflections
          WHERE agent_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(agentId, limit);
  }

  promptVariants(baselinePromptId?: string): PromptVariantRow[] {
    if (baselinePromptId) {
      return this.db
        .prepare<PromptVariantRow>(
          `SELECT id, baseline_prompt_id, variant_text, is_baseline,
                  trial_count, success_count, avg_satisfaction, ucb_score
             FROM prompt_variants
            WHERE baseline_prompt_id = ?
            ORDER BY is_baseline DESC, ucb_score DESC`,
        )
        .all(baselinePromptId);
    }
    return this.db
      .prepare<PromptVariantRow>(
        `SELECT id, baseline_prompt_id, variant_text, is_baseline,
                trial_count, success_count, avg_satisfaction, ucb_score
           FROM prompt_variants
          ORDER BY baseline_prompt_id ASC, is_baseline DESC, ucb_score DESC`,
      )
      .all();
  }
}
