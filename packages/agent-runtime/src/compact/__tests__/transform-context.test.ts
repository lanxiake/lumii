import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import { createTransformContext, microcompactToolResults, COMPACTABLE_TOOLS, buildCompactSummaryPrompt, buildLlmSummaryMessage } from "../index.js";

/**
 * 构造带 toolCall 的 assistant 消息（与 pi-agent-core 结构一致）
 */
function assistantWithToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "test_tool", arguments: {} }],
  } as AgentMessage;
}

function toolResult(id: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "test_tool",
    content: [{ type: "text", text: "ok" }],
  } as AgentMessage;
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

describe("createTransformContext — 工具消息与 OpenAI 兼容 API", () => {
  it("压缩分割点落在 toolResult 上时，不把 tool 段首送给 LLM", async () => {
    const manyUsers: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      manyUsers.push(user(`u${i}`));
      manyUsers.push({ role: "assistant", content: `a${i}` } as AgentMessage);
    }
    const tail: AgentMessage[] = [
      user("last-user"),
      assistantWithToolCall("call-1"),
      toolResult("call-1"),
      { role: "assistant", content: "final answer" } as AgentMessage,
    ];
    const messages = [...manyUsers, ...tail];

    const transform = createTransformContext({
      contextWindow: 4096,
      triggerRatio: 0.01,
      keepRecentTurns: 6,
      outputReserveTokens: 1024,
      summaryReserveTokens: 512,
    });

    const out = await transform(messages, undefined);
    expect(out.length).toBeGreaterThan(0);
    const firstRole = (out[0] as { role?: string }).role;
    expect(firstRole).not.toBe("toolResult");
    const roles = out.map((m) => (m as { role?: string }).role);
    expect(roles.includes("toolResult")).toBe(true);
    const firstToolIdx = roles.indexOf("toolResult");
    if (firstToolIdx > 0) {
      expect(roles[firstToolIdx - 1]).toBe("assistant");
    }
  });

  it("序列首部孤立 toolResult 会在压缩前被剥离", async () => {
    const messages: AgentMessage[] = [
      toolResult("orphan"),
      user("hi"),
      { role: "assistant", content: "hello" } as AgentMessage,
    ];

    const transform = createTransformContext({
      contextWindow: 4096,
      triggerRatio: 0.01,
      keepRecentTurns: 6,
      outputReserveTokens: 1024,
      summaryReserveTokens: 512,
    });

    const out = await transform(messages, undefined);
    expect((out[0] as { role?: string }).role).not.toBe("toolResult");
  });
});

describe("checkCompactionNeeded — 触发点对齐真实上下文窗口", () => {
  it("触发阈值 = contextWindow × triggerRatio，与 output/summary 预留无关", async () => {
    // 构造足够多消息使估算 token 远超 9000（触发点）
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(user("x".repeat(500)));
      messages.push({ role: "assistant", content: "y".repeat(500) } as AgentMessage);
    }

    let capturedThreshold: number | null = null;
    const transform = createTransformContext({
      contextWindow: 10_000,
      triggerRatio: 0.9,
      keepRecentTurns: 4,
      // 故意把预留设得极大：旧逻辑会让 threshold 变成 (10000-9000-5000)×0.9 < 0 而永不触发；
      // 新逻辑触发判断只看 contextWindow×triggerRatio，应固定为 9000。
      outputReserveTokens: 9_000,
      summaryReserveTokens: 5_000,
      onCompaction: (info) => {
        capturedThreshold = info.threshold;
      },
    });

    await transform(messages, undefined);
    expect(capturedThreshold).toBe(9_000);
  });

  it("token 低于 contextWindow × triggerRatio 时不触发压缩", async () => {
    const messages: AgentMessage[] = [user("short"), { role: "assistant", content: "ok" } as AgentMessage];
    let triggered = false;
    const transform = createTransformContext({
      contextWindow: 1_000_000,
      triggerRatio: 0.9,
      keepRecentTurns: 4,
      outputReserveTokens: 32_768,
      summaryReserveTokens: 8_192,
      onCompaction: () => {
        triggered = true;
      },
    });
    await transform(messages, undefined);
    expect(triggered).toBe(false);
  });
});

// ==================== 主题2 P0-1：MicroCompact 第一级压缩 ====================

/** 构造带指定 toolName 与内容长度的 toolResult */
function namedToolResult(id: string, toolName: string, contentLen: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text: "x".repeat(contentLen) }],
  } as AgentMessage;
}

function assistantCall(id: string, name: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
  } as AgentMessage;
}

describe("microcompactToolResults — 白名单 + 计数保留", () => {
  it("仅清白名单工具的旧结果，保留最近 N 个，结构化工具结果不清", () => {
    const messages: AgentMessage[] = [user("start")];
    // 6 个 file_read（白名单）+ 1 个 spawn_agent（非白名单），内容均 > 200 字符
    for (let i = 0; i < 6; i++) {
      messages.push(assistantCall(`r${i}`, "file_read"));
      messages.push(namedToolResult(`r${i}`, "file_read", 500));
    }
    messages.push(assistantCall("s0", "spawn_agent"));
    messages.push(namedToolResult("s0", "spawn_agent", 500));

    const out = microcompactToolResults(messages, 2); // 保留最近 2 个可压缩结果

    // 消息条数不变
    expect(out.length).toBe(messages.length);

    const placeholderCount = out.filter((m) => {
      const c = (m as { content?: unknown }).content;
      if (Array.isArray(c)) {
        return (c as Array<{ text?: string }>).some((b) => b.text?.includes("旧工具结果已清理"));
      }
      return false;
    }).length;
    // 6 个 file_read 中清理最旧 4 个，保留最近 2 个
    expect(placeholderCount).toBe(4);

    // spawn_agent（非白名单）结果不被清
    const spawnResult = out.find((m) => (m as { toolName?: string }).toolName === "spawn_agent");
    const spawnContent = (spawnResult as { content?: Array<{ text?: string }> }).content;
    expect(spawnContent?.[0]?.text).toBe("x".repeat(500));

    // user 消息不动
    expect((out[0] as { content?: string }).content).toBe("start");
  });

  it("可压缩结果数量 <= keepRecent 时不清理任何内容", () => {
    const messages: AgentMessage[] = [
      user("s"),
      assistantCall("a", "file_read"),
      namedToolResult("a", "file_read", 500),
    ];
    const out = microcompactToolResults(messages, 8);
    expect(out).toBe(messages); // 原样返回（引用相等）
  });

  it("白名单常量包含核心幂等工具", () => {
    expect(COMPACTABLE_TOOLS.has("file_read")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("bash")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("grep")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("spawn_agent")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("todo_write")).toBe(false);
  });

  it("P1-2 preserveCurrentUserTurn：当前未闭合 user 轮内的 toolResult 不清", () => {
    const messages: AgentMessage[] = [user("u1")];
    // 历史轮 3 个 file_read
    for (let i = 0; i < 3; i++) {
      messages.push(assistantCall(`h${i}`, "file_read"));
      messages.push(namedToolResult(`h${i}`, "file_read", 500));
    }
    // 当前 user 轮（最后一条 user 之后）再来 2 个 file_read
    messages.push(user("u2"));
    for (let i = 0; i < 2; i++) {
      messages.push(assistantCall(`c${i}`, "file_read"));
      messages.push(namedToolResult(`c${i}`, "file_read", 500));
    }

    // keepRecent=0：不保护时全部 5 个会被清；保护当前轮则只清历史 3 个
    const out = microcompactToolResults(messages, 0, { preserveCurrentUserTurn: true });

    const clearedIds = new Set<string>();
    for (const m of out) {
      const c = (m as { content?: Array<{ text?: string }> }).content;
      if (Array.isArray(c) && c.some((b) => b.text?.includes("已清理") || b.text?.includes("已归档"))) {
        clearedIds.add((m as { toolCallId?: string }).toolCallId ?? "");
      }
    }
    // 历史轮 3 个被清
    expect(clearedIds.has("h0")).toBe(true);
    expect(clearedIds.has("h2")).toBe(true);
    // 当前轮 2 个未被清
    expect(clearedIds.has("c0")).toBe(false);
    expect(clearedIds.has("c1")).toBe(false);
  });

  it("P1-3 useSummary：清理时生成含原文线索的确定性微摘要", () => {
    const messages: AgentMessage[] = [user("u1")];
    for (let i = 0; i < 3; i++) {
      messages.push(assistantCall(`r${i}`, "bash"));
      messages.push({
        role: "toolResult",
        toolCallId: `r${i}`,
        toolName: "bash",
        content: [
          { type: "text", text: `exit code 0\n${"line\n".repeat(50)}BUILD SUCCESS` },
        ],
      } as AgentMessage);
    }

    const out = microcompactToolResults(messages, 1, { useSummary: true });

    // 找被清理的（非最近 1 个）bash 结果
    const summarized = out
      .filter((m) => (m as { toolName?: string }).toolName === "bash")
      .map((m) => {
        const c = (m as { content?: Array<{ text?: string }> }).content;
        return c?.[0]?.text ?? "";
      })
      .filter((t) => t.includes("已归档"));

    expect(summarized.length).toBe(2); // 3 个清 2 个
    const sample = summarized[0]!;
    expect(sample).toContain("tool=bash");
    expect(sample).toContain("行"); // 行数统计
    expect(sample).toContain("exit code 0"); // 首行线索
    expect(sample).toContain("BUILD SUCCESS"); // 尾行线索
  });

  it("微摘要幂等：已归档的结果再次 microcompact 不重复包裹", () => {
    const messages: AgentMessage[] = [user("u1")];
    for (let i = 0; i < 3; i++) {
      messages.push(assistantCall(`r${i}`, "bash"));
      messages.push(namedToolResult(`r${i}`, "bash", 500));
    }
    const once = microcompactToolResults(messages, 1, { useSummary: true });
    const twice = microcompactToolResults(once, 1, { useSummary: true });
    // 第二次对已归档内容不再处理（已归档前缀被跳过），归档结果文本不应嵌套
    const archived = twice
      .filter((m) => (m as { toolName?: string }).toolName === "bash")
      .map((m) => ((m as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""))
      .filter((t) => t.includes("已归档"));
    for (const t of archived) {
      // "已归档" 只出现一次（无嵌套包裹）
      expect(t.split("已归档").length - 1).toBe(1);
    }
  });
});

describe("createTransformContext — MicroCompact 第一级触发", () => {
  /** 在 [microRatio, triggerRatio) 区间构造消息，使其触发 micro 而非全摘要 */
  function buildMessagesInMicroRange(): AgentMessage[] {
    const messages: AgentMessage[] = [user("task")];
    // 15 个 file_read 结果 × 3200 字符 ≈ 14878 tokens（估算口径 0.3/英文字符，落在 [14000, 18000)）
    for (let i = 0; i < 15; i++) {
      messages.push(assistantCall(`c${i}`, "file_read"));
      messages.push(namedToolResult(`c${i}`, "file_read", 3200));
    }
    messages.push({ role: "assistant", content: "done" } as AgentMessage);
    return messages;
  }

  it("[0.7,0.9) 区间只触发 MicroCompact：strategy=micro、不丢消息、user/assistant 不动", async () => {
    const messages = buildMessagesInMicroRange();
    const userAssistantBefore = messages.filter((m) => {
      const r = (m as { role?: string }).role;
      return r === "user" || r === "assistant";
    }).length;

    let captured: { strategy?: string; usedSummary?: boolean; messagesBefore?: number; messagesAfter?: number } | null = null;
    const transform = createTransformContext({
      contextWindow: 20_000,
      triggerRatio: 0.9, // 全摘要阈值 18000
      microCompactRatio: 0.7, // micro 阈值 14000
      keepRecentTurns: 4,
      keepRecentToolResults: 8,
      outputReserveTokens: 500,
      summaryReserveTokens: 500,
      onCompaction: (info) => {
        captured = info as typeof captured;
      },
    });

    const out = await transform(messages, undefined);

    expect(captured).not.toBeNull();
    expect(captured!.strategy).toBe("micro");
    expect(captured!.usedSummary).toBe(false);
    // micro 不删消息（messagesAfter 与 before 相等）
    expect(captured!.messagesAfter).toBe(captured!.messagesBefore);

    // user/assistant 数量不变（对话未被丢弃）
    const userAssistantAfter = out.filter((m) => {
      const r = (m as { role?: string }).role;
      return r === "user" || r === "assistant";
    }).length;
    expect(userAssistantAfter).toBe(userAssistantBefore);

    // 出现微摘要归档标记（旧 file_read 结果被清，第一级默认 useSummary）
    const hasPlaceholder = out.some((m) => {
      const c = (m as { content?: unknown }).content;
      return (
        Array.isArray(c) &&
        (c as Array<{ text?: string }>).some(
          (b) => b.text?.includes("已归档") || b.text?.includes("旧工具结果已清理"),
        )
      );
    });
    expect(hasPlaceholder).toBe(true);
  });

  it("enableMicroCompact=false 时不触发 micro（回退原行为）", async () => {
    const messages = buildMessagesInMicroRange();
    let captured: { strategy?: string } | null = null;
    const transform = createTransformContext({
      contextWindow: 20_000,
      triggerRatio: 0.9,
      microCompactRatio: 0.7,
      keepRecentTurns: 4,
      enableMicroCompact: false,
      outputReserveTokens: 500,
      summaryReserveTokens: 500,
      onCompaction: (info) => {
        captured = info as typeof captured;
      },
    });
    await transform(messages, undefined);
    // 未触发全摘要（仍在 [0.7,0.9) 区间），也未触发 micro → onCompaction 不应报 micro
    if (captured) {
      expect(captured!.strategy).not.toBe("micro");
    }
  });
});

// ==================== Phase 2/4：通用摘要提示词与回查指针 ====================

describe("buildCompactSummaryPrompt — 通用 9-section 摘要", () => {
  it("general 模式包含 9 段结构与安全约束逐字保留要求", () => {
    const prompt = buildCompactSummaryPrompt({ domainHint: "general" });
    expect(prompt).toContain("1. Primary Request and Intent");
    expect(prompt).toContain("2. Key Facts, Decisions and Preferences");
    expect(prompt).toContain("3. Materials and Outputs");
    expect(prompt).toContain("6. All user messages");
    expect(prompt).toContain("Preserve any safety/privacy constraints VERBATIM");
    expect(prompt).not.toContain("ADDITIONAL (coding context)");
  });

  it("coding 模式追加代码细节要求", () => {
    const prompt = buildCompactSummaryPrompt({ domainHint: "coding" });
    expect(prompt).toContain("ADDITIONAL (coding context)");
    expect(prompt).toContain("full code snippets");
  });

  it("activeTasks 注入到第 7 段任务索引", () => {
    const prompt = buildCompactSummaryPrompt({
      activeTasks: [{ id: "t1", subject: "写周报", status: "in_progress" }],
      domainHint: "general",
    });
    expect(prompt).toContain("Active Task Index");
    expect(prompt).toContain("[in_progress] 写周报");
    expect(prompt).toContain("(id: t1)");
  });

  it("customInstructions 追加到模板末尾", () => {
    const prompt = buildCompactSummaryPrompt({ customInstructions: "聚焦 TypeScript 改动" });
    expect(prompt).toContain("Additional Instructions:");
    expect(prompt).toContain("聚焦 TypeScript 改动");
    // 空串不追加
    const empty = buildCompactSummaryPrompt({ customInstructions: "  " });
    expect(empty).not.toContain("Additional Instructions:");
  });
});

describe("buildLlmSummaryMessage — 回查原文指针", () => {
  it("historyRecallHint=false 时不包含 memory_read 指针", () => {
    const msg = buildLlmSummaryMessage("1. Summary line", false);
    const content = (msg as { content?: string }).content ?? "";
    expect(content).not.toContain("memory_read");
  });

  it("historyRecallHint=true 时追加 memory_search → memory_read 指针", () => {
    const msg = buildLlmSummaryMessage("1. Summary line", true);
    const content = (msg as { content?: string }).content ?? "";
    expect(content).toContain("memory_search");
    expect(content).toContain("memory_read");
    expect(content).toContain("drawer_id");
    expect(content).toContain("检索相关历史");
  });

  it("historyRecallHint=true 且 sessionKey 时会话过滤提示", () => {
    const msg = buildLlmSummaryMessage("1. Summary line", {
      historyRecallHint: true,
      sessionKey: "conv-xyz",
    });
    const content = (msg as { content?: string }).content ?? "";
    expect(content).toContain("sessionKey=conv-xyz");
    expect(content).toContain("优先在当前会话");
  });
});

describe("createTransformContext — sessionKey 端到端", () => {
  it("压缩回填消息在 sessionKey 注入时包含会话过滤提示", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(user("x".repeat(500)));
      messages.push({ role: "assistant", content: "y".repeat(500) } as AgentMessage);
    }

    const transform = createTransformContext({
      contextWindow: 10_000,
      triggerRatio: 0.9,
      keepRecentTurns: 4,
      outputReserveTokens: 500,
      summaryReserveTokens: 500,
      historyRecallHint: true,
      sessionKey: "conv-e2e-test",
      generateSummary: async () => "<summary>compressed</summary>",
    });

    const out = await transform(messages, undefined);
    const summaryMsg = out[0] as { content?: string };
    expect(typeof summaryMsg.content).toBe("string");
    expect(summaryMsg.content).toContain("sessionKey=conv-e2e-test");
  });
});

describe("createTransformContext — historyRecallHint 端到端", () => {
  it("压缩回填消息在 historyRecallHint=true 时包含回查指针", async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(user("x".repeat(500)));
      messages.push({ role: "assistant", content: "y".repeat(500) } as AgentMessage);
    }

    const transform = createTransformContext({
      contextWindow: 10_000,
      triggerRatio: 0.9,
      keepRecentTurns: 4,
      outputReserveTokens: 500,
      summaryReserveTokens: 500,
      historyRecallHint: true,
      generateSummary: async () => "<summary>compressed</summary>",
    });

    const out = await transform(messages, undefined);
    const summaryMsg = out[0] as { content?: string };
    expect(typeof summaryMsg.content).toBe("string");
    expect(summaryMsg.content).toContain("memory_read");
  });
});
