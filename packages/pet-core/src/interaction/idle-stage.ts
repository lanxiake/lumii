/**
 * idle-stage — 用户闲置时长 → 宠物阶段（pet-core，零依赖）
 *
 * 设计依据：docs/plans/客户端UI/2026-09-21-宠物自制系统P2-c实施计划.md §3.1
 *
 * 输入是 `powerMonitor.getSystemIdleTime()` 的**整数秒**（用户多久没碰键鼠）。
 * 输出三档：`awake` / `drowsy`（打盹）/ `asleep`（睡着）。
 *
 * ## 为什么是三级而不是「到点就睡」
 *
 * 宠物「慢慢困了」才像活的；5 分钟一到立刻瘫倒，像是被断了电。
 *
 * ## 为什么不需要额外的迟滞逻辑
 *
 * 有输入时闲置秒数**直接归零**，而两档之间差着几分钟：
 * 睡着（300s）→ 醒来只需要「有过一次输入」（秒数 < 打盹阈值 60s），
 * 再睡回去又要 300s。阈值附近不可能来回抖，迟滞是这两条规则免费带来的。
 * 醒来不存在单独的阈值——「用户动了」这件事本身就是阈值，秒数归零即醒。
 *
 * ## 边界一律往「醒着」倒
 *
 * 负数 / NaN / Infinity 全部当作 `awake`。反了会**永远睡着叫不醒**，
 * 那种故障在桌面上看起来就是「宠物卡死了」，极难反查到是这个函数。
 */

/** 宠物闲置阶段 */
export type PetIdleStage = "awake" | "drowsy" | "asleep";

export interface IdleStageOptions {
  /** 进入打盹的闲置秒数；默认 60 */
  drowsySec?: number;
  /** 进入睡着的闲置秒数；默认 300 */
  asleepSec?: number;
}

/**
 * 默认阈值。
 *
 * 60s / 300s 是按桌面软件的手感取的：一分钟没动，宠物开始犯困；
 * 五分钟没动，基本可以认定人不在。Windows 自己锁屏多在 5~15 分钟，
 * 宠物睡着要早于锁屏，否则用户永远看不到这一档。
 */
export const IDLE_STAGE_DEFAULTS: Required<IdleStageOptions> = {
  drowsySec: 60,
  asleepSec: 300,
};

/** 取有限数：`undefined` 与 NaN/Infinity 一律退化为 fallback */
const finite = (v: number | undefined, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * 闲置秒数 → 阶段。
 *
 * 单调：秒数增大时阶段只进不退（awake → drowsy → asleep），
 * 所以调用方可以放心地「只在阶段变化时才动作」。
 */
export function idleStage(
  idleSec: number,
  options: IdleStageOptions = {},
): PetIdleStage {
  // 非有限输入先挡掉：`Infinity >= asleepSec` 会判成「永远睡着」，
  // 那是把一次读取失败变成了叫不醒的宠物。
  if (typeof idleSec !== "number" || !Number.isFinite(idleSec) || idleSec < 0) {
    return "awake";
  }

  const drowsySec = Math.max(0, finite(options.drowsySec, IDLE_STAGE_DEFAULTS.drowsySec));
  // 睡着不得早于打盹：配反了就让打盹档消失（直接进睡着），而不是让阶段在时间轴上倒挂
  const asleepSec = Math.max(
    drowsySec,
    finite(options.asleepSec, IDLE_STAGE_DEFAULTS.asleepSec),
  );

  if (idleSec >= asleepSec) return "asleep";
  if (idleSec >= drowsySec) return "drowsy";
  return "awake";
}
