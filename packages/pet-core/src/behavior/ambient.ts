/**
 * ambient — 空闲时的自主活动决策（pet-core，零依赖）
 *
 * 借鉴 `AI-desktop-pets` 的 `PetPhysicsEngine`：那边用一张权重表
 * （`[STAND 0.3, WALK 0.4, SIT 0.2, GREET 0.1]`）+ 每 5 秒掷 30% 决定宠物下一步做什么。
 *
 * **只借手法，不借节奏**，这是本项目需求文档 §3.3 明确划的线：那边 5 秒一次、
 * 三成概率，表现为「无缘由地突然坐下、打招呼」，事后不可理解——正是"表演"的定义。
 * 这里的取舍有三条：
 *
 * 1. **间隔拉长到数十秒**。宠物绝大多数时间是安静的，偶尔走一段。桌宠是陪衬，
 *    不是主体；高频动作会持续抢占用户余光。
 * 2. **去掉 GREET**。打招呼是社交行为，无缘由触发是"表演"最典型的形态。
 *    它应当留给真实事件（用户回来、Agent 需要决策），不该进随机池。
 * 3. **权重与时长集中在一张表里**，调用方可以整表替换。这是为后续接真实状态驱动
 *    （Agent 在干活 / 需要决策）留的缝：换的是数据，不是这段决策逻辑。
 *
 * 约束（务必保持）：本包为纯 TS，禁止 import 任何运行时依赖。
 */

/** 空闲活动。三者都是"可以长时间维持"的姿态，区别于一次性动作（招手/跳跃） */
export type AmbientActivity = "stand" | "sit" | "walk"

/**
 * 宠物当前的运动姿态。
 *
 * 比 `AmbientActivity` 宽：攀爬（climb/crawl）**不进随机池**——它们由"附近有没有
 * 可爬的窗口"触发（见 `perch`），不是抽签抽出来的。所以权重表的类型仍收窄在
 * `AmbientActivity` 上，只有编排器接受更宽的 `PetPose`。
 */
export type PetPose = AmbientActivity | "climb" | "crawl"

/** 时长区间（毫秒，闭区间） */
export interface DurationRange {
  min: number
  max: number
}

export interface AmbientConfig {
  /**
   * 各活动的抽取权重。
   *
   * **不要求归一化**：用累积法抽取，只比较相对大小。但全 0 是非法配置
   * （抽不出任何活动），`pickActivity` 会退化为第一个键。
   */
  weights: Record<AmbientActivity, number>
  /** 各活动的持续时长 */
  durations: Record<AmbientActivity, DurationRange>
  /** 行走速度（像素/秒）。60 取自参考项目的 `MOVE_VELOCITY` */
  walkSpeed: number
}

/**
 * 默认配置：平均每 20~35 秒有一次活动。
 *
 * 数值来自两处：`walkSpeed` 直接沿用参考项目；时长区间是本项目自己定的——
 * 参考项目没有"活动时长"这个概念（它只有 5 秒的决策节拍，活动本身持续到被下次掷签打断）。
 */
export const AMBIENT_DEFAULTS: AmbientConfig = {
  weights: { stand: 0.45, walk: 0.35, sit: 0.2 },
  durations: {
    stand: { min: 15_000, max: 45_000 },
    sit: { min: 20_000, max: 60_000 },
    walk: { min: 3_000, max: 10_000 },
  },
  walkSpeed: 60,
}

/** 一次活动计划 */
export interface AmbientPlan {
  activity: AmbientActivity
  durationMs: number
}

/** 活动顺序（抽签的累积顺序，也是权重表缺失键时的兜底顺序） */
const ACTIVITY_ORDER: readonly AmbientActivity[] = ["stand", "sit", "walk"]

/**
 * 把 `rand()` 夹到 [0,1]。
 *
 * **上端取 1 而不是 0.999…**：`activityDuration` 靠它取到区间右端点，
 * 夹成开区间的话「配了 3~10 秒」永远走不到 10 秒。
 * `pickActivity` 那边 `r === total` 会落到末尾的兜底返回，同样安全。
 */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * 按权重抽一个活动（累积法）。
 *
 * 用累积法而不是"轮盘 + 排序"，是为了让**权重表的声明顺序**就是兜底顺序：
 * 浮点误差或权重全 0 时落到第一个键，而不是落进未定义行为。
 */
export function pickActivity(
  rand: () => number,
  weights: Record<AmbientActivity, number>,
): AmbientActivity {
  const total = ACTIVITY_ORDER.reduce((s, a) => s + Math.max(0, weights[a] ?? 0), 0);
  if (!(total > 0)) return ACTIVITY_ORDER[0];

  const r = clamp01(rand()) * total;
  let acc = 0;
  for (const a of ACTIVITY_ORDER) {
    acc += Math.max(0, weights[a] ?? 0);
    if (r < acc) return a;
  }
  // 浮点累加的尾巴：`acc` 可能差一点点够不到 total
  return ACTIVITY_ORDER[ACTIVITY_ORDER.length - 1];
}

/**
 * 取某活动的持续时长（区间内均匀取值）。
 *
 * `min > max` 时按 `min` 处理而不是交换——配置写反了要能被看出来，
 * 悄悄交换会让「我明明配了 3~10 秒」变成别的行为。
 */
export function activityDuration(
  activity: AmbientActivity,
  rand: () => number,
  durations: Record<AmbientActivity, DurationRange>,
): number {
  const d = durations[activity];
  if (!d) return 0;
  const lo = Math.max(0, d.min);
  const hi = Math.max(lo, d.max);
  return lo + clamp01(rand()) * (hi - lo);
}

/** 抽一次完整计划：下一个活动 + 它持续多久 */
export function planNextActivity(rand: () => number, cfg: AmbientConfig): AmbientPlan {
  const activity = pickActivity(rand, cfg.weights);
  return { activity, durationMs: activityDuration(activity, rand, cfg.durations) };
}

/**
 * 初始计划：**第一次一定是站着**。
 *
 * 进入宠物模式的第一帧就走起来会很突兀——用户刚切过来，宠物应当先"在那儿"，
 * 过一会儿再动。所以首次只抽时长，不抽活动。
 */
export function initialPlan(rand: () => number, cfg: AmbientConfig): AmbientPlan {
  return { activity: "stand", durationMs: activityDuration("stand", rand, cfg.durations) };
}
