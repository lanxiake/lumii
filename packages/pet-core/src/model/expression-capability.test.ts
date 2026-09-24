import { describe, it, expect } from "vitest";
import {
  LAYER_MIN_INDICES,
  RICH_MIN_INDICES,
  countDistinctExpressions,
  expressionCapability,
  needsAmplitudeCompensation,
} from "./expression-capability.js";

/**
 * 真实模型的 emotionMap 形状（取自 `~/.lumii/pet-models/registry.json` 实测，
 * 只保留判定关心的部分）。**故意用真实数据当夹具**——这套判据的全部意义
 * 就是"在真实注册表上分对档"，用编出来的表测等于没测。
 */
const REAL_MAPS: Array<[string, Record<string, number>, ReturnType<typeof expressionCapability>]> = [
  // 12 个索引
  ["mao_pro", { neutral: 0, smile: 1, calm: 2, joy: 3, sadness: 4, shy: 5, fear: 6, anger: 7, smug: 8, tired: 9, shocked: 10, tsundere: 11 }, "rich"],
  // 9 个索引
  ["ug_official", { neutral: 0, mic: 1, clever: 2, oao: 3, sadness: 4, igari: 5, keyboard: 6, anger: 7, plus: 8 }, "rich"],
  // 4 个索引（睁眼/闭眼/笑眼/垂眼）
  ["demo_anime_girl", { neutral: 0, exp_01: 0, calm: 1, exp_02: 1, joy: 2, sadness: 3, exp_04: 3 }, "rich"],
  // ⚠ 1 个索引 —— 14 个键全指向 0，**按键数判会误判成"表情丰富"**
  [
    "xiaomai",
    { neutral: 0, 平静: 0, 默认: 0, f00: 0, smile: 0, 微笑: 0, joy: 0, 开心: 0, calm: 0, shy: 0, 害羞: 0, sadness: 0, 难过: 0, anger: 0, 生气: 0 },
    "none",
  ],
  // 3 个键、1 张脸
  ["demo_mecha_gundam", { neutral: 0, 平静: 0, 默认: 0 }, "none"],
  // 空表
  ["demo_cartoon_cat", {}, "none"],
];

describe("expressionCapability — 按真实注册表分档", () => {
  for (const [name, map, expected] of REAL_MAPS) {
    it(`${name} → ${expected}`, () => {
      expect(expressionCapability(map)).toBe(expected);
    });
  }

  it("xiaomai 是这条判据的关键反例：键多但只有一个索引", () => {
    const map = REAL_MAPS.find(([n]) => n === "xiaomai")![1];
    expect(Object.keys(map).length).toBeGreaterThan(RICH_MIN_INDICES);
    expect(countDistinctExpressions(map)).toBe(1);
    expect(expressionCapability(map)).toBe("none");
  });

  it("可以表达 ≥ LAYER_MIN_INDICES 个不同索引才算有表情层", () => {
    expect(expressionCapability({ a: 0, b: 1 })).toBe("basic");
    expect(expressionCapability({ a: 0, b: 0 })).toBe("none");
  });

  it("缺省 / null 视为没有表情层（不抛错）", () => {
    expect(expressionCapability(undefined)).toBe("none");
    expect(expressionCapability(null)).toBe("none");
    expect(countDistinctExpressions(undefined)).toBe(0);
  });

  it("非有限数的映射不计入（无效声明不该撑起一档能力）", () => {
    expect(countDistinctExpressions({ a: 0, b: NaN, c: Infinity })).toBe(1);
  });
});

describe("needsAmplitudeCompensation", () => {
  it("只有 none 档需要补偿；基本档靠自身表情层", () => {
    expect(needsAmplitudeCompensation({})).toBe(true);
    expect(needsAmplitudeCompensation({ neutral: 0 })).toBe(true);
    expect(needsAmplitudeCompensation({ a: 0, b: 1 })).toBe(false);
  });
});
