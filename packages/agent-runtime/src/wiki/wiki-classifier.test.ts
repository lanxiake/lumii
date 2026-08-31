/**
 * WikiClassifier 单测：纯函数，不碰数据库。
 * 核心不变量——分类必须落在当前主题树内；拿不准/越权/漏答统一 degraded，条目留待整理。
 */
import { describe, expect, it } from "vitest";
import { buildClassifyPrompt, classifyBatch, parseClassifyResponse } from "./wiki-classifier.js";
import type { WikiInboxItem } from "./types.js";
import { LEGACY_TOPIC_TREE_V1 } from "./wiki-topic-tree.js";

function makeItem(id: string, overrides: Partial<WikiInboxItem> = {}): WikiInboxItem {
  return {
    id,
    agent_id: "ag",
    user_id: "u",
    item_type: "upload",
    source_path: `/tmp/${id}.txt`,
    source_url: null,
    title: `${id} 标题`,
    content_preview: `${id} 正文预览`,
    media_type: "document",
    status: "pending",
    attempt_count: 0,
    last_error: null,
    organized_source_id: null,
    content_hash: `hash-${id}`,
    created_at: "2026-08-25T00:00:00.000Z",
    organized_at: null,
    ...overrides,
  };
}

describe("buildClassifyPrompt", () => {
  it("包含每条条目的 id、标题与内容预览，并渲染当前主题树", () => {
    const prompt = buildClassifyPrompt([makeItem("i1"), makeItem("i2")], LEGACY_TOPIC_TREE_V1);
    expect(prompt).toContain("[id=i1]");
    expect(prompt).toContain("[id=i2]");
    expect(prompt).toContain("i1 正文预览");
    expect(prompt).toContain("做事记录");
    expect(prompt).toContain("口诀");
    expect(prompt).toContain("项目/任务资料");
  });

  it("不包含旧模型的 sources/ 顶层分类；临时存放只作为禁止项出现", () => {
    const prompt = buildClassifyPrompt([makeItem("i1")], LEGACY_TOPIC_TREE_V1);
    expect(prompt).not.toContain("sources/");
    // v1.1：改为显式告知 AI 不得选用，而不是绝口不提——后者模型仍会偶尔自造该值
    expect(prompt).toContain("临时存放仅用户可写，AI 不得选用");
  });

  it("截断超长内容预览，避免单批提示词膨胀", () => {
    const long = "字".repeat(1000);
    const prompt = buildClassifyPrompt([makeItem("i1", { content_preview: long })], LEGACY_TOPIC_TREE_V1);
    expect(prompt).not.toContain("字".repeat(501));
  });

  it("含文件夹导入上下文时写入目录树与占用信息", () => {
    const prompt = buildClassifyPrompt([makeItem("i1")], LEGACY_TOPIC_TREE_V1, {
      importRoot: "outputs/demo",
      directoryTree: "demo/\n  readme.md",
      topicOccupancy: "（尚无已分类文件）",
      navSectionGuide: "- 工作 → 做事记录",
      batchHint: "同批 3 个文件",
    });
    expect(prompt).toContain("outputs/demo");
    expect(prompt).toContain("readme.md");
    expect(prompt).toContain("源路径:");
  });
});

describe("parseClassifyResponse", () => {
  it("解析合法 category/subtopic 并写入这两列", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", category: "学习资料", subtopic: "课堂&课程笔记", skip: false }]),
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res).toEqual([{ inboxId: "i1", category: "学习资料", subtopic: "课堂&课程笔记" }]);
  });

  it("容忍代码围栏与前后说明文字", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      '好的，结果如下：\n```json\n[{"id":"i1","category":"做事记录","subtopic":"会议聊天记录"}]\n```\n以上。',
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.category).toBe("做事记录");
    expect(res[0]!.subtopic).toBe("会议聊天记录");
  });

  it("skip:true 映射为 degraded，category/subtopic 为 null", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", category: null, subtopic: null, skip: true, reason: "像聊天记录" }]),
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res).toEqual([
      {
        inboxId: "i1",
        category: null,
        subtopic: null,
        skip: true,
        reason: "像聊天记录",
        degraded: true,
        degradeReason: "像聊天记录",
      },
    ]);
  });

  it("空 category/subtopic（未 skip）映射为 degraded", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", category: "", subtopic: "", skip: false }]),
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.degraded).toBe(true);
    expect(res[0]!.category).toBeNull();
    expect(res[0]!.subtopic).toBeNull();
  });

  it("自造小类（不在树内）判定为 degraded", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", category: "学习资料", subtopic: "深度学习", skip: false }]),
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.degraded).toBe(true);
    expect(res[0]!.category).toBeNull();
    expect(res[0]!.subtopic).toBeNull();
    expect(res[0]!.degradeReason).toContain("深度学习");
  });

  it("自造大类（不在树内）判定为 degraded", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", category: "工作生活", subtopic: "x", skip: false }]),
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.degraded).toBe(true);
  });

  it("写「临时存放」时判定为 degraded（AI 不可写）", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", category: "临时存放", subtopic: null, skip: false }]),
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.degraded).toBe(true);
    expect(res[0]!.category).toBeNull();
  });

  it("模型漏答的条目标记为 degraded 并说明原因", () => {
    const items = [makeItem("i1"), makeItem("i2")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", category: "做事记录", subtopic: "会议聊天记录", skip: false }]),
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res).toHaveLength(2);
    const missing = res.find((r) => r.inboxId === "i2")!;
    expect(missing.degraded).toBe(true);
    expect(missing.category).toBeNull();
    expect(missing.degradeReason).toContain("未返回");
  });

  it("模型臆造的未知 id 被忽略，不产生野记录", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([
        { id: "i1", category: "做事记录", subtopic: "会议聊天记录", skip: false },
        { id: "ghost", category: "做事记录", subtopic: "会议聊天记录", skip: false },
      ]),
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res).toHaveLength(1);
    expect(res[0]!.inboxId).toBe("i1");
  });

  it("JSON 解析失败时整批 degraded，不丢任何条目", () => {
    const items = [makeItem("i1"), makeItem("i2")];
    for (const bad of ["完全不是 JSON", "[{坏的", "", "{}"]) {
      const res = parseClassifyResponse(bad, items, LEGACY_TOPIC_TREE_V1);
      expect(res).toHaveLength(2);
      expect(res.every((r) => r.degraded === true)).toBe(true);
      expect(res.every((r) => r.category === null)).toBe(true);
      expect(res[0]!.degradeReason).toBeTruthy();
    }
  });

  it("单条批次的裸对象响应被正常解析（不再整批降级）", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      '{"id":"i1","category":"做事记录","subtopic":"会议聊天记录","skip":false}',
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res).toHaveLength(1);
    expect(res[0]!.category).toBe("做事记录");
    expect(res[0]!.degraded).toBeUndefined();
  });

  it("围栏包裹的裸对象同样被解析", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      '```json\n{"id":"i1","category":"做事记录","subtopic":"会议聊天记录","skip":false}\n```',
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.category).toBe("做事记录");
  });

  it("思考块内的方括号不影响 JSON 边界识别", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      '<think>先看 items[0] 再定 [落点]</think>\n[{"id":"i1","category":"做事记录","subtopic":"会议聊天记录","skip":false}]',
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.category).toBe("做事记录");
  });

  it("只有闭合 think 标签（流式截断）时仍能解析", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      '判断依据见 [上文]\n</think>\n[{"id":"i1","category":"做事记录","subtopic":"会议聊天记录","skip":false}]',
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.category).toBe("做事记录");
  });

  it("前置散文含方括号时不再把切片带偏", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      '好的 [见下]：\n[{"id":"i1","category":"做事记录","subtopic":"会议聊天记录","skip":false}]',
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.category).toBe("做事记录");
  });

  it("正文字符串内含括号与转义引号时边界仍正确", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      '[{"id":"i1","category":"做事记录","subtopic":"会议聊天记录","skip":false,"reason":"带\\"引号\\"与 } 符号"}]',
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.category).toBe("做事记录");
  });

  it("字段类型错误时判定为 degraded 而非崩溃", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", category: 42, subtopic: null, skip: false }]),
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res[0]!.degraded).toBe(true);
    expect(res[0]!.category).toBeNull();
  });

  it("缺失 inboxId（未在 items 中）的响应条目被忽略", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([{ category: "做事记录", subtopic: "会议聊天记录", skip: false }]),
      items,
      LEGACY_TOPIC_TREE_V1,
    );
    // 该条无 id 被忽略，i1 本身漏答判 degraded
    expect(res).toHaveLength(1);
    expect(res[0]!.inboxId).toBe("i1");
    expect(res[0]!.degraded).toBe(true);
  });
});

describe("classifyBatch", () => {
  it("空批不调用 LLM", async () => {
    let called = false;
    const res = await classifyBatch(
      [],
      async () => {
        called = true;
        return "[]";
      },
      LEGACY_TOPIC_TREE_V1,
    );
    expect(res).toEqual([]);
    expect(called).toBe(false);
  });

  it("LLM 抛错时向上抛出，由调用方记 attempt_count 退避重试", async () => {
    await expect(
      classifyBatch(
        [makeItem("i1")],
        async () => {
          throw new Error("网络失败");
        },
        LEGACY_TOPIC_TREE_V1,
      ),
    ).rejects.toThrow();
  });

  it("传入的 topicTree 会被渲染进提示词", async () => {
    let seenPrompt = "";
    await classifyBatch(
      [makeItem("i1")],
      async (prompt) => {
        seenPrompt = prompt;
        return JSON.stringify([{ id: "i1", category: "做事记录", subtopic: "会议聊天记录", skip: false }]);
      },
      LEGACY_TOPIC_TREE_V1,
    );
    expect(seenPrompt).toContain("做事记录");
  });
});
