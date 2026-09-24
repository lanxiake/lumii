/**
 * refusal —— 互动请求的「拒绝」判定（pet-core，零依赖）
 *
 * 设计依据：宠物智能化设计 §4.4「会拒绝（严格边界）」。管家的定律冲突、瓦力不肯松手
 * 之所以动人，是因为那是个**有内心的人**在权衡；而一个该干活时不干活的助手是 bug。
 *
 * ## 硬规则：只允许在「互动请求」上拒绝，绝不允许在「任务请求」上拒绝
 *
 * 这条不是"注意一下"的约定，而是本模块的**结构性约束**：`refusalProbability` 的第一行
 * 就是 `kind === "task" → 0`，没有任何条件能绕过它。把它做成参数而不是让调用方
 * 自己判断，是因为"该不该拒绝"在两条路上的答案**相反**，而调用点离得可能很远——
 * 参数化之后，忘记区分会退化成"传错了 kind"，而不是"静默拒了一次活"。
 *
 * 触发条件（设计原文）：`agreeableness < 0.35 && mood.valence < -0.2` → 拒绝概率 ≈ 0.3。
 *
 * 约束（务必保持）：本包为纯 TS，禁止 import 任何运行时依赖。
 */

/** 请求类型。两条路的答案相反，必须显式区分 */
export type PetRequestKind = "interaction" | "task";

/** 亲和性阈值：低于它才可能拒绝 */
export const REFUSAL_AGREEABLENESS_MAX = 0.35;
/** 心情阈值：低于它才可能拒绝 */
export const REFUSAL_VALENCE_MAX = -0.2;
/** 两个条件都满足时的拒绝概率 */
export const REFUSAL_PROBABILITY = 0.3;

function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 这次请求的拒绝概率。
 *
 * @param agreeableness 亲和性 0..1
 * @param valence 心情 -1..1（**宠物自己的**，不是助手的——两者是独立 Agent）
 * @param kind 请求类型
 */
export function refusalProbability(
  agreeableness: number,
  valence: number,
  kind: PetRequestKind,
): number {
  // ★ 硬规则。放在最前面是刻意的：它必须在**任何**其他条件之前短路，
  //   这样后面无论怎么改阈值，都不可能让任务请求落进拒绝分支。
  if (kind === "task") return 0;

  const a = finite(agreeableness, 1);
  const v = finite(valence, 0);
  if (a >= REFUSAL_AGREEABLENESS_MAX) return 0;
  if (v >= REFUSAL_VALENCE_MAX) return 0;
  return REFUSAL_PROBABILITY;
}

/**
 * 是否拒绝这次请求。`rand` 可注入，使判定在测试里可重放。
 *
 * 概率为 0 时**不消费随机数**——否则同一个 `rand` 序列在"任务请求"与
 * "心情好的互动请求"上会走出不同的后续值，测试与真实行为对不上。
 */
export function shouldRefuse(
  agreeableness: number,
  valence: number,
  kind: PetRequestKind,
  rand: () => number = Math.random,
): boolean {
  const p = refusalProbability(agreeableness, valence, kind);
  if (p <= 0) return false;
  const r = rand();
  return Number.isFinite(r) && r < p;
}
