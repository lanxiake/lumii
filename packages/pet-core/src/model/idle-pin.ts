/**
 * idle-pin — 把**一次性动作**的首末帧锚到待机首帧（pet-core，纯函数）
 *
 * 设计依据：docs/design/客户端UI/2026-09-21-桌宠动作生成方案调研.md §5.2。
 * 出处是 `sprite_h3` 的 Idle Pin，`mypet` 的调研把它列为「H3 官方工作流原生支持、
 * 不是 hack」的三条好处：身份不会越走越远、动作自然回到 neutral、
 * **不同动画之间可以直接连续切换**。
 *
 * ## 为什么是「按名引用」而不是「让模型把待机姿态重画一遍」
 *
 * 动作是**单独一批**出的图，它自己的第一格不会是待机的那个姿势。实测樱桃：
 * 待机四帧的重心都在 x≈191、轮廓包围盒 106–111 宽；挥手四帧的包围盒是 128→169、
 * 重心右移 5–20px——**挥手首帧离待机很远**，从待机进挥手、以及挥手播完回待机，
 * 两头都会跳。
 *
 * 而让模型「把待机站姿也画进第一格」解决不了：生成模型重画同一个姿势**必然有漂移**，
 * 端点只是"看起来差不多"，接上去仍然会顿一下。真正无缝的唯一办法是端点**就是同一张图**。
 *
 * 所以这里不改任何像素：图集里本来就有待机帧，让一次性动作的首末两格**引用它**即可。
 * 代价是零——不重出图、不浪费格子（生成的四格全用在动作经过上）。
 *
 * ## 只对 once 动作做
 *
 * 循环动作（待机、走路）要的是「末格接回首格」，钉到待机上等于把循环掐断，语义相反。
 * 调用方负责只在 `kind: "once"` 上用；本函数不管你传什么都会照做。
 */

import type { SpriteFrameRef } from "./sprite-manifest.js";

export interface IdlePinOptions {
  /** 首格停留时长（毫秒）。省略则沿用被锚定动作首格的时长 */
  headMs?: number
  /** 末格停留时长（毫秒）。省略则沿用被锚定动作末格的时长 */
  tailMs?: number
}

/**
 * 去掉时长、只留「这一帧画什么」。
 *
 * 待机帧的 `durationMs` 是**待机循环的节奏**，搬进一次性动作里没有意义：
 * 待机首格停 420ms 是因为它在一个四帧呼吸循环里，而这里它是挥手的起手式。
 * 节奏由调用方按被锚定动作自己的首末格给（见 `IdlePinOptions`）。
 */
function poseOf(frame: SpriteFrameRef): Omit<SpriteFrameRef, "durationMs"> {
  const { durationMs: _drop, ...pose } = frame
  return pose
}

/**
 * 深拷贝帧：槽位是嵌套的普通对象（`{ face: { eyes: "eye_open" } }`）。
 *
 * 不能只做浅拷贝——那样首末两格的 `face` 会指向同一个对象，
 * 之后谁按帧改一个槽位部件，两格会一起变。
 * 帧里只有普通对象/数组/原始值，所以这个简单实现就够，不必引入依赖。
 */
function deepClone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(deepClone) as unknown as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, deepClone(val)]),
    ) as T;
  }
  return v;
}

/**
 * 在 `frames` 前后各插一格待机首帧，返回新数组（不改入参）。
 *
 * 首末两格是**同一帧的独立深拷贝**——之后谁按帧改槽位或时长，两份不会互相牵动。
 * `durationMs` 省略时保持省略（渲染层会回落到 `fps` 均分），不硬塞一个 0。
 */
export function pinIdleFrames(
  frames: SpriteFrameRef[],
  idleFrame: SpriteFrameRef,
  opts: IdlePinOptions = {},
): SpriteFrameRef[] {
  if (frames.length === 0) return [...frames];

  const headMs = opts.headMs ?? frames[0]?.durationMs;
  const tailMs = opts.tailMs ?? frames[frames.length - 1]?.durationMs;
  const pose = poseOf(idleFrame);

  const head = deepClone(pose) as SpriteFrameRef;
  const tail = deepClone(pose) as SpriteFrameRef;
  if (typeof headMs === "number" && headMs > 0) head.durationMs = headMs;
  if (typeof tailMs === "number" && tailMs > 0) tail.durationMs = tailMs;

  return [head, ...frames.map((f) => deepClone(f)), tail];
}

/**
 * 把「这一帧画什么」写成规范字符串，用来比两帧是否同一姿态。
 *
 * **必须按键名排序**：`JSON.stringify` 是按键序输出的，而清单是手也可以改的——
 * 同样两个键写反了顺序就会得出「不是同一帧」，检查于是开始误报。
 * 递归排序，因为槽位是嵌套对象（`{ face: { eyes: "eye_open" } }`）。
 */
function canonicalPose(frame: SpriteFrameRef): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, sort(val)]),
      )
    }
    return v
  }
  return JSON.stringify(sort(poseOf(frame)))
}

/**
 * 检查一个一次性动作是否真的被钉住了。
 *
 * 判据是**端点与待机首帧的「画什么」完全一致**（`base` 与各槽位部件名），
 * 不比像素——按名引用的话这必然成立，所以这条检查真正的用处是**发现有人改坏了装配**：
 * 比如后来把一次性动作也改成重新生成端点、或者手改清单时漏了一格。
 *
 * `kind` 不是 once 或没有 `next` 时不判（返回 ok），循环动作本来就不该被钉。
 */
export function checkIdlePin(
  anim: { kind: string; group: string; next?: string; frames?: SpriteFrameRef[] },
  idleFrame: SpriteFrameRef,
): { ok: true } | { ok: false; reason: string } {
  if (anim.kind !== "once") return { ok: true };
  const frames = anim.frames ?? [];
  if (frames.length < 2) {
    return { ok: false, reason: `一次性动作「${anim.group}」只有 ${frames.length} 帧，两端钉不住` };
  }

  const want = canonicalPose(idleFrame);
  const head = frames[0]!;
  const tail = frames[frames.length - 1]!;
  if (canonicalPose(head) !== want) {
    return {
      ok: false,
      reason: `一次性动作「${anim.group}」首格不是待机姿态（${head.base ?? "?"}）——从待机进场会跳`,
    };
  }
  if (canonicalPose(tail) !== want) {
    return {
      ok: false,
      reason:
        `一次性动作「${anim.group}」末格不是待机姿态（${tail.base ?? "?"}）——` +
        `播完接回 ${anim.next ?? "?"} 会跳`,
    };
  }
  return { ok: true };
}
