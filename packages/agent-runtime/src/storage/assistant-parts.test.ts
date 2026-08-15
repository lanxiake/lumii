// packages/agent-runtime/src/storage/assistant-parts.test.ts
import { describe, expect, it } from "vitest";
import {
  applyAssistantPartEvent,
  finalizeAssistantParts,
  diffTurnSnapshots,
} from "./assistant-parts.js";

describe("applyAssistantPartEvent", () => {
  it("连续 text delta 合并到同一 streaming text part", () => {
    let parts = applyAssistantPartEvent([], { kind: "text_delta", delta: "你" });
    parts = applyAssistantPartEvent(parts, { kind: "text_delta", delta: "好" });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "text", text: "你好", status: "streaming" });
  });

  it("thinking → tool → thinking 拆成三段，不合并首尾 thinking", () => {
    let parts = applyAssistantPartEvent([], { kind: "thinking_delta", delta: "先想" });
    parts = applyAssistantPartEvent(parts, { kind: "thinking_end" });
    parts = applyAssistantPartEvent(parts, {
      kind: "tool_start",
      id: "t1",
      name: "file_read",
      args: { path: "a.ts" },
    });
    parts = applyAssistantPartEvent(parts, { kind: "thinking_delta", delta: "再想" });
    expect(parts.map((p) => p.type)).toEqual(["thinking", "tool", "thinking"]);
    expect(parts[0]).toMatchObject({ type: "thinking", text: "先想", status: "done" });
    expect(parts[2]).toMatchObject({ type: "thinking", text: "再想", status: "streaming" });
  });

  it("tool_end 按 id patch；乱序先 stub 再补全", () => {
    let parts = applyAssistantPartEvent([], {
      kind: "tool_end",
      id: "t1",
      name: "bash",
      result: "ok",
      isError: false,
    });
    expect(parts[0]).toMatchObject({ type: "tool", id: "t1", status: "done", result: "ok" });
    parts = applyAssistantPartEvent(parts, {
      kind: "tool_start",
      id: "t1",
      name: "bash",
      args: { command: "ls" },
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "tool", args: { command: "ls" }, status: "done" });
  });

  it("tool_start 透传 meta", () => {
    const meta = { sourceAgent: { instanceId: "a1", label: "子 Agent" } };
    const parts = applyAssistantPartEvent([], {
      kind: "tool_start",
      id: "t1",
      name: "file_read",
      args: { path: "a.ts" },
      meta,
    });
    expect(parts[0]).toMatchObject({ type: "tool", meta });
  });
});

describe("finalizeAssistantParts", () => {
  it("streaming thinking/text → done", () => {
    const parts = finalizeAssistantParts([
      { type: "thinking", id: "th-1", text: "想", status: "streaming" },
      { type: "text", id: "tx-1", text: "答", status: "streaming" },
      { type: "thinking", id: "th-2", text: "完", status: "done" },
    ]);
    expect(parts[0]).toMatchObject({ status: "done" });
    expect(parts[1]).toMatchObject({ status: "done" });
    expect(parts[2]).toMatchObject({ status: "done" });
  });

  it("running tool 保持不变", () => {
    const running = {
      type: "tool" as const,
      id: "t1",
      name: "bash",
      args: { command: "ls" },
      status: "running" as const,
    };
    const done = {
      type: "tool" as const,
      id: "t2",
      name: "bash",
      args: {},
      status: "done" as const,
      result: "ok",
    };
    const error = {
      type: "tool" as const,
      id: "t3",
      name: "bash",
      args: {},
      status: "error" as const,
      result: "fail",
      isError: true,
    };
    const parts = finalizeAssistantParts([running, done, error]);
    expect(parts[0]).toMatchObject({ status: "running" });
    expect(parts[1]).toMatchObject({ status: "done" });
    expect(parts[2]).toMatchObject({ status: "error" });
  });
});

describe("diffTurnSnapshots", () => {
  it("新增/修改/删除；创建又删不出现；hash 不变不出现", () => {
    const start = new Map([
      ["a.ts", "h1"],
      ["b.ts", "h2"],
    ]);
    const end = new Map([
      ["b.ts", "h2-changed"],
      ["c.ts", "h3"],
    ]);
    const diff = diffTurnSnapshots(start, end);
    expect(diff).toEqual([
      { path: "c.ts", status: "added" },
      { path: "b.ts", status: "modified" },
      { path: "a.ts", status: "deleted" },
    ]);
  });

  it("start/end 皆无某路径 → 不收录", () => {
    expect(diffTurnSnapshots(new Map(), new Map())).toEqual([]);
  });

  it("反斜杠路径规范为正斜杠", () => {
    const start = new Map([["src\\a.ts", "h1"]]);
    const end = new Map([["src/a.ts", "h2"]]);
    expect(diffTurnSnapshots(start, end)).toEqual([
      { path: "src/a.ts", status: "modified" },
    ]);
  });
});
