import { describe, it, expect } from "vitest";
import {
  LAYER_MIN_INDICES,
  RICH_MIN_INDICES,
  countDistinctExpressions,
  expressionCapability,
  needsExpressivenessCompensation,
} from "./expression-capability.js";

/**
 * 真实模型的 emotionMap 形状（取自随包 `resources/pet-models/registry.json` 实测，
 * 只保留判定关心的部分）。**故意用真实数据当夹具**——这套判据的全部意义
 * 就是"在真实注册表上分对档"，用编出来的表测等于没测。
 *
 * ⚠ 2026-09-24：`demo_anime_girl`（4 索引）与 `demo_mecha_gundam`（3 键 1 脸）
 * 已随宠物实验线收口从随包注册表移除，两行一并删掉而不是留成"历史真实数据"——
 * 留着的表迟早会被当成"现在注册表里真有这两只"。
 * 它们原本承担的两条边界（**恰好 4 个索引 = rich**、**3 个键仍只有 1 张脸 = none**）
 * 改由下面显式的边界用例守住，覆盖没有丢。
 */
const REAL_MAPS: Array<[string, Record<string, number>, ReturnType<typeof expressionCapability>]> = [
  // 12 个索引
  ["mao_pro", { neutral: 0, smile: 1, calm: 2, joy: 3, sadness: 4, shy: 5, fear: 6, anger: 7, smug: 8, tired: 9, shocked: 10, tsundere: 11 }, "rich"],
  // 9 个索引
  ["ug_official", { neutral: 0, mic: 1, clever: 2, oao: 3, sadness: 4, igari: 5, keyboard: 6, anger: 7, plus: 8 }, "rich"],
  // ⚠ 1 个索引 —— 14 个键全指向 0，**按键数判会误判成"表情丰富"**
  [
    "xiaomai",
    { neutral: 0, 平静: 0, 默认: 0, f00: 0, smile: 0, 微笑: 0, joy: 0, 开心: 0, calm: 0, shy: 0, 害羞: 0, sadness: 0, 难过: 0, anger: 0, 生气: 0 },
    "none",
  ],
  // 3 个键、1 张脸（唯一的随包精灵图示范模型）
  ["demo_cartoon_cat", { neutral: 0, 平静: 0, 默认: 0 }, "none"],
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

  it("rich 的门槛是「恰好 RICH_MIN_INDICES 个不同索引」", () => {
    const n = (k: number) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`k${i}`, i]));
    expect(expressionCapability(n(RICH_MIN_INDICES - 1))).toBe("basic");
    expect(expressionCapability(n(RICH_MIN_INDICES))).toBe("rich");
    // 键数是声明量、索引数才是表现量：键再多，全指向同一个索引仍是 none
    expect(expressionCapability(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 0])))).toBe("none");
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

describe("needsExpressivenessCompensation", () => {
  it("只有 none 档需要补偿；基本档靠自身表情层", () => {
    expect(needsExpressivenessCompensation({})).toBe(true);
    expect(needsExpressivenessCompensation({ neutral: 0 })).toBe(true);
    expect(needsExpressivenessCompensation({ a: 0, b: 1 })).toBe(false);
  });
});
