/**
 * agent-activity-modulation —— Agent 活动 → 姿态调制量（纯函数）
 *
 * 表达分四层（设计文档 §三），本模块是 **L1「姿态叠加」**：不改渲染器的动作组、
 * 不动任何素材，只在 `evaluateProcedural()` 已经算出的呼吸/浮动/倾斜之上乘一层
 * 由 `agentActivity` 驱动的倍率。
 *
 * 为什么 L1 是主力：它**零素材成本**，对团子/钢羽这种没有分层脸的模型同样生效
 * （那些模型连表情层都没有，L2/L3 全用不了）；而且它是连续的、可归因的，
 * 天然符合「不表演」——用户未必说得出原因，但能感觉到它在忙。
 *
 * ## 平滑为什么用插值而不是 EMA
 *
 * 设计文档 §3.1 写的是 EMA，这里改成**从 `previousActivity` 到当前 activity 的
 * 时间插值**（smoothstep）。理由：EMA 的输出取决于「喂了多少帧、每帧间隔多少」，
 * 同一个 `(state, now)` 在不同帧率下算出不同的值——那就不是纯函数，也没法写
 * 「给定 now 断言输出」的测试。插值版完全由 `(activity, previousActivity,
 * activityChangedAt, now)` 决定，可重放、可断言，且起止导数为 0（不出现「一顿」）。
 *
 * 代价：切换必须**一次到位**，不能中途被新事件打断成三段混合。实际上不会——
 * `withActivity` 每次切换都把旧的 `activity` 记进 `previousActivity`，重新起算。
 */

import type { AgentActivity } from "../state/agent-activity.js";
import { sanitizeTimestamp } from "../state/agent-activity.js";

/** 叠加在 `transform` 上的三个分量（渲染器负责把它们乘/加到对应轴上） */
export interface ActivityModulation {
  /** 乘在呼吸振幅上 */
  readonly breatheScale: number;
  /** 乘在浮动（bob）振幅上 */
  readonly bobScale: number;
  /** 加在倾角上（度） */
  readonly tiltDeg: number;
}

/** 基线。**必须是恒等元**——`idle` 时姿态要与本设计上线前逐像素一致（零回归判据）。 */
export const IDENTITY_MODULATION: ActivityModulation = Object.freeze({
  breatheScale: 1,
  bobScale: 1,
  tiltDeg: 0,
});

/**
 * 每个 activity 的目标调制量。
 *
 * 整表可替换（{@link activityModulation} 的第三个参数）——数值全部**待实测校准**，
 * 这里只确立方向与相对关系：屏息凝神（thinking）气吸得深但动得少；忙起来
 * （working）呼吸重、幅度大；探身（waiting）最明显；蔫一下（blocked）整体缩小。
 */
export const ACTIVITY_MODULATION_TABLE: Readonly<Record<AgentActivity, ActivityModulation>> =
  Object.freeze({
    idle: IDENTITY_MODULATION,
    thinking: Object.freeze({ breatheScale: 1.15, bobScale: 0.85, tiltDeg: 2 }),
    working: Object.freeze({ breatheScale: 1.3, bobScale: 1.2, tiltDeg: 0 }),
    waiting: Object.freeze({ breatheScale: 1.35, bobScale: 1.45, tiltDeg: 4 }),
    blocked: Object.freeze({ breatheScale: 0.85, bobScale: 0.7, tiltDeg: -2 }),
  });

/** 调制量平滑时间常数。足够快以对上事件，足够慢以避免抽搐。 */
export const MODULATION_SMOOTH_MS = 600;

/** 只读调制所需的那部分状态——避免 `render/` 依赖整个状态机的形状。 */
export interface ModulationSource {
  readonly activity: AgentActivity;
  readonly previousActivity: AgentActivity;
  readonly activityChangedAt: number;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** smoothstep：起止导数为 0，所以切换的**第一帧与最后一帧都没有速度突变**。 */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 算出 `now` 时刻该叠加的调制量。
 *
 * 纯函数：输出完全由入参决定，同一组入参永远得到同一个值。状态没变时（上一档
 * 与当前档相同）直接返回表里的常量对象（引用相等），宿主可据此跳过重绘。
 */
export function activityModulation(
  state: ModulationSource,
  now: number,
  table: Readonly<Record<AgentActivity, ActivityModulation>> = ACTIVITY_MODULATION_TABLE,
): ActivityModulation {
  const from = table[state.previousActivity] ?? IDENTITY_MODULATION;
  const to = table[state.activity] ?? IDENTITY_MODULATION;
  // 同档（含初始的 idle→idle）：不插值，直接给常量。这是「基线冻结」判据的落点。
  if (from === to || state.previousActivity === state.activity) return to;

  const at = sanitizeTimestamp(now, state.activityChangedAt);
  const elapsed = at - sanitizeTimestamp(state.activityChangedAt, 0);
  if (elapsed <= 0) return from; // 切换的当帧：还在起点
  if (elapsed >= MODULATION_SMOOTH_MS) return to;

  const t = smoothstep(elapsed / MODULATION_SMOOTH_MS);
  return {
    breatheScale: lerp(from.breatheScale, to.breatheScale, t),
    bobScale: lerp(from.bobScale, to.bobScale, t),
    tiltDeg: lerp(from.tiltDeg, to.tiltDeg, t),
  };
}

/** 便捷判定：是不是恒等（宿主用来走「零回归」快路径，连乘法都省掉）。 */
export function isIdentityModulation(m: ActivityModulation): boolean {
  return m === IDENTITY_MODULATION;
}

/** 程序化原语的输出里、调制会碰的那三个分量（多出来的字段原样忽略） */
export interface ModulationTarget {
  readonly offsetY: number;
  readonly rotation: number;
  readonly scale: number;
}

/**
 * 把调制叠到程序化原语的输出上。**这是 L1 唯一的算术落点**，抽出来是因为它有一条
 * 极易写错、错完还看不出来的约定：
 *
 * > 呼吸的倍率乘在**偏离量**上，不是总量。
 *
 * `evaluateProcedural` 给的 `scale` 是 `1 + (max-1)·wave`——一个**以 1 为中心**的振幅。
 * 写成 `scale × 1.3` 会把「呼吸加重 30%」变成「宠物整体放大 30%」：宠物肉眼可见地胀
 * 一圈，而没有报错、没有 NaN、看起来只是"有点怪"。第一版就是这么写的，是靠
 * `breatheScale()` 的源码注释才发现的。`offsetY` 与 `rotation` 本来就是偏离 0 的量，
 * 直接乘/加即可。
 *
 * 恒等元下**原样返回入参**（引用相等），不只是"数值差不多"：`1 + (x-1)×1` 在 IEEE754
 * 下并不精确等于 `x`（`x=1.1` 时差 1e-16），而这套东西的硬约束是 idle 时与本设计
 * 上线前**逐像素一致**——那就不能有任何一位浮点漂移。
 */
export function applyActivityModulation(
  transform: ModulationTarget,
  mod: ActivityModulation,
): ModulationTarget {
  if (isIdentityModulation(mod)) return transform;
  return {
    offsetY: transform.offsetY * mod.bobScale,
    rotation: transform.rotation + mod.tiltDeg,
    scale: 1 + (transform.scale - 1) * mod.breatheScale,
  };
}
