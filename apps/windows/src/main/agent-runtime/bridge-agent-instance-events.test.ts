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
        triggerThreshold: 102_400,
      }),
      setSessionProviderInputTokens: vi.fn(),
      calibrateSessionCharsPerToken: vi.fn(),
      clearSessionProviderInputTokens: vi.fn(),
      setCurrentToolExecutorInstanceId: vi.fn(),
      getCwd: () => os.tmpdir(),
    });
    return { handler, ctx };
  }

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
