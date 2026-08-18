import { describe, it, expect } from "vitest";
import { dedupIdenticalToolResults, truncateHeavyToolCallArguments } from "./micro-compact.js";
import type { AgentMessage } from "../../types.js";

describe("dedupIdenticalToolResults - Phase 1", () => {
  it("3 条相同 file_read，保留最新一条，其余去重", () => {
    const content = "x".repeat(3000); // > 200 字符
    const messages: AgentMessage[] = [
      { id: "1", role: "toolResult", content, toolName: "file_read", createdAt: 100 },
      { id: "2", role: "user", content: "hello", createdAt: 200 },
      { id: "3", role: "toolResult", content, toolName: "file_read", createdAt: 300 },
      { id: "4", role: "toolResult", content, toolName: "file_read", createdAt: 400 },
      { id: "5", role: "toolResult", content: "different", toolName: "file_read", createdAt: 500 },
    ];
    const result = dedupIdenticalToolResults(messages, 200);
    // 预期：id=3, id=4 中最新的 id=4 保留原文，id=1/id=3 改为去重引用
    expect(result[0].content).toMatch(/工具结果与更近期调用完全一致/);
    expect(result[2].content).toMatch(/工具结果与更近期调用完全一致/);
    expect(result[3].content).toBe(content); // 最新保留
    expect(result[4].content).toBe("different"); // 不同的不动
  });

  it("非 tool role 消息不动", () => {
    const messages: AgentMessage[] = [
      { id: "1", role: "user", content: "x".repeat(300), createdAt: 100 },
      { id: "2", role: "assistant", content: "x".repeat(300), createdAt: 200 },
    ];
    const result = dedupIdenticalToolResults(messages, 200);
    expect(result[0]).toBe(messages[0]); // 原对象引用
    expect(result[1]).toBe(messages[1]);
  });

  it("content <200 字符跳过去重", () => {
    const content = "x".repeat(150); // <200
    const messages: AgentMessage[] = [
      { id: "1", role: "toolResult", content, toolName: "bash", createdAt: 100 },
      { id: "2", role: "toolResult", content, toolName: "bash", createdAt: 200 },
    ];
    const result = dedupIdenticalToolResults(messages, 200);
    // 预期：都不动（<200 字符不参与 dedup）
    expect(result[0].content).toBe(content);
    expect(result[1].content).toBe(content);
  });
});

describe("truncateHeavyToolCallArguments - Phase 1", () => {
  it("assistant tool_call arguments >1500 字符截断，结果仍是合法 JSON", () => {
    const messages: AgentMessage[] = [
      {
        id: "1",
        role: "user",
        content: "dummy",
        createdAt: 100,
      },
      {
        id: "2",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call1",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "test.txt",
                content: "x".repeat(10_000), // 10K 字符
              }),
            },
          },
        ],
        createdAt: 200,
      },
      {
        id: "3",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call2",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "ls" }),
            },
          },
        ],
        createdAt: 300,
      },
    ];
    const result = truncateHeavyToolCallArguments(messages, 0, 1500); // protectTailCount=0
    // 预期：id=2 的 content 字段被截断 ≤ 1500，但仍是合法 JSON
    const args2 = JSON.parse(result[1].toolCalls![0].function.arguments);
    expect(args2.content.length).toBeLessThanOrEqual(1500);
    expect(args2.content).toMatch(/\.{3}/); // 包含 ...
    expect(args2.path).toBe("test.txt"); // path 字段不截断
    // id=3 的 bash command 很短，不动
    const args3 = JSON.parse(result[2].toolCalls![0].function.arguments);
    expect(args3.command).toBe("ls");
  });

  it("protectTailCount=20：最后 20 条不截断", () => {
    const messages: AgentMessage[] = Array.from({ length: 25 }, (_, i) => ({
      id: String(i),
      role: "assistant" as const,
      content: "",
      toolCalls: [
        {
          id: `call${i}`,
          function: {
            name: "write_file",
            arguments: JSON.stringify({ content: "x".repeat(5000) }),
          },
        },
      ],
      createdAt: i * 100,
    }));
    const result = truncateHeavyToolCallArguments(messages, 20, 1500);
    // 预期：前 5 条（index 0-4）被截断，后 20 条（index 5-24）不动
    const args0 = JSON.parse(result[0].toolCalls![0].function.arguments);
    expect(args0.content.length).toBeLessThanOrEqual(1500);
    const args24 = JSON.parse(result[24].toolCalls![0].function.arguments);
    expect(args24.content.length).toBe(5000); // tail 不动
  });
});

