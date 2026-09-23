import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaultConvertToLlm } from "../message-repair.js";

/**
 * `defaultConvertToLlm` 必须**保留 system 消息**。
 *
 * 这条是 2026-09-23 pi 升级后的实测回归：旧版（0.50.x）系统提示词走独立的
 * `Context.systemPrompt` 字段、工具走 `Context.tools`，滤掉 system 消息无副作用；
 * 新版（0.87.1）把**提示词与工具声明都挂在 transcript 的 SystemMessage 上**，
 * 滤掉它等于把提示词和整套工具一起删光。
 *
 * 现场：inputTokens 从全天均值 6 万+ 掉到 82，模型回「当前环境没有文件系统读取工具」，
 * 一个工具调用都发不出来。改动见 message-repair.ts 第一遍过滤。
 */

const system = (text: string, tools: string[] = []) =>
  ({
    role: "system",
    content: text,
    ...(tools.length
      ? { toolsAdded: tools.map((name) => ({ name, description: `${name} tool`, parameters: {} })) }
      : {}),
    timestamp: 1,
  }) as unknown as AgentMessage;

const user = (text: string) =>
  ({ role: "user", content: text, timestamp: 2 }) as unknown as AgentMessage;

const assistantWithCall = (id: string, stopReason = "toolUse") =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
    api: "openai-completions",
    provider: "openai",
    model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason,
    timestamp: 3,
  }) as unknown as AgentMessage;

const toolResult = (id: string) =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 4,
  }) as unknown as AgentMessage;

describe("defaultConvertToLlm —— system 消息保全", () => {
  it("保留 system 消息（升级回归：丢掉它 = 丢掉提示词与整套工具）", () => {
    const out = defaultConvertToLlm([system("你是助手"), user("hi")]);
    const keep = out.filter((m) => m.role === "system");
    expect(keep).toHaveLength(1);
    expect((keep[0] as unknown as { content: string }).content).toBe("你是助手");
  });

  it("system 上的 toolsAdded 一并保留（新版工具声明挂在它身上）", () => {
    const out = defaultConvertToLlm([system("你是助手", ["bash", "file_read"]), user("hi")]);
    const tools = (out[0] as unknown as { toolsAdded?: { name: string }[] }).toolsAdded ?? [];
    expect(tools.map((t) => t.name)).toEqual(["bash", "file_read"]);
  });

  it("顺序不变：system 仍在首位", () => {
    const out = defaultConvertToLlm([
      system("s"),
      user("u"),
      assistantWithCall("c1"),
      toolResult("c1"),
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult"]);
  });

  it("非 LLM 的 role 仍被滤掉（没把过滤放宽过头）", () => {
    const custom = { role: "custom", content: "x", timestamp: 5 } as unknown as AgentMessage;
    const bashExec = { role: "bashExecution", command: "ls", output: "", timestamp: 6 } as unknown as AgentMessage;
    const out = defaultConvertToLlm([system("s"), user("u"), custom, bashExec]);
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("配对修复照旧：error/aborted 的 assistant 及其 toolResult 仍被剔除", () => {
    const out = defaultConvertToLlm([
      system("s"),
      user("u"),
      assistantWithCall("c1", "aborted"),
      toolResult("c1"),
      assistantWithCall("c2"),
      toolResult("c2"),
    ]);
    // c1 是 aborted 的孤立调用，连带它的 toolResult 一起剔除；c2 配对完整，留下
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "toolResult"]);
    expect((out[2] as unknown as { content: { id: string }[] }).content[0].id).toBe("c2");
  });
});
