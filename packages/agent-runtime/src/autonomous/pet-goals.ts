/**
 * 宠物目标的读取与到期判定（纯读库，零副作用）
 *
 * 对应宠物智能化实施计划 T3.3：宠物侧的派发循环**只复用这一层**——「读库判断」。
 * 行动（建实例 / 跑目标）由 windows 侧的 `pet-dispatch.ts` 用自己的 pipeline 做，
 * 不复用 `tick-signals.ts` 的决策语义（设计 §4.1.2 末段）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是 `agent_id` 前缀查询，而不是按 agentId 逐个查
 * ---------------------------------------------------------------------------
 * `collectTickSignals` 的入参是**已知的** agentId（来自 `listAutonomousAgentIds()`）。
 * 宠物这边反过来：调度器不知道现在有哪几只宠物，得先问「谁的宠物有活」。
 * 所以这里是本仓库唯一一处跨 agent 的目标查询。
 *
 * 前缀 `pet:` 是宠物的身份口径（`pet:<模型ID>`，见 pet-core 的 `pet-identity.ts`），
 * 与 `personality_state` / `autonomous.mood:*` 同一套。**不按 `planned_by='pet'` 过滤**：
 * `planned_by` 记的是"谁把它写进来的"（planner / trigger / pet），而归属看的是 agent_id——
 * 将来宠物自己的规划器落地时，写进来的目标 `planned_by` 会是别的值，但 agent_id 仍是 `pet:*`。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';

/** 宠物 agentId 的前缀（`pet:<模型ID>`） */
export const PET_AGENT_ID_PREFIX = 'pet:';

/** 是否宠物身份。与 `petAgentId()` 同口径，但这里不能 import pet-core（依赖方向反了） */
export function isPetAgentId(agentId: string): boolean {
  return agentId.startsWith(PET_AGENT_ID_PREFIX);
}

/** 一条待执行的宠物目标（最小信号，与 `ApprovedGoalSignal` 同形但带 agentId） */
export interface PetGoalSignal {
  /** 目标 id */
  readonly id: string;
  /** 归属宠物：`pet:<模型ID>`。派发时它同时是会话归属与定义 id */
  readonly agentId: string;
  /** 目标类型（沿用 `autonomous_goals.type` 的六个枚举值，三期不引入新类型） */
  readonly type: string;
  /** 目标描述 */
  readonly description: string;
  /** 排期时间（ISO）；null = 立即可做 */
  readonly scheduledFor: string | null;
}

/**
 * 目标是否已到可执行时间。
 *
 * 与 `tick-signals.ts` 的 `isGoalDue` **行为一致但刻意不复用**：那个是模块私有函数，
 * 而两个模块共用一条判断的收益（3 行）小于把宠物和自主进化的读判断耦合起来的代价。
 * 时间串解析不出来时按「未到期」处理——不认识的排期不该当场执行。
 */
export function isPetGoalDue(scheduledFor: string | null, now: Date): boolean {
  if (!scheduledFor) return true;
  const at = new Date(scheduledFor).getTime();
  return Number.isFinite(at) && at <= now.getTime();
}

/**
 * 列出所有**已到期**的宠物目标，按创建时间升序（先排的先做）。
 *
 * 只取 `status = 'executing'`：那是"已批准、等待执行"的状态（见 `tick-signals.ts` 的同款注释）——
 * `pending` 还等着用户批，`approved` 是 `AutonomousRepo` 直接改状态那条路留下的中间态，
 * 真正该被派发的是 `executing`。
 *
 * 读库失败返回空数组而不是抛错：派发循环是后台动作，一次查询失败不该炸掉整轮心跳
 * （调用方无论如何都会拿到一个可读的结果串）。
 */
export function listDuePetGoals(db: DatabaseAdapter, now: Date = new Date()): PetGoalSignal[] {
  try {
    const rows = db
      .prepare<{ id: string; agent_id: string; type: string; description: string; scheduled_for: string | null }>(
        `SELECT id, agent_id, type, description, scheduled_for
           FROM autonomous_goals
          WHERE status = 'executing'
            AND agent_id LIKE '${PET_AGENT_ID_PREFIX}%'
          ORDER BY created_at ASC`,
      )
      .all();
    return rows
      .filter((r) => isPetGoalDue(r.scheduled_for, now))
      .map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        type: r.type,
        description: r.description,
        scheduledFor: r.scheduled_for,
      }));
  } catch {
    return [];
  }
}
