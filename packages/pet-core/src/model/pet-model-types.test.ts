import { describe, it, expect } from "vitest";
import {
  applyModelDefaults,
  PET_MODEL_DEFAULTS,
  PET_MOTION_GROUP_UNNAMED,
} from "./pet-model-types.js";

describe("applyModelDefaults", () => {
  it("补全缺失字段为默认值", () => {
    const cfg = applyModelDefaults({
      id: "mao_pro",
      name: "猫",
      rendererType: "live2d",
      modelUrl: "mao_pro/runtime/mao_pro.model3.json",
    });
    expect(cfg.scale).toBe(PET_MODEL_DEFAULTS.scale);
    expect(cfg.idleMotionGroup).toBe("Idle");
    expect(cfg.talkMotionGroup).toBe("Talk");
    expect(cfg.emotionMap).toEqual({});
    expect(cfg.tapMotions).toEqual({});
    expect(cfg.defaultExpression).toBe(0);
  });

  it("显式字段覆盖默认值", () => {
    const cfg = applyModelDefaults({
      id: "x",
      name: "x",
      rendererType: "live2d",
      modelUrl: "x.model3.json",
      scale: 0.8,
      emotionMap: { joy: 1, sadness: 2 },
    });
    expect(cfg.scale).toBe(0.8);
    expect(cfg.emotionMap).toEqual({ joy: 1, sadness: 2 });
  });

  it("emotionMap/tapMotions 传 undefined 时回落默认空对象（不被 undefined 覆盖）", () => {
    const cfg = applyModelDefaults({
      id: "x",
      name: "x",
      rendererType: "live2d",
      modelUrl: "x.model3.json",
      emotionMap: undefined,
      tapMotions: undefined,
    });
    expect(cfg.emotionMap).toEqual({});
    expect(cfg.tapMotions).toEqual({});
  });

  it("占位常量值稳定", () => {
    expect(PET_MOTION_GROUP_UNNAMED).toBe("$unnamed");
  });
});
