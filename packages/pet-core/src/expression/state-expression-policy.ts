/**
 * state-expression-policy — 宠物状态 → 表情语义标签 / 动作组（纯函数，pet-core）
 *
 * 状态机切态后，用本策略把 PetState 映射成「表情语义标签 + 可选动作组」，
 * 再经模型 emotionMap 解析成 expression 索引下发渲染器。抽成纯函数供 Windows /
 * kids-mobile / 浏览器预览共用同一套状态→表情逻辑。
 *
 * 语义标签是与 registry.emotionMap 约定的稳定 key（如 neutral/joy/sad），
 * resolveExpressionIndex 用模型 emotionMap 查表，查不到回退 defaultExpression。
 */

import type { PetState } from "../state/petStateMachine.js";

/** 某状态对应的表情语义 + 可选动作组 */
export interface StateExpression {
  /** 表情语义标签（emotionMap 的 key） */
  readonly emotion: string;
  /** 该状态应播放的动作组名；无则不强制播放 */
  readonly motionGroup?: string;
}

/**
 * 状态 → 表情语义（覆盖全部 9 态，儿童友好、与两端 emotionMap 通用 key 对齐）。
 * emotion 取通用标签，具体映射到哪个 exp 由各模型 emotionMap 决定。
 */
const STATE_EXPRESSION: Readonly<Record<PetState, StateExpression>> = {
  idle: { emotion: "neutral", motionGroup: "Idle" },
  listening: { emotion: "neutral", motionGroup: "Idle" },
  recognizing: { emotion: "calm" },
  thinking: { emotion: "calm" },
  tts_converting: { emotion: "calm" },
  speaking: { emotion: "joy", motionGroup: "Talk" },
  safety_blocked: { emotion: "calm" },
  offline_fallback: { emotion: "neutral" },
  network_error: { emotion: "sadness" },
};

/** 该状态对应的表情语义 + 动作组 */
export function expressionForState(state: PetState): StateExpression {
  return STATE_EXPRESSION[state];
}

/**
 * 用模型 emotionMap 把表情语义标签解析为 expression 索引。
 * 查不到该标签时回退 defaultExpression（默认 0）。
 */
export function resolveExpressionIndex(
  emotion: string,
  emotionMap: Record<string, number>,
  defaultExpression = 0,
): number {
  const idx = emotionMap[emotion];
  return typeof idx === "number" ? idx : defaultExpression;
}
