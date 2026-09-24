/**
 * trait-procedural —— 性格/精力 → 程序化原语倍率（pet-core，零依赖）
 *
 * 设计依据：宠物智能化设计 §8.6.1「性格 → 参数映射表」。这是"性格看得见"最直接的落点：
 * 全部是数值调整，**不需要新素材**，所以在只有 1 张脸、2 个动作组的模型上也成立。
 *
 * ## 为什么是「倍率」而不是「参数」
 *
 * 原语的真实数值由**清单**声明（`Idle` 组写着 `{bob:9, breathe:1.01, blink:3200}`）——
 * 那是素材作者对这个模型的判断，不该被代码覆盖。性格改的是**在它之上乘多少**。
 * 而且 `sway` 与 `nod` 在 `evaluateProcedural` 里是**先相加再取正弦**的
 * （`rotation = swayAngle(sway) + nodAngle(nod)`），拿到 transform 就再也分不开了，
 * 想分别缩放只能在**参数**这一层动手。
 *
 * ## 两条必须遵守的约定
 *
 * 1. **`breathe` 乘偏离量，不是总量。** `1 + (max-1)·wave` 是以 1 为中心的振幅，
 *    写成 `breathe × 1.2` 会把"呼吸加重"变成"整体放大 20%"——不报错、不 NaN，
 *    只是"有点怪"。与 `applyActivityModulation` 同一条约定，同一个坑。
 * 2. **恒等时原样返回入参**（引用相等）。本层在 `idle` 且五维中性时必须与本设计
 *    上线前**逐像素一致**，`1 + (x-1)×1` 在 IEEE754 下并不精确等于 `x`。
 *
 * 约束（务必保持）：本包为纯 TS，禁止 import 任何运行时依赖。
 */

import type { TraitValues } from "../personality/trait-label.js";
import type { ProceduralParams } from "./procedural-motion.js";

/** 性格只需要五维里的这几维；结构兼容 `TraitValues`，避免反向依赖 */
export interface TraitProceduralInput {
  readonly openness: number;
  readonly extraversion: number;
  readonly agreeableness: number;
  readonly neuroticism: number;
}

/**
 * 精力只需要这一个分量（`mood.energy`）。
 *
 * **宠物自己的 mood 在第二期还不存在**（它随第四期的感知线一起上线），所以入参可省，
 * 省了就按基线算——那时本层纯粹由性格驱动，正好是验收 U1「静止时看出区别」要的东西。
 */
export interface EnergyInput {
  readonly energy: number;
}

/** 精力基线（与 `mood.ts` 的 `BASELINE.energy` 同值，但**不反向依赖 agent-runtime**） */
export const BASELINE_ENERGY = 0.6;

/** 五维中性值 */
const NEUTRAL_TRAIT = 0.5;

/**
 * 倍率的取值范围。
 *
 * 上下界存在的理由与 `adjustWeightsByMood` 的夹取同源：五维各自乘一遍之后，
 * 极端个体（0.15 / 0.85）叠加出来的幅度会大到不像同一只宠物。**宁可温和也不要极端**，
 * 因为这一层是常驻的——用户看到的是它每秒的样子，不是一次事件。
 */
export const SCALE_MIN = 0.55;
export const SCALE_MAX = 1.8;

/** 各原语的倍率。1 = 保持清单声明的原值（恒等元） */
export interface ProceduralScales {
  /** 乘在浮动（bob）振幅上 */
  readonly bob: number;
  /** 乘在呼吸**偏离量**上（不是呼吸倍率本身） */
  readonly breathe: number;
  /** 乘在摇摆角度上 */
  readonly sway: number;
  /** 乘在点头角度上 */
  readonly nod: number;
  /** 乘在眨眼**平均间隔**上（>1 更慢更稳，<1 更快） */
  readonly blink: number;
  /**
   * 眨眼间隔抖动的**增量**（不是绝对值，也不是倍率）。
   *
   * 绝对值会让恒等元变成 0——而 0 与 `procedural-motion` 的默认 `BLINK_JITTER` 不是一回事，
   * 接线那一刻就把"眨眼节奏"悄悄改掉了（回归）。增量语义下恒等元天然是 0，
   * 宿主按 `BLINK_JITTER + 增量` 使用。
   */
  readonly blinkJitterBonus: number;
}

/** 恒等元。引用相等是判据——宿主据此走"连乘法都省掉"的快路径 */
export const IDENTITY_PROCEDURAL_SCALES: ProceduralScales = Object.freeze({
  bob: 1,
  breathe: 1,
  sway: 1,
  nod: 1,
  blink: 1,
  blinkJitterBonus: 0,
});

export function isIdentityScales(s: ProceduralScales): boolean {
  return s === IDENTITY_PROCEDURAL_SCALES;
}

function clampScale(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, v));
}

/** 0..1 归一，非有限数落回中性 */
function norm(v: number): number {
  if (!Number.isFinite(v)) return NEUTRAL_TRAIT;
  return Math.min(1, Math.max(0, v));
}

/** 线性映射：`v=0` 取 `lo`，`v=1` 取 `hi` */
function lerp(lo: number, hi: number, v: number): number {
  return lo + (hi - lo) * v;
}

/** 眨眼抖动基线，与 `procedural-motion.ts` 的 `BLINK_JITTER` 同值 */
export const BASE_BLINK_JITTER = 0.4;
/**
 * 神经质拉满时抖动的最大增量（"快而乱"里的"乱"）。
 *
 * 取 0.35 而不是更大：`BlinkScheduler` 把抖动夹在 `mean×(1±jitter)`，
 * jitter 越过 1 时下界会变负（间隔为负 → 序列错乱）。0.4+0.35=0.75 离它还有余量。
 */
const MAX_BLINK_JITTER_BONUS = 0.35;

/**
 * 五维 + 精力 → 各原语倍率。
 *
 * 方向全部取自设计 §8.6.1 的表，**低位不取 0**：性格是"偏向"，不是开关——
 * 一只内向的宠物也应该会浮动，只是浮得小。取 0 会让"低 extraversion"看起来像坏了。
 *
 * | 输入 | 影响 | 方向 |
 * |---|---|---|
 * | `extraversion` | `bob` | 高 → 浮动大 |
 * | `openness` | `sway` | 高 → 摇摆大 |
 * | `agreeableness` | `nod` | 高 → 点头多 |
 * | `energy` | `breathe` | 高 → 呼吸幅度大 |
 * | `energy` | `blink` | 高 → 慢而稳（间隔变长） |
 * | `neuroticism` | `blink` + 抖动 | 高 → 快而乱（间隔变短、抖动变大） |
 */
export function traitsToProceduralScales(
  traits: TraitProceduralInput,
  energy: EnergyInput | null = null,
): ProceduralScales {
  const openness = norm(traits.openness);
  const extraversion = norm(traits.extraversion);
  const agreeableness = norm(traits.agreeableness);
  const neuroticism = norm(traits.neuroticism);
  const e = energy ? norm(energy.energy) : BASELINE_ENERGY;

  // 全中性 + 基线精力 → 恒等。**必须是这个元**，否则"上线前逐像素一致"无从谈起
  const isNeutral =
    openness === NEUTRAL_TRAIT &&
    extraversion === NEUTRAL_TRAIT &&
    agreeableness === NEUTRAL_TRAIT &&
    neuroticism === NEUTRAL_TRAIT &&
    e === BASELINE_ENERGY;
  if (isNeutral) return IDENTITY_PROCEDURAL_SCALES;

  return {
    bob: clampScale(lerp(0.7, 1.35, extraversion)),
    breathe: clampScale(lerp(0.75, 1.3, e)),
    sway: clampScale(lerp(0.6, 1.45, openness)),
    nod: clampScale(lerp(0.6, 1.45, agreeableness)),
    // 两个因子相乘：精力高把间隔拉长（慢而稳），神经质高把间隔压短（快）
    blink: clampScale(lerp(0.8, 1.25, e) * lerp(1.35, 0.7, neuroticism)),
    // 偏离中性才产生增量：0.5 → 0（恒等），0.85 → +0.35，0.15 → −0.35（比默认更规律）
    blinkJitterBonus: MAX_BLINK_JITTER_BONUS * (neuroticism - NEUTRAL_TRAIT) * 2,
  };
}

/**
 * 把倍率叠到清单声明的参数上。**这是本层唯一的算术落点**。
 *
 * `base` 为空时返回空——该动作组没声明原语就什么都不做。
 * 这里刻意**不**兜底造一组默认值：那等于给没打算动的模型凭空加动作，
 * 与 `playConventionalMotion`「不凭空造动作组」同一条原则。
 */
export function scaleProceduralParams(
  base: ProceduralParams | undefined,
  scales: ProceduralScales,
): ProceduralParams | undefined {
  if (!base) return undefined;
  if (isIdentityScales(scales)) return base;

  const out: ProceduralParams = { ...base };
  if (base.bob !== undefined) out.bob = base.bob * scales.bob;
  if (base.sway !== undefined) out.sway = base.sway * scales.sway;
  if (base.nod !== undefined) out.nod = base.nod * scales.nod;
  if (base.blink !== undefined) out.blink = base.blink * scales.blink;
  // 呼吸乘的是**偏离量**：`1 + (max-1)·k`，不是 `max·k`
  if (base.breathe !== undefined) out.breathe = 1 + (base.breathe - 1) * scales.breathe;
  return out;
}

/**
 * 两级倍率相乘（性格 × 模型能力补偿，T2.5）。
 *
 * 分开算再合成，而不是把补偿直接乘进 `traitsToProceduralScales` 的返回值：
 * 后者会让"性格改了"与"换了只没有表情层的模型"在日志里长得一模一样。
 */
export function composeScales(a: ProceduralScales, b: ProceduralScales): ProceduralScales {
  if (isIdentityScales(a)) return b;
  if (isIdentityScales(b)) return a;
  return {
    bob: clampScale(a.bob * b.bob),
    breathe: clampScale(a.breathe * b.breathe),
    sway: clampScale(a.sway * b.sway),
    nod: clampScale(a.nod * b.nod),
    blink: clampScale(a.blink * b.blink),
    // 抖动是增量不是倍率，**相加**：增量乘增量没有物理意义，且轻易越过 1
    blinkJitterBonus: a.blinkJitterBonus + b.blinkJitterBonus,
  };
}

/**
 * 无表情层模型的幅度补偿倍率（设计 §8.5「表情层的诚实降级」）。
 *
 * 那些模型只有一张脸，情绪**只能**靠幅度表达；不补的话"我心情这么差它一点反应都没有"，
 * 用户会以为宠物坏了。起手 ×1.5，实测手感再调。
 */
export const NO_EXPRESSION_LAYER_SCALES: ProceduralScales = Object.freeze({
  bob: 1.5,
  breathe: 1.5,
  sway: 1.5,
  nod: 1.5,
  blink: 1,
  blinkJitterBonus: 0,
});
