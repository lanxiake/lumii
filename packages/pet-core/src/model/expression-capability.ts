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
 * 这个模型是否**没有**可用的表情层——幅度补偿（§8.5）的判据。
 *
 * 单独开一个函数而不是让调用方写 `=== "none"`：补偿要开在哪个档位是会变的
 * （"基本"档实测下来如果也看不出情绪，就得把它并进来），改一处比改三处可靠。
 */
export function needsAmplitudeCompensation(
  emotionMap: Record<string, number> | null | undefined,
): boolean {
  return expressionCapability(emotionMap) === "none";
}
