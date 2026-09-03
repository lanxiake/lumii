/**
 * 用途主题树：默认树形态、校验规则、孤儿检测。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOPIC_TREE,
  PARKING_CATEGORY,
  mergeDefaultSubtopics,
  parseTopicTree,
  treeHasOrphans,
  validateTopicAssignment,
  validateTopicTree,
} from "./wiki-topic-tree.js";

describe("DEFAULT_TOPIC_TREE", () => {
  it("v2 默认树含 4 个大类且不含临时存放", () => {
    expect(DEFAULT_TOPIC_TREE.version).toBe(2);
    expect(DEFAULT_TOPIC_TREE.categories).toHaveLength(4);
    expect(DEFAULT_TOPIC_TREE.categories.map((c) => c.name)).toEqual(["工作", "学习", "生活", "收藏"]);
    expect(DEFAULT_TOPIC_TREE.categories.map((c) => c.name)).not.toContain(PARKING_CATEGORY);
  });

  it("每个大类至少 5 个预设小类", () => {
    for (const cat of DEFAULT_TOPIC_TREE.categories) {
      expect(cat.subtopics.length, `${cat.name} 预设小类不足 5 个`).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("mergeDefaultSubtopics", () => {
  it("给缺小类的默认大类追加预设，保留用户已有顺序与自建小类", () => {
    const merged = mergeDefaultSubtopics({
      version: 2,
      categories: [
        { name: "工作", subtopics: ["项目", "我的专项"] },
        { name: "自定义", subtopics: ["甲"] },
      ],
    });
    expect(merged.categories[0]!.subtopics[0]).toBe("项目");
    expect(merged.categories[0]!.subtopics).toContain("我的专项");
    // 追加项从默认树推导，避免每次调整分类边界都要改这条断言
    const workDefaults = DEFAULT_TOPIC_TREE.categories.find((c) => c.name === "工作")!.subtopics;
    expect(merged.categories[0]!.subtopics.slice(2)).toEqual(
      workDefaults.filter((s) => s !== "项目"),
    );
    expect(merged.categories[1]).toEqual({ name: "自定义", subtopics: ["甲"] });
  });

  it("已经齐全时返回同一引用，不改写", () => {
    expect(mergeDefaultSubtopics(DEFAULT_TOPIC_TREE)).toBe(DEFAULT_TOPIC_TREE);
  });
});

describe("validateTopicTree", () => {
  it("拒绝把临时存放写进树", () => {
    expect(
      validateTopicTree({
        version: 2,
        categories: [{ name: PARKING_CATEGORY, subtopics: [] }],
      }),
    ).toBe(false);
  });

  it("接受合法默认树", () => {
    expect(validateTopicTree(DEFAULT_TOPIC_TREE)).toBe(true);
  });

  it("version 为 1 或 2 均接受，其余拒绝", () => {
    expect(validateTopicTree({ version: 1, categories: [{ name: "工作", subtopics: ["项目"] }] })).toBe(true);
    expect(validateTopicTree({ version: 3, categories: [] })).toBe(false);
  });

  it("拒绝空大类列表", () => {
    expect(validateTopicTree({ version: 2, categories: [] })).toBe(false);
  });

  it("拒绝重复大类名", () => {
    expect(
      validateTopicTree({
        version: 2,
        categories: [
          { name: "工作", subtopics: ["a"] },
          { name: "工作", subtopics: ["b"] },
        ],
      }),
    ).toBe(false);
  });

  it("拒绝同一大类内重复小类名", () => {
    expect(
      validateTopicTree({
        version: 2,
        categories: [{ name: "工作", subtopics: ["a", "a"] }],
      }),
    ).toBe(false);
  });

  it("允许小类名含斜杠和 &", () => {
    expect(
      validateTopicTree({
        version: 2,
        categories: [{ name: "学习", subtopics: ["课堂&课程笔记", "项目/任务资料"] }],
      }),
    ).toBe(true);
  });
});

describe("validateTopicAssignment", () => {
  it("允许小类名含斜杠", () => {
    expect(
      validateTopicAssignment(
        { version: 2, categories: [{ name: "工作", subtopics: ["项目/任务资料"] }] },
        "工作",
        "项目/任务资料",
      ),
    ).toEqual({ ok: true });
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
    expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, "工作", "不存在的小类").ok).toBe(false);
  });

  it("小类可选（v1.1）：category 非空、subtopic 为 null 应通过", () => {
    expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, "工作", null).ok).toBe(true);
    expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, "学习", null).ok).toBe(true);
  });

  it("空字符串不等价于 null，仍按未知小类拒绝", () => {
    expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, "学习", "").ok).toBe(false);
  });

  it("小类非法：category 合法、subtopic 不属于该 category 应拒绝", () => {
    expect(validateTopicAssignment(DEFAULT_TOPIC_TREE, "工作", "在学").ok).toBe(false);
  });
});

describe("treeHasOrphans", () => {
  it("occupied 组合全部在树内时无孤儿", () => {
    expect(treeHasOrphans(DEFAULT_TOPIC_TREE, [{ category: "工作", subtopic: "项目" }])).toBe(false);
  });

  it("occupied 组合不在树内时判为孤儿", () => {
    expect(
      treeHasOrphans(DEFAULT_TOPIC_TREE, [{ category: "工作", subtopic: "已删除的小类" }]),
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
    expect(
      parseTopicTree(JSON.stringify({ version: 2, categories: [{ name: PARKING_CATEGORY, subtopics: [] }] })),
    ).toBeNull();
  });
});
