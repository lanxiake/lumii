/**
 * 目标执行器（纯逻辑 + 结果落库）
 *
 * 对应设计文档 10 §6：已批准目标 → prompt 骨架 → 工具白名单 → 执行 → 落库。
 * buildGoalPrompt / getGoalToolAllowlist 是纯函数，可零 mock 单测；
 * finalizeGoal 负责把目标流转到 completed / failed。
 */

import { GoalType } from './types';
import type { DatabaseAdapter } from '../storage/local-database.js';

/** 目标执行结果 */
export interface GoalExecutionResult {
  success: boolean;
  /** 执行产出的文本（Agent 最后一条回复 / 通知正文） */
  output: string;
}

/**
 * 目标执行工具白名单 —— prompt 之外的硬防线。
 * 只放只读检索 + 记忆读写 + 通知；绝不放 bash / 文件写入 / 渠道群发。
 */
const GOAL_EXECUTION_TOOLS: readonly string[] = [
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_read',
  'memory_add',
  'notify_user',
];

/** 护栏 prompt（拼进 systemPromptAppend / 正文头部） */
const EXECUTION_GUARDRAILS =
  '这是自主进化目标的执行。你只能使用工具白名单内的工具，不得执行白名单之外的任何操作；' +
  '禁止删除或修改用户文件、禁止执行系统命令、禁止泄露用户隐私信息。' +
  '如果目标需要超出白名单的能力，或当前上下文无法完成，请如实说明并停止，不要编造结果。';

/**
 * 目标 → 执行 prompt 骨架。
 * 每种类型都带「无法完成就停止」的安全出口。
 */
export function buildGoalPrompt(goal: { type: string; description: string }): string {
  const base = `${EXECUTION_GUARDRAILS}\n\n目标描述：${goal.description}`;
  switch (goal.type) {
    case GoalType.LEARNING:
      return `${base}\n\n这是一个学习型目标：请通过检索与阅读掌握该主题，并总结要点。无法完成时如实说明。`;
    case GoalType.PROACTIVE_MESSAGE:
      return `${base}\n\n这是一个主动消息目标：请生成一条要主动发给用户的简短消息。若当前无需打扰用户，请说明原因。`;
    case GoalType.CAPABILITY_IMPROVEMENT:
      return `${base}\n\n这是一个能力改进目标：请围绕该能力做针对性练习或产出改进方案。无法完成时如实说明。`;
    default:
      return `${base}\n\n请执行该目标。无法完成时如实说明并停止。`;
  }
}

/**
 * 目标类型 → 工具白名单。
 * 当前所有类型共用同一份只读白名单（安全底线）；未来可按类型细分。
 */
export function getGoalToolAllowlist(_goalType: string): string[] {
  return [...GOAL_EXECUTION_TOOLS];
}

/**
 * 目标执行结果落库：success → completed，否则 → failed。
 * 空 output 视为失败（防止「假 completed」），见执行层调用约束。
 */
export function finalizeGoal(
  db: DatabaseAdapter,
  goalId: string,
  result: GoalExecutionResult,
): void {
  const status = result.success && result.output.trim().length > 0 ? 'completed' : 'failed';
  db.prepare(
    `UPDATE autonomous_goals SET status = ?, completed_at = ? WHERE id = ?`,
  ).run(status, new Date().toISOString(), goalId);
}
