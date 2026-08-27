/**
 * 用途主题树：默认树形态、校验规则、孤儿检测。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOPIC_TREE,
  PARKING_CATEGORY,
  parseTopicTree,
  treeHasOrphans,
  validateTopicAssignment,
  validateTopicTree,
} from "./wiki-topic-tree.js";

describe("DEFAULT_TOPIC_TREE", () => {
  it("默认树含 6 个大类且不含临时存放", () => {
    expect(DEFAULT_TOPIC_TREE.categories).toHaveLength(6);
    expect(DEFAULT_TOPIC_TREE.categories.map((c) => c.name)).not.toContain(PARKING_CATEGORY);
  });
});

describe("validateTopicTree", () => {
  it("拒绝把临时存放写进树", () => {
    expect(
      validateTopicTree({
        version: 1,
        categories: [{ name: PARKING_CATEGORY, subtopics: [] }],
      }),
    ).toBe(false);
  });

  it("接受合法默认树", () => {
    expect(validateTopicTree(DEFAULT_TOPIC_TREE)).toBe(true);
  });

  it("拒绝 version 不为 1", () => {
    expect(validateTopicTree({ version: 2, categories: [] })).toBe(false);
  });

  it("拒绝空大类列表", () => {
    expect(validateTopicTree({ version: 1, categories: [] })).toBe(false);
  });

  it("拒绝重复大类名", () => {
    expect(
      validateTopicTree({
        version: 1,
        categories: [
          { name: "做事记录", subtopics: ["a"] },
          { name: "做事记录", subtopics: ["b"] },
        ],
      }),
    ).toBe(false);
  });

  it("拒绝同一大类内重复小类名", () => {
    expect(
      validateTopicTree({
        version: 1,
        categories: [{ name: "做事记录", subtopics: ["a", "a"] }],
      }),
    ).toBe(false);
  });

  it("允许小类名含斜杠和 &", () => {
    expect(
      validateTopicTree({
        version: 1,
        categories: [{ name: "学习资料", subtopics: ["课堂&课程笔记", "项目/任务资料"] }],
      }),
    ).toBe(true);
  });
});

describe("validateTopicAssignment", () => {
  it("允许小类名含斜杠", () => {
    expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, "做事记录", "项目/任务资料")).toEqual({ ok: true });
  });

  it("parking 只能 category=临时存放 且 subtopic=null", () => {
    expect(
      validateTopicAssignment(DEFAULT_TOPIC_TREE, PARKING_CATEGORY, null, { allowParking: true }),
    ).toEqual({ ok: true });
    expect(
      validateTopicAssignment(DEFAULT_TOPIC_TREE, PARKING_CATEGORY, "x", { allowParking: true }).ok,
    ).toBe(false);
  });

  it("不允许 allowParking 时把 category 设为临时存放", () => {
    expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, PARKING_CATEGORY, null).ok).toBe(false);
  });

  it("拒绝不存在的大类", () => {
    expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, "不存在的大类", "x").ok).toBe(false);
  });

  it("拒绝不存在的小类", () => {
    expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, "做事记录", "不存在的小类").ok).toBe(false);
  });

  it("拒绝 subtopic 为 null 的正式节点", () => {
    expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, "做事记录", null).ok).toBe(false);
  });
});

describe("treeHasOrphans", () => {
  it("occupied 组合全部在树内时无孤儿", () => {
    expect(
      treeHasOrphans(DEFAULT_TOPIC_TREE, [{ category: "做事记录", subtopic: "会议聊天记录" }]),
    ).toBe(false);
  });

  it("occupied 组合不在树内时判为孤儿", () => {
    expect(
      treeHasOrphans(DEFAULT_TOPIC_TREE, [{ category: "做事记录", subtopic: "已删除的小类" }]),
    ).toBe(true);
  });
});

describe("parseTopicTree", () => {
  it("null 输入返回 null", () => {
    expect(parseTopicTree(null)).toBeNull();
  });

  it("非法 JSON 返回 null", () => {
    expect(parseTopicTree("{not json")).toBeNull();
  });

  it("合法 JSON 解析为树", () => {
    expect(parseTopicTree(JSON.stringify(DEFAULT_TOPIC_TREE))).toEqual(DEFAULT_TOPIC_TREE);
  });

  it("结构非法的 JSON 返回 null", () => {
    expect(parseTopicTree(JSON.stringify({ version: 1, categories: [{ name: PARKING_CATEGORY, subtopics: [] }] }))).toBeNull();
  });
});
