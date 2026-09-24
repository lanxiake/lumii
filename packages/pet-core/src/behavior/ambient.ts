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
 * 比 `AmbientActivity` 宽：攀爬（climb/crawl）与坠落（fall）**都不进随机池**——
 * 攀爬由"附近有没有可爬的窗口"触发（见 `perch`），坠落是"从窗口上掉下来"的物理过程。
 * 所以权重表的类型仍收窄在 `AmbientActivity` 上，只有编排器接受更宽的 `PetPose`。
 */
export type PetPose = AmbientActivity | "climb" | "crawl" | "fall"

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

// ---------------------------------------------------------------------------
// 性格 / 情绪 → 活动参数（宠物智能化设计 §3.4、§8.6.1）
// ---------------------------------------------------------------------------

/**
 * 权重夹取的上下界。
 *
 * **这是本模块唯一的硬护栏，不能省。** 五维系数会**乘到同一组权重上**，
 * 无夹取时极端个体（0.15 / 0.85 两端）叠加出来的比例可以把某个活动推到
 * 近乎 0（"永不动"）或吞掉其余全部（"永不停"）——两种都是"看起来像坏了"的形态，
 * 而且不报错。下界 0.05 同时兼作"权重不得为 0"的保证：全 0 是非法配置，
 * `pickActivity` 会退化成第一个键。
 */
export const WEIGHT_MIN = 0.05;
export const WEIGHT_MAX = 5.0;

/** 时长夹取：再活泼也不该 200ms 换一次姿势，再蔫也不该十分钟不动 */
export const DURATION_SCALE_MIN = 0.6;
export const DURATION_SCALE_MAX = 1.6;

/** 情绪与性格里、本模块要用的那几个分量。全部可省——省了按中性/基线算。 */
export interface AmbientTuningInput {
  /** 精力 0..1（`mood.energy`）；高 → 更愿意走动 */
  readonly energy?: number;
  /** 心情 -1..1（`mood.valence`）；低 → 更多坐着（蔫） */
  readonly valence?: number;
  /** 外向性 0..1；高 → 走动多、站立少 */
  readonly extraversion?: number;
  /** 开放性 0..1；高 → 活动间隔短（更爱折腾） */
  readonly openness?: number;
}

/** 中性值：全部取它时 `adjustAmbientConfig` 必须原样返回入参 */
const NEUTRAL_ENERGY = 0.6;
const NEUTRAL_TRAIT = 0.5;

function norm01(v: number | undefined, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(lo: number, hi: number, t: number): number {
  return lo + (hi - lo) * t;
}

function clampWeight(v: number): number {
  if (!Number.isFinite(v)) return WEIGHT_MIN;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, v));
}

/** 是否中性输入（用于"原样返回入参"的快路径） */
function isNeutralTuning(t: AmbientTuningInput): boolean {
  return (
    (t.energy === undefined || t.energy === NEUTRAL_ENERGY) &&
    (t.valence === undefined || t.valence === 0) &&
    (t.extraversion === undefined || t.extraversion === NEUTRAL_TRAIT) &&
    (t.openness === undefined || t.openness === NEUTRAL_TRAIT)
  );
}

/**
 * 按情绪与性格调整活动权重。
 *
 * **只调相对关系，不做归一化**——`pickActivity` 用的是累积法、只比较相对大小，
 * 归一化反而会引入一层无谓的浮点误差（并让"权重表可整表替换"这条约定变味）。
 *
 * | 输入 | 效果 | 依据 |
 * |---|---|---|
 * | extraversion 高 | 走动权重↑、坐下权重↓ | §3.4「走动权重」 |
 * | energy 高 | 走动权重↑ | 精力足才走得动 |
 * | valence 低 | 坐下权重↑ | 蔫了就多待着（§4.1.3 真实共情的行为出口） |
 */
export function adjustWeightsByMood(
  base: Record<AmbientActivity, number>,
  mood?: AmbientTuningInput | null,
  traits?: AmbientTuningInput | null,
): Record<AmbientActivity, number> {
  const merged: AmbientTuningInput = { ...traits, ...mood };
  if (isNeutralTuning(merged)) return base;

  const extraversion = norm01(merged.extraversion, NEUTRAL_TRAIT);
  const energy = norm01(merged.energy, NEUTRAL_ENERGY);
  const valence = merged.valence === undefined || !Number.isFinite(merged.valence)
    ? 0
    : Math.max(-1, Math.min(1, merged.valence));

  // 走动：外向 × 精力。两个因子都不取 0，内向且没精神的宠物也**偶尔**走一趟
  const walkFactor = lerp(0.6, 1.6, extraversion) * lerp(0.75, 1.25, energy);
  // 坐下：外向的反向 + 心情差的加成。低 valence 最多让"坐着"翻倍，不是无限大
  const sitFactor = lerp(1.4, 0.7, extraversion) * lerp(1.0, 2.0, Math.max(0, -valence));

  return {
    stand: clampWeight(base.stand),
    walk: clampWeight(base.walk * walkFactor),
    sit: clampWeight(base.sit * sitFactor),
  };
}

/**
 * 按性格调整活动时长（设计 §8.6.1「活动间隔：高 openness/extraversion → 短」）。
 *
 * 与权重是两件事：权重决定"抽到哪种活动"，时长决定"这次待多久"。
 * 一只好奇又外向的宠物既走得多、每次待得也短——两者叠加才是"闲不住"。
 */
export function adjustDurationsByTraits(
  base: Record<AmbientActivity, DurationRange>,
  traits?: AmbientTuningInput | null,
): Record<AmbientActivity, DurationRange> {
  if (!traits || isNeutralTuning(traits)) return base;
  const openness = norm01(traits.openness, NEUTRAL_TRAIT);
  const extraversion = norm01(traits.extraversion, NEUTRAL_TRAIT);
  // 两个维度各贡献一半：只用 openness 会让内向的好奇宠物也变得"闲不住"
  const liveliness = (openness + extraversion) / 2;
  const scale = lerp(DURATION_SCALE_MIN, DURATION_SCALE_MAX, 1 - liveliness);

  const scaled = (r: DurationRange): DurationRange => ({
    min: Math.round(r.min * scale),
    max: Math.round(r.max * scale),
  });
  return {
    stand: scaled(base.stand),
    sit: scaled(base.sit),
    walk: scaled(base.walk),
  };
}

/**
 * 一次性算出这个宠物该用的完整活动配置。驱动侧唯一的入口。
 *
 * 中性输入时**原样返回 `base`**（引用相等）：这是"未接线 = 与上线前一致"的判据，
 * 不能退化成"数值差不多"。
 */
export function adjustAmbientConfig(
  base: AmbientConfig,
  mood?: AmbientTuningInput | null,
  traits?: AmbientTuningInput | null,
): AmbientConfig {
  const weights = adjustWeightsByMood(base.weights, mood, traits);
  const durations = adjustDurationsByTraits(base.durations, traits);
  if (weights === base.weights && durations === base.durations) return base;
  return { ...base, weights, durations };
}

