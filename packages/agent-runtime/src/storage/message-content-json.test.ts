/**
 * 对话正文提取（content_json → 人看得见的文本）
 *
 * 背景（2026-09-17，P2-3 宫殿自建时发现）：`loadSegmentText` 只判 `type === "text"`，
 * 而助手消息落库是 `assistant_parts`（parts 为唯一真相）。于是**助手说过的话全部被漏掉**，
 * 「段原文」归档与段落总结拿到的是一份只有用户发言的对话——真实库里多轮段的 5 条消息
 * 有 2 条被静默丢弃。
 *
 * 本用例守住：
 * 1. `assistant_parts` 的 text part 被取出，thinking / tool part 不被取出
 * 2. 扁平 `text`（用户消息与旧数据）照旧
 * 3. `loadSegmentText` 两种格式都能读，且保持 role 前缀与时间顺序
 */
import { describe, expect, it } from "vitest";
import { extractMessageText, parseMessageContentJson } from "./message-content-json.js";
import { ConversationRepo } from "./conversation-repo.js";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";

describe("extractMessageText", () => {
  it("扁平 text（用户消息与旧数据）", () => {
    expect(extractMessageText(JSON.stringify({ type: "text", text: "  你好  " }))).toBe("你好");
  });

  it("assistant_parts：只取 text part，跳过 thinking 与 tool", () => {
    const raw = JSON.stringify({
      type: "assistant_parts",
      parts: [
        { type: "thinking", id: "th-1", text: "先想想", status: "done" },
        { type: "text", id: "t-1", text: "第一段正文", status: "done" },
        {
          type: "tool",
          id: "tool-1",
          name: "bash",
          args: { cmd: "ls" },
          result: "文件列表",
          status: "done",
        },
        { type: "text", id: "t-2", text: "第二段正文", status: "done" },
      ],
    });
    expect(extractMessageText(raw)).toBe("第一段正文\n第二段正文");
    expect(extractMessageText(raw)).not.toContain("先想想");
    expect(extractMessageText(raw)).not.toContain("文件列表");
  });

  it("separator 可换（通知类场景要一行）", () => {
    const raw = JSON.stringify({
      type: "assistant_parts",
      parts: [
        { type: "text", id: "t-1", text: "甲", status: "done" },
        { type: "text", id: "t-2", text: "乙", status: "done" },
      ],
    });
    expect(extractMessageText(raw, " ")).toBe("甲 乙");
  });

  it("空 parts / tool_result / 非法 JSON 都返回空串，不抛异常", () => {
    expect(extractMessageText(JSON.stringify({ type: "assistant_parts", parts: [] }))).toBe("");
    expect(
      extractMessageText(
        JSON.stringify({ type: "tool_result", tool_use_id: "x", tool_name: "t", result: 1, is_error: false }),
      ),
    ).toBe("");
    expect(extractMessageText("{ 不是 JSON")).toBe("");
    expect(extractMessageText("")).toBe("");
  });

  it("纯 thinking 的一轮（模型只想了没说话）不产出正文", () => {
    const raw = JSON.stringify({
      type: "assistant_parts",
      parts: [{ type: "thinking", id: "th-1", text: "只想不说", status: "done" }],
    });
    expect(extractMessageText(raw)).toBe("");
  });
});

describe("loadSegmentText", () => {
  /** messages.conversation_id 有外键，先建会话行 */
  function makeRepo(conversationId: string) {
    const db = createMigratedTestDb();
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
       VALUES (?, 'u1', 'direct', 't', 1, ?)`,
    ).run(conversationId, new Date().toISOString());
    return new ConversationRepo(db);
  }

  it("助手回复不再被漏掉（此前只认扁平 text）", () => {
    const conv = "c1";
    const repo = makeRepo(conv);
    repo.saveMessage({
      id: "m1",
      conversationId: conv,
      role: "user",
      contentJson: { type: "text", text: "帮我看下这个报错" },
      timestamp: "2026-09-17T10:00:00.000Z",
    });
    repo.saveMessage({
      id: "m2",
      conversationId: conv,
      role: "assistant",
      contentJson: {
        type: "assistant_parts",
        parts: [
          { type: "thinking", id: "th-1", text: "这是连接池耗尽", status: "done" },
          { type: "text", id: "t-1", text: "是连接池耗尽，把 maxActive 调大即可。", status: "done" },
        ],
      },
      timestamp: "2026-09-17T10:00:01.000Z",
    });

    const text = repo.loadSegmentText(conv, "m1", "m2");

    expect(text).toContain("user: 帮我看下这个报错");
    expect(text).toContain("assistant: 是连接池耗尽，把 maxActive 调大即可。");
    expect(text).not.toContain("这是连接池耗尽");
    // 保持时间顺序
    expect(text.indexOf("user:")).toBeLessThan(text.indexOf("assistant:"));
  });

  it("流式中的行不参与（is_streaming=1）", () => {
    const conv = "c2";
    const repo = makeRepo(conv);
    repo.saveMessage({
      id: "s1",
      conversationId: conv,
      role: "user",
      contentJson: { type: "text", text: "在吗" },
      timestamp: "2026-09-17T11:00:00.000Z",
    });
    repo.saveMessage({
      id: "s2",
      conversationId: conv,
      role: "assistant",
      contentJson: { type: "assistant_parts", parts: [] },
      isStreaming: true,
      timestamp: "2026-09-17T11:00:01.000Z",
    });

    const text = repo.loadSegmentText(conv, "s1", "s2");
    expect(text).toBe("user: 在吗");
  });

  it("起点消息不存在时返回空串（调用方据此跳过归档）", () => {
    const repo = makeRepo("c3");
    expect(repo.loadSegmentText("c3", "不存在", "也不存在")).toBe("");
  });
});

/**
 * llmError 透传（2026-09-20）
 *
 * 落盘侧写入后，回读必须原样带出——否则「历史回放显示失败原因」只完成了一半：
 * parse 把字段丢掉 → 渲染层拿不到 → 失败的子 Agent 运行块又回到「已完成」。
 */
describe("parseMessageContentJson 透传 llmError", () => {
  it("assistant_parts 的 llmError 原样返回", () => {
    const llmError = { code: "insufficient_credits", message: "账户余额不足", retryable: false };
    const parsed = parseMessageContentJson(
      JSON.stringify({ type: "assistant_parts", parts: [], llmError }),
    );
    expect(parsed).toMatchObject({ type: "assistant_parts", llmError });
  });

  it("没有该字段时不凭空捏造（旧数据兼容）", () => {
    const parsed = parseMessageContentJson(JSON.stringify({ type: "assistant_parts", parts: [] }));
    expect(parsed).not.toHaveProperty("llmError");
  });
});
