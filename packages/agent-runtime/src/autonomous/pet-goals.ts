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
        // `GLOB` 而不是 `LIKE 'pet:%'`：**只有 GLOB 能吃到 `idx_goals_agent_status_created`
        // 的前缀范围**。`LIKE` 的优化要求 `case_sensitive_like` 打开（默认是关的），
        // 关着的时候 SQLite 只能全表扫 `idx_goals_created`（2026-09-24 实测计划）。
        // 两者匹配语义在这里等价：都是"以 pet: 开头"，且 agentId 全是 ASCII。
        `SELECT id, agent_id, type, description, scheduled_for
           FROM autonomous_goals
          WHERE status = 'executing'
            AND agent_id GLOB '${PET_AGENT_ID_PREFIX}*'
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

/**
 * 今日该宠物名下**已经跑过**的目标数（数的是 `completed_at`，不是 `created_at`）。
 *
 * ---------------------------------------------------------------------------
 * ⚠ 2026-09-24 修正：原判据是 `created_at`，后果是「一次排队就把当天全判死」
 * ---------------------------------------------------------------------------
 * `created_at` 数的是"今天**建**了几条"，与"跑了几条"在**批量入队**时完全脱钩：
 * 用户（或第五期的规划器）一次写进 6 条，第 1 条还没跑，计数就已经是 6 → 派发侧
 * 逐条判 `6 > 5` 全部拒掉，当天 6 条目标 **一条 completed 都没有**，全是 `failed`
 * （真机日志里出现过 `refused: 今日目标已用满（6/5）`）。
 *
 * 改成数 `completed_at`（= 今天**收过尾**的），语义回到闸门本来要防的那件事——
 * 「今天被使唤了几次」。于是 6 条排队的结果是**前 5 条照跑、只有第 6 条被拒**，
 * 越额只影响越额的那一条。
 *
 * ⚠ 被拒的目标也走 `finalizeGoal`（会写 `completed_at`），所以它同样计入。
 * 这是可接受的：走到"被拒"这一步时计数必然已经贴着上限，多算一条只会让
 * 后面**同样超额**的那些也被拒——正是想要的。
 *
 * 与 `IntrinsicGoalGenerator.getTodayGoalCount` 的两处差别，都是刻意的：
 * 1. **不分状态**：那个数的是"还开着的目标"，因为助手的配额防的是"同时堆太多没做完的"；
 *    宠物的日上限防的是"今天被使唤了几次"——跑完的也算一次。
 * 2. **日界取本地零点**（`new Date(y, m, d)`）而不是 SQLite 的 `date('now')`（那是 UTC）：
 *    与 token / outreach 的日键同口径（`token-budget.ts` 的 `dayKey` 也是本地日），
 *    三个闸门若在午夜前后各按各的时区翻转，会出现「配额重置了但预算没重置」的错位。
 */
export function countPetRunsToday(db: DatabaseAdapter, agentId: string, now: Date = new Date()): number {
  try {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const row = db
      .prepare<{ count: number }>(
        `SELECT COUNT(*) as count FROM autonomous_goals
          WHERE agent_id = ? AND completed_at IS NOT NULL AND completed_at >= ?`,
      )
      .get(agentId, todayStart);
    return row?.count ?? 0;
  } catch {
    // 读不到按 0 算：这是**限制**，读不到就放开比读不到就锁死安全——
    // 锁死会让宠物在那一天彻底不动，而多跑一次只是多花一次预算，另一道闸门还兜着
    return 0;
  }
}
