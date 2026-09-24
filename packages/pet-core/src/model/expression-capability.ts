/**
 * expression-capability —— 模型的「表情层能力」判定（pet-core，零依赖）
 *
 * 设计依据：宠物智能化设计 §8.1.1 与 §8.5「表情层的诚实降级」。
 *
 * ## 为什么判据是「能解析出几个不同索引」而不是「emotionMap 有几个键」
 *
 * 键数是**声明量**，索引数才是**表现量**。两者在真实数据上对不上：
 *
 * - `xiaomai` 的 `emotionMap` 有 14 个键（neutral/smile/joy/calm/shy/sadness/anger…），
 *   乍看"有 5 种表情"，但**全部映射到索引 0**——它实际只有一张脸。
 *   按键数判会把它算成"表情丰富"，于是不补幅度；而用户看到的是"我心情这么差它一点反应都没有"，
 *   正是 §8.5 要避免的那句"以为宠物坏了"。
 * - `demo_cartoon_cat` 的 `emotionMap` 是空对象，索引数 0。
 *
 * 同一个原因，判据也不能只看"有没有 `neutral`"——`demo_mecha_gundam` 恰好有
 * `{neutral:0, 平静:0, 默认:0}`，是**三个键、一张脸**。
 *
 * 约束（务必保持）：本包为纯 TS，禁止 import 任何运行时依赖。
 */

/** 表情层能力档位 */
export type ExpressionCapability = "rich" | "basic" | "none";

/** 能表达情绪的索引数下限（低于它只能算"基本"，用户几乎看不出差别） */
export const RICH_MIN_INDICES = 4;
/** 有表情层的索引数下限（1 及以下 = 只有一张脸） */
export const LAYER_MIN_INDICES = 2;

/**
 * 判定表情层能力。
 *
 * @param emotionMap 模型的语义表情表（可缺省——缺省即"没声明"）
 */
export function expressionCapability(
  emotionMap: Record<string, number> | null | undefined,
): ExpressionCapability {
  const distinct = countDistinctExpressions(emotionMap);
  if (distinct >= RICH_MIN_INDICES) return "rich";
  if (distinct >= LAYER_MIN_INDICES) return "basic";
  return "none";
}

/** 能解析出几个**不同**的表情索引；非有限数的映射忽略（视为无效声明） */
export function countDistinctExpressions(
  emotionMap: Record<string, number> | null | undefined,
): number {
  if (!emotionMap) return 0;
  const seen = new Set<number>();
  for (const value of Object.values(emotionMap)) {
    if (typeof value === "number" && Number.isFinite(value)) seen.add(value);
  }
  return seen.size;
}

/**
 * 这个模型是否**没有**可用的表情层——表达补偿（§8.5）的判据。
 *
 * 单独开一个函数而不是让调用方写 `=== "none"`：补偿要开在哪个档位是会变的
 * （"基本"档实测下来如果也看不出情绪，就得把它并进来），改一处比改三处可靠。
 *
 * ⚠ 名字里的 **expressiveness 而不是 amplitude**：2026-09-24 修订后，补偿投在
 * **眨眼节奏与活动参数**上，不再投在 `bob`/`breathe` 那类幅度上——它们在待机组里
 * 要么被 `stripIdleDrift` 摘掉、要么小到看不见（理由见 {@link NO_EXPRESSION_LAYER_GAIN}）。
 */
export function needsExpressivenessCompensation(
  emotionMap: Record<string, number> | null | undefined,
): boolean {
  return expressionCapability(emotionMap) === "none";
}

/**
 * 无表情层模型的**表达增益**（设计 §8.5 / 验收 U7；2026-09-24 修订后转投）。
 *
 * ## 为什么不再是「幅度 ×1.5」
 *
 * 原方案是把 `bob`/`breathe`/`sway`/`nod` 四个幅度各乘 1.5。实测下来这条路走不通：
 *
 * - `bob`/`sway` 被 `stripIdleDrift` 从待机组摘掉了（用户拍板保留那条规则）；
 * - `nod` 要清单声明了才有得可乘；
 * - 唯一还在的 `breathe` 量级是 `1+(base−1)×倍率`，团子 `1.01` → `1.016`，
 *   在 80px 高的精灵上**约 1.3px**。
 *
 * 于是 ×1.5 在静止状态**一分都看不见**，而 §8.5 却据此告诉用户"基础模型的情绪主要
 * 通过动作幅度表达"——承诺了一个看不到的东西。
 *
 * ## 转投到哪
 *
 * 落在**待机上仍然可见**的两条通道，两处放大都是**偏离基准的量**而不是总量：
 *
 * 1. **眨眼节奏**（间隔 + 抖动）——`render/trait-procedural.ts` 的
 *    `amplifyExpressiveDeviation`。无表情层模型只有一张脸，眨眼是它唯一的"面部"节奏。
 * 2. **活动参数**（权重 + 时长）——`behavior/ambient.ts` 的 `adjustAmbientConfig`
 *    的 `expressiveness` 参数。它只剩举止这一条表达通道了。
 *
 * **常量只在这里定义一次**：两个消费者分别 import。分头写两个 1.6 的话，
 * 调参时一定会漏掉一个，而症状（"眨眼变了但走动没变"）看起来像 bug 不像漏改。
 */
export const NO_EXPRESSION_LAYER_GAIN = 1.6;
