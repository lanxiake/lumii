/**
 * WikiClassifier 单测：纯函数，不碰数据库。
 * 核心不变量——任何异常路径都降级到 inbox/，条目永不丢失。
 */
import { describe, expect, it } from "vitest";
import { buildClassifyPrompt, classifyBatch, parseClassifyResponse } from "./wiki-classifier.js";
import type { WikiInboxItem } from "./types.js";

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
  it("包含每条条目的 id、标题与内容预览，并声明允许的分类", () => {
    const prompt = buildClassifyPrompt([makeItem("i1"), makeItem("i2")]);
    expect(prompt).toContain("[id=i1]");
    expect(prompt).toContain("[id=i2]");
    expect(prompt).toContain("i1 正文预览");
    expect(prompt).toContain("sources/");
    expect(prompt).toContain("media/");
    expect(prompt).toContain("inbox/");
  });

  it("截断超长内容预览，避免单批提示词膨胀", () => {
    const long = "字".repeat(1000);
    const prompt = buildClassifyPrompt([makeItem("i1", { content_preview: long })]);
    expect(prompt).not.toContain("字".repeat(301));
  });
});

describe("parseClassifyResponse", () => {
  it("解析合法结果并原样保留 path/title/summaryMd", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", path: "sources/arch-doc", title: "架构文档", summaryMd: "摘要" }]),
      items,
    );
    expect(res).toEqual([
      { inboxId: "i1", path: "sources/arch-doc", title: "架构文档", summaryMd: "摘要" },
    ]);
  });

  it("容忍代码围栏与前后说明文字", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      '好的，结果如下：\n```json\n[{"id":"i1","path":"media/pic","title":"图","summaryMd":"s"}]\n```\n以上。',
      items,
    );
    expect(res[0]!.path).toBe("media/pic");
  });

  it("越权顶层分类（P1/P2 分类）降级到 inbox/<id>", () => {
    const items = [makeItem("i1"), makeItem("i2")];
    const res = parseClassifyResponse(
      JSON.stringify([
        { id: "i1", path: "concepts/foo", title: "t1", summaryMd: "s1" },
        { id: "i2", path: "syntheses/bar", title: "t2", summaryMd: "s2" },
      ]),
      items,
    );
    expect(res.map((r) => r.path)).toEqual(["inbox/i1", "inbox/i2"]);
    // 降级只改落点，标题与摘要仍保留模型产出
    expect(res[0]!.title).toBe("t1");
    expect(res[0]!.summaryMd).toBe("s1");
  });

  it("非法路径（.. / 绝对路径 / 反斜杠 / 空段 / 臆造分类）降级到 inbox/<id>", () => {
    const items = ["a", "b", "c", "d", "e"].map((id) => makeItem(id));
    const res = parseClassifyResponse(
      JSON.stringify([
        { id: "a", path: "sources/../etc", title: "t", summaryMd: "s" },
        { id: "b", path: "/sources/x", title: "t", summaryMd: "s" },
        { id: "c", path: "sources\\x", title: "t", summaryMd: "s" },
        { id: "d", path: "sources//x", title: "t", summaryMd: "s" },
        { id: "e", path: "notallowed/x", title: "t", summaryMd: "s" },
      ]),
      items,
    );
    expect(res.map((r) => r.path)).toEqual(["inbox/a", "inbox/b", "inbox/c", "inbox/d", "inbox/e"]);
  });

  it("模型漏答的条目补齐为 inbox/<id>，用原标题与预览兜底", () => {
    const items = [makeItem("i1"), makeItem("i2")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", path: "sources/ok", title: "t1", summaryMd: "s1" }]),
      items,
    );
    expect(res).toHaveLength(2);
    const missing = res.find((r) => r.inboxId === "i2")!;
    expect(missing.path).toBe("inbox/i2");
    expect(missing.title).toBe("i2 标题");
    expect(missing.summaryMd).toBe("i2 正文预览");
  });

  it("模型臆造的未知 id 被忽略，不产生野记录", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([
        { id: "i1", path: "sources/ok", title: "t", summaryMd: "s" },
        { id: "ghost", path: "sources/ghost", title: "t", summaryMd: "s" },
      ]),
      items,
    );
    expect(res).toHaveLength(1);
    expect(res[0]!.inboxId).toBe("i1");
  });

  it("JSON 解析失败时整批降级，不丢任何条目", () => {
    const items = [makeItem("i1"), makeItem("i2")];
    for (const bad of ["完全不是 JSON", "[{坏的", "", "{}"]) {
      const res = parseClassifyResponse(bad, items);
      expect(res).toHaveLength(2);
      expect(res.map((r) => r.path)).toEqual(["inbox/i1", "inbox/i2"]);
    }
  });

  it("字段类型错误时用原条目兜底而非丢弃", () => {
    const items = [makeItem("i1")];
    const res = parseClassifyResponse(
      JSON.stringify([{ id: "i1", path: 42, title: null, summaryMd: [] }]),
      items,
    );
    expect(res[0]!.path).toBe("inbox/i1");
    expect(res[0]!.title).toBe("i1 标题");
    expect(res[0]!.summaryMd).toBe("i1 正文预览");
  });
});

describe("classifyBatch", () => {
  it("空批不调用 LLM", async () => {
    let called = false;
    const res = await classifyBatch([], async () => {
      called = true;
      return "[]";
    });
    expect(res).toEqual([]);
    expect(called).toBe(false);
  });

  it("LLM 抛错时向上抛出，由调用方记 attempt_count 退避重试", async () => {
    await expect(
      classifyBatch([makeItem("i1")], async () => {
        throw new Error("网络失败");
      }),
    ).rejects.toThrow();
  });
});
