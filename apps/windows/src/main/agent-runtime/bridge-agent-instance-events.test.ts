import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AssistantPart } from "@mtbot/agent-runtime";
import { createRunContext } from "./event-converter";
import { createInstanceState, InstanceStateStore } from "./bridge-instance-state";
import {
  createAgentInstanceRuntimeEventHandler,
  createAssistantPartsContent,
} from "./bridge-agent-instance-events";

describe("Wiki 摄入钩子接线", () => {
  function buildHandler(getWikiIngestHook: () => never) {
    const ctx = createRunContext("session-wiki", "instance", "session-wiki");
    const instanceStates = new InstanceStateStore();
    instanceStates.set(
      "instance",
      createInstanceState(ctx, {
        definitionId: "agent",
        runningStartedAt: null,
        completedTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    );
    const handler = createAgentInstanceRuntimeEventHandler({
      instanceId: "instance",
      ctx,
      ipcChannel: { forwardIpcEvent: vi.fn(), forwardToRenderer: vi.fn() } as never,
      conversationRepo: null,
      fileRepo: null,
      fileMemoryHandler: {} as never,
      getWikiIngestHook,
      // Agent 定义 id，与 wiki 工具 / wiki 命令同口径（不是会话 id）
      resolveWikiAgentId: () => "assistant",
      instanceStates,
      instanceToConversation: new Map(),
      toolCallInstanceMap: new Map(),
      toolStartTimeMap: new Map(),
      nodeStreamCallbacks: new Map(),
      getCompactionForRootSession: () => ({
        contextWindow: 128_000,
        outputReserveTokens: 8_000,
        summaryReserveTokens: 4_000,
      }),
      getSessionContextUsage: () => ({
        usedTokens: 0,
        contextWindow: 128_000,
        // 与生产同义：ContextUsage 的 triggerThreshold 是比率，不是 token 数
        triggerThreshold: 0.78,
      }),
      setSessionProviderInputTokens: vi.fn(),
      calibrateSessionCharsPerToken: vi.fn(),
      clearSessionProviderInputTokens: vi.fn(),
      setCurrentToolExecutorInstanceId: vi.fn(),
      getCwd: () => os.tmpdir(),
    });
    return { handler, ctx };
  }

  it("file_write 写入 .py 脚本时不调用 ingestOutput", () => {
    const ingestOutput = vi.fn();
    const { handler } = buildHandler(() => ({ ingestUpload: vi.fn(), ingestOutput } as never));

    handler({ type: "tool:start", toolCallId: "t1", toolName: "file_write", args: { filePath: "outputs/run.py" } } as never);
    handler({ type: "tool:end", toolCallId: "t1", toolName: "file_write", isError: false, result: {} } as never);

    expect(ingestOutput).not.toHaveBeenCalled();
  });

  it("file_write 成功后调用 ingestOutput（非 uploads/ 路径）", () => {
    const ingestOutput = vi.fn();
    const { handler } = buildHandler(() => ({ ingestUpload: vi.fn(), ingestOutput } as never));

    handler({ type: "tool:start", toolCallId: "t1", toolName: "file_write", args: { filePath: "outputs/report.md" } } as never);
    handler({ type: "tool:end", toolCallId: "t1", toolName: "file_write", isError: false, result: {} } as never);

    // 首参必须是 Agent 定义 id：传会话 id 会让摄入落进查不到的命名空间
    expect(ingestOutput).toHaveBeenCalledWith("assistant", "local-user", "outputs/report.md", "report.md");
  });

  it("file_write 成功后 uploads/ 路径调用 ingestUpload", () => {
    const ingestUpload = vi.fn();
    const { handler } = buildHandler(() => ({ ingestUpload, ingestOutput: vi.fn() } as never));

    handler({ type: "tool:start", toolCallId: "t1", toolName: "file_write", args: { filePath: "uploads/photo.png" } } as never);
    handler({ type: "tool:end", toolCallId: "t1", toolName: "file_write", isError: false, result: {} } as never);

    expect(ingestUpload).toHaveBeenCalledWith("assistant", "local-user", "uploads/photo.png", "photo.png");
  });

  it("uploads/outputs 之外的目录不自动摄入（避免脏数据）", () => {
    const ingestUpload = vi.fn();
    const ingestOutput = vi.fn();
    const { handler } = buildHandler(() => ({ ingestUpload, ingestOutput } as never));

    for (const filePath of [
      "skills/my-skill/SKILL.md",
      "workspace/skills/my-skill/reference.md",
      "projects/demo/README.md",
      "files/note.md",
      "draft.md",
    ]) {
      handler({ type: "tool:start", toolCallId: filePath, toolName: "file_write", args: { filePath } } as never);
      handler({ type: "tool:end", toolCallId: filePath, toolName: "file_write", isError: false, result: {} } as never);
    }

    expect(ingestUpload).not.toHaveBeenCalled();
    expect(ingestOutput).not.toHaveBeenCalled();
  });

  it("工具失败时不摄入", () => {
    const ingestOutput = vi.fn();
    const { handler } = buildHandler(() => ({ ingestUpload: vi.fn(), ingestOutput } as never));

    handler({ type: "tool:start", toolCallId: "t1", toolName: "file_write", args: { filePath: "outputs/a.md" } } as never);
    handler({ type: "tool:end", toolCallId: "t1", toolName: "file_write", isError: true, result: {} } as never);

    expect(ingestOutput).not.toHaveBeenCalled();
  });

  it("web_search 成功后不再摄入 Wiki（只收录文件）", () => {
    const ingestWebSearch = vi.fn();
    const { handler } = buildHandler(() => ({ ingestWebSearch } as never));

    handler({ type: "tool:start", toolCallId: "t1", toolName: "web_search", args: {} } as never);
    handler({
      type: "tool:end",
      toolCallId: "t1",
      toolName: "web_search",
      isError: false,
      result: {
        details: {
          items: [
            { title: "标题A", url: "https://a.example.com", summary: "摘要A" },
            { title: "标题B", url: "https://b.example.com", summary: "摘要B" },
          ],
        },
      },
    } as never);

    expect(ingestWebSearch).not.toHaveBeenCalled();
  });

  it("getWikiIngestHook 返回 null 时安静跳过（不抛错）", () => {
    const { handler } = buildHandler(() => null as never);
    expect(() => {
      handler({ type: "tool:start", toolCallId: "t1", toolName: "file_write", args: { filePath: "outputs/a.md" } } as never);
      handler({ type: "tool:end", toolCallId: "t1", toolName: "file_write", isError: false, result: {} } as never);
    }).not.toThrow();
  });
});

/** 事件处理器测试用的最小依赖装配（落库类 describe 共用） */
function buildHandler(conversationRepo: Record<string, unknown>) {
  const ctx = createRunContext("session", "instance", "session");
  const instanceStates = new InstanceStateStore();
  const state = createInstanceState(ctx, {
    definitionId: "agent",
    runningStartedAt: null,
    completedTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  state.streamingAssistantMsgId = "message-1";
  instanceStates.set("instance", state);
  const handler = createAgentInstanceRuntimeEventHandler({
    instanceId: "instance",
    ctx,
    ipcChannel: { forwardIpcEvent: vi.fn(), forwardToRenderer: vi.fn() } as never,
    conversationRepo: conversationRepo as never,
    fileRepo: null,
    fileMemoryHandler: {} as never,
    getWikiIngestHook: () => null,
    resolveWikiAgentId: () => "assistant",
    instanceStates,
    instanceToConversation: new Map([["instance", "conversation-1"]]),
    toolCallInstanceMap: new Map(),
    toolStartTimeMap: new Map(),
    nodeStreamCallbacks: new Map(),
    getCompactionForRootSession: () => ({
      contextWindow: 128_000,
      outputReserveTokens: 8_000,
      summaryReserveTokens: 4_000,
    }),
    getSessionContextUsage: () => ({
      usedTokens: 0,
      contextWindow: 128_000,
      triggerThreshold: 102_400,
    }),
    setSessionProviderInputTokens: vi.fn(),
    calibrateSessionCharsPerToken: vi.fn(),
    clearSessionProviderInputTokens: vi.fn(),
    setCurrentToolExecutorInstanceId: vi.fn(),
    getCwd: () => os.tmpdir(),
  });
  return { handler, state };
}

describe("NO_REPLY 哨兵轮的落库处理", () => {

  it("整轮就是 NO_REPLY → 不落库并删除占位行（否则重开会话看到 NO_REPLY 气泡）", async () => {
    const updateMessageContent = vi.fn();
    const deleteMessage = vi.fn();
    const { handler, state } = buildHandler({
      updateMessageContent,
      deleteMessage,
      saveMessage: vi.fn(),
      getConversation: vi.fn().mockReturnValue({ id: "conversation-1" }),
      finalizeStreamingMessagesForConversation: vi.fn(),
    });
    state.pendingParts = [{ type: "text", id: "t1", text: "NO_REPLY", status: "done" }];

    await handler({ type: "agent:end" } as never);

    expect(updateMessageContent).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith("message-1", "conversation-1");
  });

  it("带工具轨迹的 NO_REPLY 轮 → 保留工具 part，只剔除哨兵文本", async () => {
    const updateMessageContent = vi.fn();
    const { handler, state } = buildHandler({
      updateMessageContent,
      deleteMessage: vi.fn(),
      saveMessage: vi.fn(),
      getConversation: vi.fn().mockReturnValue({ id: "conversation-1" }),
      finalizeStreamingMessagesForConversation: vi.fn(),
    });
    state.pendingParts = [
      {
        type: "tool",
        id: "tool-1",
        name: "file_read",
        args: { path: "README.md" },
        result: "ok",
        isError: false,
        status: "done",
      },
      { type: "text", id: "t1", text: "NO_REPLY", status: "done" },
    ];

    await handler({ type: "agent:end" } as never);

    expect(updateMessageContent).toHaveBeenCalled();
    const arg = updateMessageContent.mock.calls.at(-1)![0] as { contentJson: unknown };
    const serialized = JSON.stringify(arg.contentJson);
    expect(serialized).not.toContain("NO_REPLY");
    expect(serialized).toContain("file_read");
  });

  it("正常回复不受影响（照常落库）", async () => {
    const updateMessageContent = vi.fn();
    const { handler, state } = buildHandler({
      updateMessageContent,
      deleteMessage: vi.fn(),
      saveMessage: vi.fn(),
      getConversation: vi.fn().mockReturnValue({ id: "conversation-1" }),
      finalizeStreamingMessagesForConversation: vi.fn(),
    });
    state.pendingParts = [{ type: "text", id: "t1", text: "今天的天气不错", status: "done" }];

    await handler({ type: "agent:end" } as never);

    const arg = updateMessageContent.mock.calls.at(-1)![0] as { contentJson: unknown };
    expect(JSON.stringify(arg.contentJson)).toContain("今天的天气不错");
  });
});

describe("assistant parts bridge persistence", () => {
  it("实例状态只以 pendingParts 保存助手轮次内容", () => {
    const state = createInstanceState(
      createRunContext("session", "instance", "session"),
      {
        definitionId: "agent",
        runningStartedAt: null,
        completedTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    );

    expect(state.pendingParts).toEqual([]);
    expect(state).not.toHaveProperty("accumulatedText");
    expect(state).not.toHaveProperty("accumulatedThinking");
    expect(state).not.toHaveProperty("pendingTools");
  });

  it("收尾时落库 assistant_parts 并完成流式段", () => {
    const parts: AssistantPart[] = [
      { type: "thinking", id: "thinking-1", text: "分析", status: "streaming" },
      { type: "text", id: "text-1", text: "答案", status: "streaming" },
      {
        type: "tool",
        id: "tool-1",
        name: "file_read",
        args: { path: "README.md" },
        result: "ok",
        isError: false,
        status: "done",
      },
    ];

    expect(
      createAssistantPartsContent(parts, {
        usage: { inputTokens: 10, outputTokens: 4 },
        sourceAgent: { instanceId: "child-1", label: "子 Agent" },
        fileChanges: [{ path: "src/index.ts", status: "modified" }],
      }),
    ).toEqual({
      type: "assistant_parts",
      parts: [
        { type: "thinking", id: "thinking-1", text: "分析", status: "done" },
        { type: "text", id: "text-1", text: "答案", status: "done" },
        {
          type: "tool",
          id: "tool-1",
          name: "file_read",
          args: { path: "README.md" },
          result: "ok",
          isError: false,
          status: "done",
        },
      ],
      usage: { inputTokens: 10, outputTokens: 4 },
      sourceAgent: { instanceId: "child-1", label: "子 Agent" },
      fileChanges: [{ path: "src/index.ts", status: "modified" }],
    });
  });

  it("仅在缺少 thinking 事件时解析原始 think 标签兜底", () => {
    const parts: AssistantPart[] = [
      {
        type: "text",
        id: "text-1",
        text: "<think>先分析</think>最终答案",
        status: "streaming",
      },
    ];

    const content = createAssistantPartsContent(parts);

    expect(content.type).toBe("assistant_parts");
    expect(content.parts).toEqual([
      expect.objectContaining({ type: "thinking", text: "先分析", status: "done" }),
      { type: "text", id: "text-1", text: "最终答案", status: "done" },
    ]);
  });

  it("逐段清理 think 标签且保持工具前后正文顺序", () => {
    const parts: AssistantPart[] = [
      {
        type: "text",
        id: "text-1",
        text: "工具前<think>先分析</think>正文",
        status: "done",
      },
      {
        type: "tool",
        id: "tool-1",
        name: "file_read",
        args: {},
        status: "done",
        result: "ok",
      },
      {
        type: "text",
        id: "text-2",
        text: "<think>再分析</think>工具后",
        status: "done",
      },
    ];

    expect(createAssistantPartsContent(parts).parts).toEqual([
      expect.objectContaining({
        type: "thinking",
        text: "先分析\n\n再分析",
        status: "done",
      }),
      { type: "text", id: "text-1", text: "工具前正文", status: "done" },
      parts[1],
      { type: "text", id: "text-2", text: "工具后", status: "done" },
    ]);
  });

  it("已有 thinking part 时仍清理后续正文中的原始标签", () => {
    const parts: AssistantPart[] = [
      { type: "thinking", id: "thinking-1", text: "事件思考", status: "done" },
      {
        type: "text",
        id: "text-1",
        text: "<think>重复思考</think>最终答案",
        status: "done",
      },
    ];

    expect(createAssistantPartsContent(parts).parts).toEqual([
      parts[0],
      { type: "text", id: "text-1", text: "最终答案", status: "done" },
    ]);
  });

  it("无 think 标签时保留工具后正文的前导空白", () => {
    const parts: AssistantPart[] = [
      { type: "text", id: "text-1", text: "\n\n  缩进正文", status: "streaming" },
    ];

    expect(createAssistantPartsContent(parts).parts).toEqual([
      { type: "text", id: "text-1", text: "\n\n  缩进正文", status: "done" },
    ]);
  });

  it("agent:end 将工作区净变更写入消息并转发事件", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-turn-snapshot-"));
    fs.writeFileSync(path.join(workspaceDir, "tracked.txt"), "new content");

    try {
      const ctx = createRunContext("session", "instance", "session");
      const instanceStates = new InstanceStateStore();
      const state = createInstanceState(ctx, {
        definitionId: "agent",
        runningStartedAt: null,
        completedTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      state.pendingParts = [
        { type: "text", id: "text-1", text: "完成", status: "done" },
      ];
      state.streamingAssistantMsgId = "message-1";
      state.turnSnapshotStart = new Map([["tracked.txt", "old-hash"]]);
      instanceStates.set("instance", state);

      const updateMessageContent = vi.fn();
      const forwardIpcEvent = vi.fn();
      let activeWorkspaceDir = workspaceDir;
      const handler = createAgentInstanceRuntimeEventHandler({
        instanceId: "instance",
        ctx,
        ipcChannel: {
          forwardIpcEvent,
          forwardToRenderer: vi.fn(),
        } as never,
        conversationRepo: {
          updateMessageContent,
        } as never,
        fileRepo: null,
        fileMemoryHandler: {} as never,
        getWikiIngestHook: () => null,
        resolveWikiAgentId: () => "assistant",
        instanceStates,
        instanceToConversation: new Map([["instance", "conversation-1"]]),
        toolCallInstanceMap: new Map(),
        toolStartTimeMap: new Map(),
        nodeStreamCallbacks: new Map(),
        getCompactionForRootSession: () => ({
          contextWindow: 128_000,
          outputReserveTokens: 8_000,
          summaryReserveTokens: 4_000,
        }),
        getSessionContextUsage: () => ({
          usedTokens: 0,
          contextWindow: 128_000,
          triggerThreshold: 102_400,
        }),
        setSessionProviderInputTokens: vi.fn(),
        calibrateSessionCharsPerToken: vi.fn(),
        clearSessionProviderInputTokens: vi.fn(),
        setCurrentToolExecutorInstanceId: vi.fn(),
        getCwd: () => activeWorkspaceDir,
      });

      const firstResult = handler({ type: "agent:end" } as never);

      expect(firstResult).toBeUndefined();
      await vi.waitFor(() => {
        expect(updateMessageContent).toHaveBeenCalled();
      });

      expect(updateMessageContent).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "message-1",
          contentJson: expect.objectContaining({
            fileChanges: [{ path: "tracked.txt", status: "modified" }],
          }),
        }),
      );
      expect(forwardIpcEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent:turn:file-changes",
          messageId: "message-1",
          fileChanges: [{ path: "tracked.txt", status: "modified" }],
        }),
      );
      expect(state.turnSnapshotStart).toBeUndefined();

      updateMessageContent.mockClear();
      forwardIpcEvent.mockClear();
      state.pendingParts = [
        { type: "text", id: "text-2", text: "失败降级", status: "done" },
      ];
      state.streamingAssistantMsgId = "message-2";
      state.turnSnapshotStart = new Map([["tracked.txt", "old-hash"]]);
      activeWorkspaceDir = path.join(workspaceDir, "missing");

      const secondResult = handler({ type: "agent:end" } as never);

      expect(secondResult).toBeUndefined();
      await vi.waitFor(() => {
        expect(updateMessageContent).toHaveBeenCalled();
      });

      expect(updateMessageContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contentJson: expect.not.objectContaining({ fileChanges: expect.anything() }),
        }),
      );
      expect(forwardIpcEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent:turn:file-changes" }),
      );
      expect(state.turnSnapshotStart).toBeUndefined();
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

/**
 * LLM 错误落盘（2026-09-20）
 *
 * 回归背景：实时失败态由事件流支撑，重开会话后事件早没了、只剩 content_json ——
 * 不把 llmError 落盘，失败的子 Agent 运行块在历史里只能显示「已完成」，
 * 原因也只剩正文里一段散文。
 */
describe("LLM 错误落盘（历史回放要能说出失败原因）", () => {
  const LLM_ERROR = { code: "insufficient_credits", message: "账户余额不足", retryable: false };

  function repoMocks() {
    return {
      updateMessageContent: vi.fn(),
      deleteMessage: vi.fn(),
      saveMessage: vi.fn(),
      getConversation: vi.fn().mockReturnValue({ id: "conversation-1" }),
      finalizeStreamingMessagesForConversation: vi.fn(),
    };
  }

  function lastContentJson(repo: { updateMessageContent: ReturnType<typeof vi.fn> }) {
    const arg = repo.updateMessageContent.mock.calls.at(-1)![0] as {
      contentJson: Record<string, unknown>;
    };
    return arg.contentJson;
  }

  it("message:end 带 llmError → 落库内容带上 llmError", async () => {
    const repo = repoMocks();
    const { handler, state } = buildHandler(repo);
    state.pendingParts = [{ type: "text", id: "t1", text: "本轮失败了", status: "done" }];

    await handler({ type: "message:end", llmError: LLM_ERROR, stopReason: "error" } as never);

    expect(lastContentJson(repo).llmError).toEqual(LLM_ERROR);
  });

  it("agent:error 收尾沿用本轮 llmError（重写同一行时不丢）", async () => {
    const repo = repoMocks();
    const { handler, state } = buildHandler(repo);
    state.pendingParts = [{ type: "text", id: "t1", text: "本轮失败了", status: "done" }];

    await handler({ type: "message:end", llmError: LLM_ERROR, stopReason: "error" } as never);
    await handler({ type: "agent:error", error: "boom", errorCode: "insufficient_credits" } as never);

    expect(lastContentJson(repo).llmError).toEqual(LLM_ERROR);
  });

  it("后续干净收尾清掉上一轮 llmError（自愈重试成功后不该显示失败）", async () => {
    const repo = repoMocks();
    const { handler, state } = buildHandler(repo);
    state.pendingParts = [{ type: "text", id: "t1", text: "第一次失败", status: "done" }];

    await handler({ type: "message:end", llmError: LLM_ERROR, stopReason: "error" } as never);
    await handler({ type: "message:end", stopReason: "end_turn" } as never);
    await handler({ type: "agent:end" } as never);

    expect(lastContentJson(repo)).not.toHaveProperty("llmError");
  });

  it("没有 llmError 的轮次不写该字段（旧行为不变）", async () => {
    const repo = repoMocks();
    const { handler, state } = buildHandler(repo);
    state.pendingParts = [{ type: "text", id: "t1", text: "一切正常", status: "done" }];

    await handler({ type: "message:end", stopReason: "end_turn" } as never);

    expect(lastContentJson(repo)).not.toHaveProperty("llmError");
  });
});

/**
 * 中止标记落盘（2026-09-20 冒烟实测）
 *
 * 与 llmError 同一道理：实时中断态由 message:end 的 stopReason='aborted' 支撑，
 * 重开会话后事件早没了、只剩 content_json —— 不落标记，被中止的子 Agent 运行块
 * 在历史里只能显示「已完成」。
 */
describe("中止标记落盘（历史回放要能区分「已完成」与「已中断」）", () => {
  function repoMocks() {
    return {
      updateMessageContent: vi.fn(),
      deleteMessage: vi.fn(),
      saveMessage: vi.fn(),
      getConversation: vi.fn().mockReturnValue({ id: "conversation-1" }),
      finalizeStreamingMessagesForConversation: vi.fn(),
    };
  }

  function lastContentJson(repo: { updateMessageContent: ReturnType<typeof vi.fn> }) {
    const arg = repo.updateMessageContent.mock.calls.at(-1)![0] as {
      contentJson: Record<string, unknown>;
    };
    return arg.contentJson;
  }

  it("message:end stopReason=aborted → 落库内容带 aborted:true", async () => {
    const repo = repoMocks();
    const { handler, state } = buildHandler(repo);
    state.pendingParts = [{ type: "thinking", id: "th1", text: "想一半被中止", status: "done" }];

    await handler({ type: "message:end", stopReason: "aborted" } as never);

    expect(lastContentJson(repo).aborted).toBe(true);
  });

  it("agent:end 收尾沿用中止标记（最终行重写时不丢）", async () => {
    const repo = repoMocks();
    const { handler, state } = buildHandler(repo);
    state.pendingParts = [{ type: "thinking", id: "th1", text: "想一半被中止", status: "done" }];

    await handler({ type: "message:end", stopReason: "aborted" } as never);
    await handler({ type: "agent:end" } as never);

    expect(lastContentJson(repo).aborted).toBe(true);
  });

  it("后续干净收尾清掉上一轮中止标记（不该把中断态粘到下一轮）", async () => {
    const repo = repoMocks();
    const { handler, state } = buildHandler(repo);
    state.pendingParts = [{ type: "text", id: "t1", text: "被中止的一轮", status: "done" }];

    await handler({ type: "message:end", stopReason: "aborted" } as never);
    await handler({ type: "message:end", stopReason: "end_turn" } as never);
    await handler({ type: "agent:end" } as never);

    expect(lastContentJson(repo)).not.toHaveProperty("aborted");
  });

  it("正常轮次不写该字段（旧行为不变）", async () => {
    const repo = repoMocks();
    const { handler, state } = buildHandler(repo);
    state.pendingParts = [{ type: "text", id: "t1", text: "一切正常", status: "done" }];

    await handler({ type: "message:end", stopReason: "end_turn" } as never);

    expect(lastContentJson(repo)).not.toHaveProperty("aborted");
  });
});

describe("上下文占用推送（逐往返刷新 + 触发线）", () => {
  /**
   * 占用条原先只在 agent:end 推一次，带工具循环的一轮能跑十几分钟不动。
   * 这里固定住新契约：每次 LLM 往返推轻量快照，agent:end 强推完整快照。
   */
  function buildHandler(opts?: { sessionKey?: string; rootSessionKey?: string }) {
    const sessionKey = opts?.sessionKey ?? "session";
    const rootSessionKey = opts?.rootSessionKey ?? sessionKey;
    const ctx = createRunContext(sessionKey, "instance", rootSessionKey);
    const instanceStates = new InstanceStateStore();
    instanceStates.set(
      "instance",
      createInstanceState(ctx, {
        definitionId: "agent",
        runningStartedAt: null,
        completedTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    );

    const forwardIpcEvent = vi.fn();
    const setSessionProviderInputTokens = vi.fn();
    // 生产实现里 withBreakdown: false 走轻量路径：不算分类明细与触发线快照
    const getSessionContextUsage = vi.fn(
      (_sessionKey: string, o?: { withBreakdown?: boolean }) => ({
        usedTokens: 12_000,
        contextWindow: 128_000,
        triggerThreshold: 0.78,
        ...(o?.withBreakdown === false
          ? {}
          : {
              breakdown: [{ category: "conversation" as const, tokens: 5_000 }],
              budget: {
                compressibleTokens: 5_000,
                budgetTokens: 100_000,
                triggerTokens: 78_000,
                exhausted: false,
              },
            }),
      }),
    );

    const handler = createAgentInstanceRuntimeEventHandler({
      instanceId: "instance",
      ctx,
      ipcChannel: { forwardIpcEvent, forwardToRenderer: vi.fn() } as never,
      conversationRepo: null,
      fileRepo: null,
      fileMemoryHandler: {} as never,
      getWikiIngestHook: () => null,
      resolveWikiAgentId: () => "assistant",
      instanceStates,
      instanceToConversation: new Map(),
      toolCallInstanceMap: new Map(),
      toolStartTimeMap: new Map(),
      nodeStreamCallbacks: new Map(),
      getCompactionForRootSession: () => ({
        contextWindow: 128_000,
        outputReserveTokens: 8_000,
        summaryReserveTokens: 4_000,
      }),
      getSessionContextUsage,
      setSessionProviderInputTokens,
      calibrateSessionCharsPerToken: vi.fn(),
      clearSessionProviderInputTokens: vi.fn(),
      setCurrentToolExecutorInstanceId: vi.fn(),
      getCwd: () => os.tmpdir(),
    });

    const usageEvents = () =>
      forwardIpcEvent.mock.calls
        .map((call) => call[0] as { type?: string })
        .filter((e) => e?.type === "agent:context:usage");

    return { handler, usageEvents, getSessionContextUsage, setSessionProviderInputTokens };
  }

  /** 让 fire-and-forget 的事件处理跑完，再断言「没有推送」 */
  const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("message:end 就刷新占用条，且走轻量路径不算明细", async () => {
    const { handler, usageEvents, getSessionContextUsage } = buildHandler();

    await handler({
      type: "message:end",
      usage: { inputTokens: 12_000, outputTokens: 30 },
      stopReason: "tool_use",
      fullText: "中途",
    } as never);

    const events = usageEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionKey: "session",
      usedTokens: 12_000,
      contextWindow: 128_000,
      triggerThreshold: 0.78,
    });
    // 轻量路径：明细与触发线要遍历全部消息估算，逐往返重算会重演主进程冻结
    expect(getSessionContextUsage).toHaveBeenCalledWith("session", { withBreakdown: false });
    expect(events[0]).not.toHaveProperty("breakdown");
    expect(events[0]).not.toHaveProperty("budget");
  });

  it("agent:end 强推完整快照（明细 + 触发线），阈值与查询口径一致", async () => {
    const { handler, usageEvents } = buildHandler();

    await handler({
      type: "message:end",
      usage: { inputTokens: 12_000, outputTokens: 30 },
      stopReason: "tool_use",
      fullText: "中途",
    } as never);
    await handler({ type: "agent:end" } as never);

    const events = usageEvents();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      triggerThreshold: 0.78,
      breakdown: [{ category: "conversation", tokens: 5_000 }],
      budget: { compressibleTokens: 5_000, budgetTokens: 100_000, triggerTokens: 78_000, exhausted: false },
    });
  });

  it("同一秒内的连续往返只推一次（节流），最终由 agent:end 兜底", async () => {
    const { handler, usageEvents } = buildHandler();

    await handler({
      type: "message:end",
      usage: { inputTokens: 1_000, outputTokens: 1 },
      stopReason: "tool_use",
      fullText: "a",
    } as never);
    await handler({
      type: "message:end",
      usage: { inputTokens: 2_000, outputTokens: 1 },
      stopReason: "tool_use",
      fullText: "b",
    } as never);

    expect(usageEvents()).toHaveLength(1);

    await handler({ type: "agent:end" } as never);
    expect(usageEvents()).toHaveLength(2);
  });

  it("子 Agent 会话不推（只有根会话的占用条要刷新）", async () => {
    const { handler, usageEvents } = buildHandler({ sessionKey: "child-1", rootSessionKey: "session" });

    await handler({
      type: "message:end",
      usage: { inputTokens: 1_000, outputTokens: 1 },
      stopReason: "end_turn",
      fullText: "x",
    } as never);
    await flushMicrotasks();

    expect(usageEvents()).toHaveLength(0);
  });

  it("服务商没回传 usage 时不推（估算值不进占用条）", async () => {
    const { handler, usageEvents, setSessionProviderInputTokens } = buildHandler();

    await handler({ type: "message:end", stopReason: "end_turn", fullText: "x" } as never);
    await flushMicrotasks();

    expect(setSessionProviderInputTokens).not.toHaveBeenCalled();
    expect(usageEvents()).toHaveLength(0);
  });
});
