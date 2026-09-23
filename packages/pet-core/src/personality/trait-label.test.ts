import { describe, it, expect } from "vitest";
import {
  NEUTRAL_TRAIT_LABEL,
  TRAIT_LABEL_THRESHOLD,
  traitLabel,
  type TraitValues,
} from "./trait-label.js";

/** 全中性底子，按需覆盖要突出的维度 */
const flat = (over: Partial<TraitValues> = {}): TraitValues => ({
  openness: 0.5,
  conscientiousness: 0.5,
  extraversion: 0.5,
  agreeableness: 0.5,
  neuroticism: 0.5,
  ...over,
});

describe("traitLabel — 两维合成一句话", () => {
  it("设计 §3.6 的两个示例", () => {
    expect(traitLabel(flat({ openness: 0.8, extraversion: 0.2 }))).toBe("好奇心重，但有点怕生");
    expect(traitLabel(flat({ conscientiousness: 0.8, neuroticism: 0.2 }))).toBe(
      "做事靠谱，但不太会慌",
    );
  });

  it("同向的两维用「，」顺接，不用转折", () => {
    expect(traitLabel(flat({ openness: 0.8, extraversion: 0.8 }))).toBe("好奇心重，很黏人");
  });

  it("五维都不够偏离 → 中性文案", () => {
    expect(traitLabel(flat())).toBe(NEUTRAL_TRAIT_LABEL);
    expect(traitLabel(flat({ openness: 0.5 + TRAIT_LABEL_THRESHOLD - 1e-6 }))).toBe(
      NEUTRAL_TRAIT_LABEL,
    );
  });

  it("只有一维显著 → 只说那一维", () => {
    expect(traitLabel(flat({ neuroticism: 0.8 }))).toBe("心思敏感");
  });

  it("只取最突出的两维，第三维丢掉", () => {
    const label = traitLabel(
      flat({ openness: 0.9, extraversion: 0.8, agreeableness: 0.7 }),
    );
    expect(label).toBe("好奇心重，很黏人");
  });

  it("低值方向也生效（不是只看高值）", () => {
    expect(traitLabel(flat({ agreeableness: 0.15, conscientiousness: 0.25 }))).toBe(
      "有点小脾气，但比较随性",
    );
  });

  it("脏数据不炸也不乱进标签", () => {
    expect(traitLabel(flat({ openness: Number.NaN }))).toBe(NEUTRAL_TRAIT_LABEL);
  });
});
