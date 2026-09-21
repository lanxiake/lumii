/**
 * 精灵图播放推进 —— 帧游标按真实时间往前走
 *
 * 从渲染器里抠出来的。`SpritePetRenderer` 的注释写着「帧增量归一…都在 pet-core 里」，
 * 但那段 while 循环原本长在类方法里，要建 canvas / PIXI 才能碰到，于是**没有任何测试**。
 * 而它错了不会报错，只会一直按错的速度播下去——正是最该被测的那类逻辑。
 *
 * 按 `deltaMS` 累加而不是按 tick 次数：`setFpsCap` 会把 ticker 降到 15fps，
 * 按 tick 推进的话 8fps 的动画会变成慢动作（见渲染器头部注释第 2 条）。
 */

import type { ResolvedAnimation } from "./sprite-runtime.js";

/** 帧游标 */
export interface PlaybackState {
  /** 当前帧下标 */
  frame: number;
  /** 当前帧已经过去多少毫秒 */
  elapsedMs: number;
}

export interface AdvanceResult extends PlaybackState {
  /** 这一 tick 里帧号是否变过——没变就不必重画 */
  advanced: boolean;
}

/**
 * 一 tick 内最多推进几帧（帧数的倍数）。
 *
 * 不是性能优化，是**防挂死**：`durationMs` 允许小到 1 毫秒，此时一次长掉帧
 * （窗口失焦回来、断点停留）能让 `deltaMS` 大到循环转上万次。正常一帧只进一次。
 */
const MAX_STEPS_PER_TICK = 4;

/**
 * 推进一帧游标。
 *
 * 逐帧时长优先，缺项回落到 `1000 / fps`。**`durationsMs[i]` 为 0 表示「这一帧没声明」**
 * ——不能当成 0 毫秒，那会变成瞬跳。累加器按**当前帧**的时长扣，所以换帧之后余量接着算，
 * 不会因为某一帧长就整体漂移。
 *
 * `kind === "once"` 走到最后一帧就停住（不再回头），调用方靠 `frame` 是否到底判断播完。
 */
export function advanceSpriteFrame(
  anim: Pick<ResolvedAnimation, "frames" | "fps" | "kind" | "durationsMs">,
  state: PlaybackState,
  deltaMS: number,
): AdvanceResult {
  const count = anim.frames.length;
  if (count <= 1) return { frame: state.frame, elapsedMs: state.elapsedMs, advanced: false };

  const uniform = 1000 / Math.max(1, anim.fps);
  const durationOf = (i: number): number => {
    const d = anim.durationsMs?.[i];
    return typeof d === "number" && d > 0 ? d : uniform;
  };

  let frame = state.frame;
  let elapsedMs = state.elapsedMs + deltaMS;
  let advanced = false;
  let guard = count * MAX_STEPS_PER_TICK;
  while (elapsedMs >= durationOf(frame) && guard-- > 0) {
    elapsedMs -= durationOf(frame);
    if (anim.kind === "loop") {
      frame = (frame + 1) % count;
    } else if (frame < count - 1) {
      frame += 1;
    } else {
      break;
    }
    advanced = true;
  }
  return { frame, elapsedMs, advanced };
}
