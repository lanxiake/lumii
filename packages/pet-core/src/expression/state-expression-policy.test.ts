import { describe, it, expect } from "vitest";
import {
  expressionForState,
  resolveExpressionIndex,
} from "./state-expression-policy.js";
import type { PetState } from "../state/petStateMachine.js";

const ALL_STATES: PetState[] = [
  "idle",
  "listening",
  "recognizing",
  "thinking",
  "tts_converting",
  "speaking",
  "safety_blocked",
  "offline_fallback",
  "network_error",
];

describe("expressionForState", () => {
  it("覆盖全部 9 态且 emotion 非空", () => {
    for (const s of ALL_STATES) {
      expect(expressionForState(s).emotion).toBeTruthy();
    }
  });

  it("speaking 张嘴说话：joy + Talk 动作", () => {
    expect(expressionForState("speaking")).toEqual({ emotion: "joy", motionGroup: "Talk" });
  });

  it("network_error 用 sadness 表情且无动作组", () => {
    const e = expressionForState("network_error");
    expect(e.emotion).toBe("sadness");
    expect(e.motionGroup).toBeUndefined();
  });

  it("idle 待机播 Idle 动作组", () => {
    expect(expressionForState("idle").motionGroup).toBe("Idle");
  });
});

describe("resolveExpressionIndex", () => {
  const emotionMap = { neutral: 0, joy: 3, sadness: 4, calm: 2 };

  it("命中语义标签返回对应索引", () => {
    expect(resolveExpressionIndex("joy", emotionMap)).toBe(3);
    expect(resolveExpressionIndex("sadness", emotionMap)).toBe(4);
  });

  it("未命中回退 defaultExpression（默认 0）", () => {
    expect(resolveExpressionIndex("unknown", emotionMap)).toBe(0);
    expect(resolveExpressionIndex("unknown", emotionMap, 9)).toBe(9);
  });

  it("空 emotionMap 全回退默认", () => {
    expect(resolveExpressionIndex("joy", {}, 1)).toBe(1);
  });
});
