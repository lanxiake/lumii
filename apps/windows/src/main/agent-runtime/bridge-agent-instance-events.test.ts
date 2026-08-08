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
