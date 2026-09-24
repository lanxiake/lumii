import { describe, it, expect } from "vitest";
import { dedupIdenticalToolResults, truncateHeavyToolCallArguments } from "./micro-compact.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

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
    // 去重消息的 content 是数组格式：[{ type: "text", text: "..." }]
    const content0 = Array.isArray(result[0].content)
      ? result[0].content[0]?.text ?? ""
      : String(result[0].content);
    expect(content0).toMatch(/工具结果与更近期调用完全一致/);

    const content2 = Array.isArray(result[2].content)
      ? result[2].content[0]?.text ?? ""
      : String(result[2].content);
    expect(content2).toMatch(/工具结果与更近期调用完全一致/);

    expect(result[3].content).toBe(content); // 最新保留（字符串）
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
  /** 真实的 pi assistant 消息：toolCall 在 content 数组里，arguments 是**已解析的对象** */
  function assistantWithArgs(
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): AgentMessage {
    return {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
    } as unknown as AgentMessage;
  }

  /** 取出第 i 条消息里第一个 toolCall 的 arguments */
  function argsOf(msg: AgentMessage | undefined): Record<string, unknown> {
    const content = (msg as { content?: Array<{ type: string; arguments?: unknown }> }).content ?? [];
    const call = content.find((b) => b.type === "toolCall");
    return (call?.arguments ?? {}) as Record<string, unknown>;
  }

  it("arguments 里的超长字符串被截断（对象形态 = 真实形态），结构性字段不动", () => {
    const messages: AgentMessage[] = [
      assistantWithArgs("call1", "write_file", { path: "test.txt", content: "x".repeat(10_000) }),
      assistantWithArgs("call2", "bash", { command: "ls" }),
    ];

    const result = truncateHeavyToolCallArguments(messages, 0, 1500); // protectTailCount=0

    const args1 = argsOf(result[0]);
    expect(String(args1.content).length).toBeLessThanOrEqual(1500);
    expect(String(args1.content)).toMatch(/\.{3}/); // 带省略标记
    expect(args1.path).toBe("test.txt"); // 短字段不截断
    // 短调用原对象返回（引用不变，Proactive Prune 靠它统计改动数）
    expect(result[1]).toBe(messages[1]);
  });

  it("arguments 是 JSON 字符串的历史形态也支持", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call1", name: "write_file", arguments: JSON.stringify({ content: "y".repeat(9_000) }) },
        ],
      } as unknown as AgentMessage,
    ];

    const result = truncateHeavyToolCallArguments(messages, 0, 1500);

    expect(JSON.stringify(argsOf(result[0]))).toMatch(/\.{3}/);
  });

  it("protectTailCount=20：最后 20 条不截断", () => {
    const messages: AgentMessage[] = Array.from({ length: 25 }, (_, i) =>
      assistantWithArgs(`call${i}`, "write_file", { content: "x".repeat(5000) }),
    );

    const result = truncateHeavyToolCallArguments(messages, 20, 1500);

    expect(String(argsOf(result[0]).content)).toMatch(/\.{3}/); // 前 5 条被截断
    expect(argsOf(result[24]).content).toHaveLength(5000); // tail 不动
  });
});

