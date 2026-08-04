import { describe, it, expect } from "vitest";
import {
  extractEmotionTags,
  extractMotionTags,
  stripVirtualHumanTags,
  mapEmotionsToIndices,
} from "./emotion-tag-parser.js";

// 用例平移自 apps/windows/src/shared/virtual-human.test.ts，保证跨端等价。

describe("extractEmotionTags", () => {
  it("提取多个表情并返回清洁文本", () => {
    const { cleanText, emotions } = extractEmotionTags("[joy]你好[neutral]在吗");
    expect(cleanText).toBe("你好在吗");
    expect(emotions).toEqual(["joy", "neutral"]);
  });

  it("无标签时原样返回，表情为空", () => {
    const { cleanText, emotions } = extractEmotionTags("普通文本");
    expect(cleanText).toBe("普通文本");
    expect(emotions).toEqual([]);
  });

  it("支持中文表情名", () => {
    const { emotions } = extractEmotionTags("[开心]哈哈");
    expect(emotions).toEqual(["开心"]);
  });
});

describe("stripVirtualHumanTags", () => {
  it("剥离表情标签", () => {
    expect(stripVirtualHumanTags("[joy]你好呀")).toBe("你好呀");
  });

  it("剥离 vh_action 动作块", () => {
    expect(stripVirtualHumanTags("<vh_action>*点头*</vh_action>好的")).toBe("好的");
  });

  it("剥离未闭合 vh_action 残段", () => {
    expect(stripVirtualHumanTags("好的<vh_action>*微微")).toBe("好的");
  });

  it("混合标签全部剥离", () => {
    expect(stripVirtualHumanTags("[joy]开心<vh_action>*笑*</vh_action>！")).toBe("开心！");
  });

  it("剥离 motion 标签", () => {
    expect(stripVirtualHumanTags("[motion:wave]你好[motion:1]呀")).toBe("你好呀");
  });
});

describe("extractMotionTags", () => {
  it("提取多个动作 tag", () => {
    expect(extractMotionTags("[motion:wave]嗨[motion:2]哈")).toEqual(["wave", "2"]);
  });

  it("纯表情标签不算动作", () => {
    expect(extractMotionTags("[joy]纯表情")).toEqual([]);
  });
});

describe("mapEmotionsToIndices", () => {
  it("映射到索引并过滤未知标签", () => {
    expect(mapEmotionsToIndices(["joy", "unknown", "sad"], { joy: 1, sad: 3 })).toEqual([1, 3]);
  });

  it("空 emotionMap 全过滤", () => {
    expect(mapEmotionsToIndices(["joy"], {})).toEqual([]);
  });
});
