/**
 * 分类提示词单一真源：口诀覆盖树中全部大类、可选目录动态渲染。
 */
import { describe, expect, it } from "vitest";
import { buildTaxonomyGuide, buildTopicTreeLines } from "./wiki-taxonomy-prompt.js";
import { DEFAULT_TOPIC_TREE, PARKING_CATEGORY, type WikiTopicTree } from "./wiki-topic-tree.js";

describe("buildTopicTreeLines", () => {
  it("每个大类一行，小类顿号分隔", () => {
    const lines = buildTopicTreeLines({
      version: 2,
      categories: [
        { name: "工作", subtopics: ["项目", "例行"] },
        { name: "学习", subtopics: ["在学"] },
      ],
    });
    expect(lines).toBe(
      "- 工作：项目（某个有起止的具体项目，不是周期汇报）、例行（按周/月反复产出）\n- 学习：在学（当前正在推进的主线）",
    );
  });

  it("用户自建大类同样被渲染进可选目录", () => {
    const lines = buildTopicTreeLines({
      version: 2,
      categories: [{ name: "外部协作", subtopics: ["客户往来"] }],
    });
    expect(lines).toContain("外部协作：客户往来");
  });
});

describe("buildTaxonomyGuide", () => {
  it("口诀覆盖 v2 默认树的全部大类名", () => {
    const guide = buildTaxonomyGuide(DEFAULT_TOPIC_TREE);
    for (const cat of DEFAULT_TOPIC_TREE.categories) {
      expect(guide, `口诀或可选目录应提到大类「${cat.name}」`).toContain(cat.name);
    }
  });

  it("含口诀、易混、可选目录、规则四段", () => {
    const guide = buildTaxonomyGuide(DEFAULT_TOPIC_TREE);
    expect(guide).toContain("## 口诀");
    expect(guide).toContain("## 易混");
    expect(guide).toContain("## 可选目录");
    expect(guide).toContain("## 规则");
  });

  it("明确告知小类可留空——这是「小类可选」在提示词侧的对应物", () => {
    const guide = buildTaxonomyGuide(DEFAULT_TOPIC_TREE);
    expect(guide).toContain("大类必填，小类可以留空");
    expect(guide).toContain("不要为了填满而硬猜");
  });

  it("禁止 AI 写临时存放", () => {
    const guide = buildTaxonomyGuide(DEFAULT_TOPIC_TREE);
    expect(guide).toContain(`${PARKING_CATEGORY}仅用户可写，AI 不得选用`);
  });

  it("可选目录随传入的树变化，不写死 v2 默认树", () => {
    const custom: WikiTopicTree = {
      version: 2,
      categories: [{ name: "自定义大类", subtopics: ["自定义小类"] }],
    };
    const guide = buildTaxonomyGuide(custom);
    expect(guide).toContain("- 自定义大类：自定义小类");
  });

  it("易混规则只处理跨大类歧义，不替模型指定小类", () => {
    const guide = buildTaxonomyGuide(DEFAULT_TOPIC_TREE);
    const confusion = guide.split("## 易混")[1]!.split("## 可选目录")[0]!;
    const rules = confusion.split("\n").filter((l) => l.startsWith("- "));
    expect(rules).toHaveLength(6);
    // 每条易混的落点都是大类，不出现「大类/小类」这种替模型定小类的写法
    for (const rule of rules) {
      expect(rule, `易混规则不应指定小类：${rule}`).not.toMatch(/→\s*\S+\s*\/\s*\S+/);
    }
  });
});
