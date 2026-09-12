/**
 * abort 竞态防护回归测试（2026-09-12 EVO 缺陷 #1：心跳被孤儿 streaming 占位瘫痪）。
 *
 * 场景：agent:end 的 await 窗口（工作区快照）让出期间，abort 已释放会话锁、
 * 下一轮 agent:start 创建新占位并改写实例 state；旧 handler 恢复后必须：
 * - 用「进入时」的 parts 快照落库（不得把新回合的内容写进旧消息 / 不得覆盖空）
 * - 仅当 state 指针仍属于本 handler 时才清空（不得误清新占位指针）
 *
 * 单独成文件：需要 mock workspace-turn-snapshot 制造可控 await 挂起。
 */
import { describe, expect, it, vi } from "vitest";
import { createRunContext } from "./event-converter";
import { createInstanceState, InstanceStateStore } from "./bridge-instance-state";
import { createAgentInstanceRuntimeEventHandler } from "./bridge-agent-instance-events";

const mocks = vi.hoisted(() => ({ capture: vi.fn() }));

vi.mock("../workspace-vcs/workspace-turn-snapshot", () => ({
  captureWorkspaceTurnSnapshot: mocks.capture,
}));

function baseMetrics() {
  return {
    definitionId: "agent",
    runningStartedAt: null,
    completedTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function makeDeps(
  instanceStates: InstanceStateStore,
  conversationRepo: Record<string, unknown>,
) {
  const ctx = createRunContext("session", "instance", "session");
  return {
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
    getCwd: () => "C:/tmp",
  } as Parameters<typeof createAgentInstanceRuntimeEventHandler>[0];
}

describe("agent:end / agent:start 交错竞态防护", () => {
  it("await 窗口内新回合 start 插队：旧 end 用快照落库旧内容且不误清新指针", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.capture.mockImplementation(async () => {
      await gate;
      return new Map<string, string>();
    });

    const ctx = createRunContext("session", "instance", "session");
    const instanceStates = new InstanceStateStore();
    const state = createInstanceState(ctx, baseMetrics());
    state.pendingParts = [{ type: "text", id: "text-old", text: "旧回合内容", status: "done" }];
    state.streamingAssistantMsgId = "message-old";
    // 非空快照起点 → agent:end 会进入 await captureWorkspaceTurnSnapshot 分支
    state.turnSnapshotStart = new Map([["a.txt", "hash-old"]]);
    instanceStates.set("instance", state);

    const updateMessageContent = vi.fn();
    const saveMessage = vi.fn().mockReturnValue({ id: "message-new", is_streaming: 1 });
    const conversationRepo = {
      updateMessageContent,
      deleteMessage: vi.fn(),
      saveMessage,
      getConversation: vi.fn().mockReturnValue({ id: "conversation-1" }),
      finalizeStreamingMessagesForConversation: vi
        .fn()
        .mockReturnValue({ finalized: 0, deleted: 0 }),
    };
    const handler = createAgentInstanceRuntimeEventHandler(makeDeps(instanceStates, conversationRepo));

    // 1) 旧回合 agent:end 进入 await（挂起在快照采集）
    const endPromise = handler({ type: "agent:end" } as never);

    // 2) await 窗口内：新回合 agent:start 插队（真实 handler，改写 state）
    await handler({ type: "agent:start" } as never);
    expect(state.streamingAssistantMsgId).toBe("message-new");
    // 新回合的首批 delta 到达（此时旧 end 仍未恢复）
    state.pendingParts = [
      { type: "text", id: "text-new", text: "新回合内容", status: "streaming" },
    ];

    // 3) 释放旧 end
    release();
    await endPromise;
    await vi.waitFor(() => {
      expect(updateMessageContent).toHaveBeenCalled();
    });

    // 断言 A：写向旧消息的内容来自进入时快照（含旧文本），从未被新回合内容污染
    const oldWrites = updateMessageContent.mock.calls.filter(
      (call) => (call[0] as { messageId?: string }).messageId === "message-old",
    );
    expect(oldWrites.length).toBeGreaterThan(0);
    for (const [arg] of oldWrites) {
      const serialized = JSON.stringify((arg as { contentJson: unknown }).contentJson);
      expect(serialized).not.toContain("新回合内容");
    }
    expect(JSON.stringify(oldWrites[oldWrites.length - 1][0])).toContain("旧回合内容");

    // 断言 B：新占位指针与新回合状态未被旧 handler 清空
    expect(state.streamingAssistantMsgId).toBe("message-new");
    expect(state.pendingParts).toEqual([
      expect.objectContaining({ text: "新回合内容" }),
    ]);
  });

  it("agent:start 清扫会话孤儿流式占位并保护其他实例指针", async () => {
    mocks.capture.mockReset();

    const ctx = createRunContext("session", "instance", "session");
    const instanceStates = new InstanceStateStore();
    const state = createInstanceState(ctx, baseMetrics());
    instanceStates.set("instance", state);
    const otherState = createInstanceState(
      createRunContext("session-2", "other-instance", "session-2"),
      baseMetrics(),
    );
    otherState.streamingAssistantMsgId = "message-other";
    instanceStates.set("other-instance", otherState);

    const finalizeStreamingMessagesForConversation = vi
      .fn()
      .mockReturnValue({ finalized: 1, deleted: 1 });
    const saveMessage = vi.fn().mockReturnValue({ id: "message-new", is_streaming: 1 });
    const conversationRepo = {
      updateMessageContent: vi.fn(),
      deleteMessage: vi.fn(),
      saveMessage,
      getConversation: vi.fn().mockReturnValue({ id: "conversation-1" }),
      finalizeStreamingMessagesForConversation,
    };
    const handler = createAgentInstanceRuntimeEventHandler(makeDeps(instanceStates, conversationRepo));

    await handler({ type: "agent:start" } as never);

    expect(finalizeStreamingMessagesForConversation).toHaveBeenCalledTimes(1);
    const [convId, opts] = finalizeStreamingMessagesForConversation.mock.calls[0] as [
      string,
      { keepMessageIds: ReadonlySet<string> },
    ];
    expect(convId).toBe("conversation-1");
    expect([...opts.keepMessageIds]).toEqual(["message-other"]);
    expect(saveMessage).toHaveBeenCalled();
    expect(state.streamingAssistantMsgId).toBe("message-new");
  });
});
