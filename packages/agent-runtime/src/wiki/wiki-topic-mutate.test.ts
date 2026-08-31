/**
 * 主题树 mutation 纯函数规则测试
 * 计划：docs/plans/记忆重构/2026-08-27-wiki-topic-hierarchy-p2-implementation.md Task 1
 *
 * v1.1：不再依赖 DEFAULT_TOPIC_TREE 的具体内容（该树已改为 v2 的 4 大类，
 * 与本文件历史用例的六大类名不符）。这里的用例验证的是 planTopicMutation
 * 纯函数本身的通用规则，与真实默认树内容无关，改用独立 fixture 树。
 */

import { describe, expect, it } from "vitest";
import { PARKING_CATEGORY, type WikiTopicTree } from "./wiki-topic-tree.js";
import { planTopicMutation, topicCountKey } from "./wiki-topic-mutate.js";

/** 独立于 DEFAULT_TOPIC_TREE 的 fixture 树，六大类形态，仅供本文件用例复用 */
const T: WikiTopicTree = {
  version: 1,
  categories: [
    { name: "做事记录", subtopics: ["项目/任务资料", "会议聊天记录", "汇报总结文稿", "对外沟通材料", "数据统计报表"] },
    { name: "学习资料", subtopics: ["课堂&课程笔记"] },
  ],
};
const empty = new Map<string, number>();

describe("topicCountKey", () => {
  it("与 renderer 侧一致：JSON.stringify 两列数组", () => {
    expect(topicCountKey("做事记录")).toBe(JSON.stringify(["做事记录"]));
    expect(topicCountKey("做事记录", "项目/任务资料")).toBe(
      JSON.stringify(["做事记录", "项目/任务资料"]),
    );
    expect(topicCountKey("做事记录", null)).toBe(JSON.stringify(["做事记录"]));
  });

  it("含 / 与 & 的小类名不会与拼接串混淆", () => {
    expect(topicCountKey("学习资料", "课堂&课程笔记")).not.toContain("学习资料/课堂");
  });
});

describe("planTopicMutation - 大类", () => {
  it("addCategory 支持 index 插入且拒绝重名", () => {
    const r = planTopicMutation(T, { op: "addCategory", name: "外部协作", index: 1 }, empty);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tree.categories[1]!.name).toBe("外部协作");
    expect(planTopicMutation(T, { op: "addCategory", name: "学习资料" }, empty).ok).toBe(false);
  });

  it("拒绝把大类命名为临时存放", () => {
    expect(planTopicMutation(T, { op: "addCategory", name: PARKING_CATEGORY }, empty).ok).toBe(false);
  });

  it("addCategory 新大类自带一个默认小类，避免空大类", () => {
    const r = planTopicMutation(T, { op: "addCategory", name: "外部协作" }, empty);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const added = r.tree.categories.find((c) => c.name === "外部协作")!;
      expect(added.subtopics.length).toBeGreaterThan(0);
    }
  });

  it("renameCategory 级联该大类全部小类的文件", () => {
    const r = planTopicMutation(T, { op: "renameCategory", from: "做事记录", to: "工作产出" }, empty);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cascades).toContainEqual({
        from: { category: "做事记录", subtopic: "项目/任务资料" },
        to: { category: "工作产出", subtopic: "项目/任务资料" },
      });
    }
  });

  it("renameCategory 目标名已存在时拒绝", () => {
    expect(
      planTopicMutation(T, { op: "renameCategory", from: "做事记录", to: "学习资料" }, empty).ok,
    ).toBe(false);
  });

  it("reorderCategories 的 names 集合必须与现有大类相等", () => {
    const names = T.categories.map((c) => c.name);
    expect(planTopicMutation(T, { op: "reorderCategories", names: [...names].reverse() }, empty).ok).toBe(true);
    expect(planTopicMutation(T, { op: "reorderCategories", names: names.slice(1) }, empty).ok).toBe(false);
  });
});

describe("planTopicMutation - 删除与去向", () => {
  it("有文件的小类删除时缺 disposition 必须拒绝并回报条数", () => {
    const counts = new Map([[topicCountKey("做事记录", "会议聊天记录"), 3]]);
    const r = planTopicMutation(T, { op: "deleteSubtopic", category: "做事记录", name: "会议聊天记录" }, counts);
    expect(r).toMatchObject({ ok: false, needsDisposition: true, fileCount: 3 });
  });

  it("deleteSubtopic 带 parking disposition 时级联到临时存放", () => {
    const counts = new Map([[topicCountKey("做事记录", "会议聊天记录"), 3]]);
    const r = planTopicMutation(
      T,
      { op: "deleteSubtopic", category: "做事记录", name: "会议聊天记录", disposition: { type: "parking" } },
      counts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cascades[0]!.to).toEqual({ category: PARKING_CATEGORY, subtopic: null });
      expect(r.tree.categories[0]!.subtopics).not.toContain("会议聊天记录");
    }
  });

  it("无文件的小类可直接删除，不需要 disposition", () => {
    const r = planTopicMutation(T, { op: "deleteSubtopic", category: "做事记录", name: "会议聊天记录" }, empty);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cascades).toHaveLength(0);
  });

  it("大类只剩一个时不可删；小类只剩一个时不可删", () => {
    const one: WikiTopicTree = { version: 1, categories: [{ name: "唯一", subtopics: ["甲"] }] };
    expect(planTopicMutation(one, { op: "deleteCategory", name: "唯一" }, empty).ok).toBe(false);
    expect(planTopicMutation(one, { op: "deleteSubtopic", category: "唯一", name: "甲" }, empty).ok).toBe(false);
  });

  it("deleteCategory 汇总该大类下所有小类的文件数", () => {
    const counts = new Map([
      [topicCountKey("做事记录", "会议聊天记录"), 3],
      [topicCountKey("做事记录", "汇报总结文稿"), 2],
    ]);
    const r = planTopicMutation(T, { op: "deleteCategory", name: "做事记录" }, counts);
    expect(r).toMatchObject({ ok: false, needsDisposition: true, fileCount: 5 });
  });

  it("disposition 的 move 目标必须是新树里的合法节点", () => {
    const counts = new Map([[topicCountKey("做事记录", "会议聊天记录"), 1]]);
    const r = planTopicMutation(
      T,
      {
        op: "deleteSubtopic",
        category: "做事记录",
        name: "会议聊天记录",
        disposition: { type: "move", category: "做事记录", subtopic: "会议聊天记录" },
      },
      counts,
    );
    expect(r.ok).toBe(false); // 目标即被删节点
  });

  it("disposition 的 move 指向合法节点时级联过去", () => {
    const counts = new Map([[topicCountKey("做事记录", "会议聊天记录"), 1]]);
    const r = planTopicMutation(
      T,
      {
        op: "deleteSubtopic",
        category: "做事记录",
        name: "会议聊天记录",
        disposition: { type: "move", category: "做事记录", subtopic: "汇报总结文稿" },
      },
      counts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cascades[0]!.to).toEqual({ category: "做事记录", subtopic: "汇报总结文稿" });
    }
  });
});

describe("planTopicMutation - 小类增改移并", () => {
  it("addSubtopic 支持 index 且拒绝同大类内重名", () => {
    const r = planTopicMutation(
      T,
      { op: "addSubtopic", category: "做事记录", name: "客户往来函件", index: 0 },
      empty,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tree.categories[0]!.subtopics[0]).toBe("客户往来函件");
    expect(
      planTopicMutation(T, { op: "addSubtopic", category: "做事记录", name: "会议聊天记录" }, empty).ok,
    ).toBe(false);
  });

  it("renameSubtopic 只级联该节点", () => {
    const r = planTopicMutation(
      T,
      { op: "renameSubtopic", category: "做事记录", from: "会议聊天记录", to: "会议纪要" },
      empty,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cascades).toEqual([
        {
          from: { category: "做事记录", subtopic: "会议聊天记录" },
          to: { category: "做事记录", subtopic: "会议纪要" },
        },
      ]);
    }
  });

  it("moveSubtopic 只改大类，小类名不变；目标重名拒绝", () => {
    const r = planTopicMutation(
      T,
      { op: "moveSubtopic", fromCategory: "做事记录", name: "数据统计报表", toCategory: "学习资料" },
      empty,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cascades).toContainEqual({
        from: { category: "做事记录", subtopic: "数据统计报表" },
        to: { category: "学习资料", subtopic: "数据统计报表" },
      });
    }
    // 同名已存在于目标大类
    const dup = planTopicMutation(
      T,
      { op: "moveSubtopic", fromCategory: "做事记录", name: "数据统计报表", toCategory: "做事记录" },
      empty,
    );
    expect(dup.ok).toBe(false);
  });

  it("moveSubtopic 不得掏空来源大类", () => {
    const tree: WikiTopicTree = {
      version: 1,
      categories: [
        { name: "甲", subtopics: ["独苗"] },
        { name: "乙", subtopics: ["其它"] },
      ],
    };
    expect(
      planTopicMutation(tree, { op: "moveSubtopic", fromCategory: "甲", name: "独苗", toCategory: "乙" }, empty).ok,
    ).toBe(false);
  });

  it("mergeSubtopic 把 from 文件改成 to 并从树删除 from；同节点拒绝", () => {
    const r = planTopicMutation(
      T,
      {
        op: "mergeSubtopic",
        fromCategory: "做事记录",
        fromName: "汇报总结文稿",
        toCategory: "做事记录",
        toName: "对外沟通材料",
      },
      empty,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tree.categories[0]!.subtopics).not.toContain("汇报总结文稿");
      expect(r.cascades).toEqual([
        {
          from: { category: "做事记录", subtopic: "汇报总结文稿" },
          to: { category: "做事记录", subtopic: "对外沟通材料" },
        },
      ]);
    }
    expect(
      planTopicMutation(
        T,
        {
          op: "mergeSubtopic",
          fromCategory: "做事记录",
          fromName: "汇报总结文稿",
          toCategory: "做事记录",
          toName: "汇报总结文稿",
        },
        empty,
      ).ok,
    ).toBe(false);
  });

  it("mergeSubtopic 的 to 必须已存在", () => {
    expect(
      planTopicMutation(
        T,
        {
          op: "mergeSubtopic",
          fromCategory: "做事记录",
          fromName: "汇报总结文稿",
          toCategory: "做事记录",
          toName: "不存在的小类",
        },
        empty,
      ).ok,
    ).toBe(false);
  });
});
