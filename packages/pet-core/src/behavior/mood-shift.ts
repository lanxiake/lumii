/**
 * 情绪跨越阈值 → 播哪个一次性动作（pet-core，纯函数）
 *
 * 设计：docs/design/客户端UI/2026-09-23-宠物作为化身的智能化设计.md §7.3 / §8.6.2
 * 实施：docs/plans/客户端UI/2026-09-23-宠物智能化实施计划.md 四期 T4.4
 *
 * ## 为什么"按跨越播"而不是"按事件播"
 *
 * `applyMoodImpact`（`agent-runtime` 的 `mood.ts`）**每一次都会改 valence**，而触发它的
 * 事件在一轮会话里会来好几次（你打断一次、目标失败一次、任务完成一次……）。
 * 逐个事件播一次 `Cheer`/`Droop`，表现是宠物在**抽搐**——两个 1.6~2.0 秒的动作
 * 被几十毫秒一次的更新反复打断。这是这两个动作最容易接坏的地方。
 *
 * 所以判据只看**跨过没跨过那条线**，不看"发生了什么事件"。
 *
 * ## 阈值为什么取 ±0.2
 *
 * 不是拍脑袋：`agent-runtime` 的 `moodToDecisionParams` 已经在 **`valence < -0.2`**
 * 这条线上做了"心情差 → 更审慎"的判定。用同一条线，意味着**玩家看得见的那一下**
 * 与**决策上真的变蔫**是同一件事——取两条不同的线就会出现"它蔫了但没演"或"它演了但没蔫"。
 *
 * ⚠ 这两个数是**首版取值**，计划里写着"阈值要去量"（§六 T4.4）：真实数据要靠
 * `PetOrchestrator.setMood` 打的那行日志（每次 mood 更新 + 每次跨越）攒几天，
 * 看清 valence 的实际分布与每次低分会话的落差之后再定。
 *
 * ## 去抖不在这里
 *
 * "同一个方向短时间内只播一次"要读时钟，而本模块是纯函数。窗口由
 * `PetOrchestrator` 持有（它本来就有 `performance.now()`）。
 */

/** 触发「雀跃」的上界（valence 升过它） */
export const MOOD_CHEER_THRESHOLD = 0.2;
/** 触发「蔫」的下界（valence 跌破它）。与 `moodToDecisionParams` 的 selfCheckBias 同一条线 */
export const MOOD_DROOP_THRESHOLD = -0.2;

export type MoodShift = "cheer" | "droop";

/** 只关心 valence 的最小输入（`Mood` 与测试夹具都能直接传） */
export interface ValenceSample {
  readonly valence: number;
}

/**
 * 这次情绪更新**跨过线了吗**；跨了就返回该播哪个动作，否则 `null`。
 *
 * `prev` 为 `null`（还没有过情绪来源）时一律返回 `null`：**第一次读到**一个低落值
 * 不是"变蔫了"，那是它的初始状态。上线第一次就演一遍沮丧是凭空多出来的戏。
 *
 * 相等（`valence === threshold`）算**已跨过**：与 `moodToDecisionParams` 的
 * `valence < -0.2` 互补（那边严格小于才判蔫），两边合起来正好铺满、不留缝隙。
 */
export function detectMoodShift(
  prev: ValenceSample | null,
  next: ValenceSample,
  cheerThreshold: number = MOOD_CHEER_THRESHOLD,
  droopThreshold: number = MOOD_DROOP_THRESHOLD,
): MoodShift | null {
  if (!prev) return null;
  const before = prev.valence;
  const after = next.valence;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;

  if (before < cheerThreshold && after >= cheerThreshold) return "cheer";
  if (before > droopThreshold && after <= droopThreshold) return "droop";
  return null;
}
