import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRunContext } from "./event-converter";
import { createInstanceState, InstanceStateStore } from "./bridge-instance-state";
import { BridgePromptDispatcher } from "./bridge-prompt-dispatcher";

describe("BridgePromptDispatcher direct image turns", () => {
  it("直接生图持久化消息并关联本轮文件净变更", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-direct-image-"));

    try {
      const ctx = createRunContext("conversation-1", "instance-1", "conversation-1");
      const state = createInstanceState(ctx, {
        definitionId: "agent",
        runningStartedAt: null,
        completedTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      const instanceStates = new InstanceStateStore();
      instanceStates.set("instance-1", state);

      const saveMessage = vi.fn(() => ({ id: "image-message-1" }));
      const forwardIpcEvent = vi.fn();
      const appendMessage = vi.fn();
      const dispatcher = new BridgePromptDispatcher({
        agentRegistry: {
          get: () => ({
            state: "idle",
            appendMessage,
          }),
        },
        instanceStates,
        instanceToConversation: new Map([["instance-1", "conversation-1"]]),
        instanceToRootSessionKey: new Map([["instance-1", "conversation-1"]]),
        sessionModelCatalog: {
          getPreferredModelRawForStream: () => "gpt-image-2",
          getCompactionForRootSession: () => ({
            contextWindow: 128_000,
            outputReserveTokens: 8_000,
            summaryReserveTokens: 4_000,
          }),
        },
        promptComposer: {},
        featureFlags: {},
        ipcChannel: {
          forwardIpcEvent,
        },
        imageServices: {
          generateImage: async () => {
            const relativePath = "outputs/generated.png";
            const absolutePath = path.join(workspaceDir, relativePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, "image");
            return {
              filePath: relativePath,
              width: 1024,
              height: 1024,
              model: "gpt-image-2",
              revisedPrompt: "生成图片",
            };
          },
        },
        compactor: {},
        instanceFactory: {},
        modelRouter: {
          resolveExplicitModelId: () => ({ id: "gpt-image-2" }),
        },
        config: {
          getCwd: () => workspaceDir,
        },
        getSkillEvolutionEngine: () => undefined,
        getConversationRepo: () => ({
          loadMessagesAsPiFormat: () => [],
          saveMessage,
        }),
      } as never);

      await dispatcher.prompt("instance-1", "生成图片");

      expect(saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conversation-1",
          role: "assistant",
          contentJson: expect.objectContaining({
            type: "assistant_parts",
            fileChanges: [{ path: "outputs/generated.png", status: "added" }],
          }),
        }),
      );
      expect(forwardIpcEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent:turn:file-changes",
          messageId: "image-message-1",
          fileChanges: [{ path: "outputs/generated.png", status: "added" }],
        }),
      );
      expect(state.turnSnapshotStart).toBeUndefined();
      expect(appendMessage).toHaveBeenCalled();
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("BridgePromptDispatcher auto-compact pendingUserMsgId exclusion", () => {
  it("自动压缩块从 DB 重载历史时排除本轮 pendingUserMsgId，防止发送末尾重复 user 消息", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-exclude-msg-"));

    try {
      const ctx = createRunContext("conversation-1", "instance-1", "conversation-1");
      const state = createInstanceState(ctx, {
        definitionId: "agent",
        runningStartedAt: null,
        completedTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      const instanceStates = new InstanceStateStore();
      instanceStates.set("instance-1", state);

      // 20 条长文本 user 消息：估算 tokens 远超 contextWindow 20000 × 0.78 阈值，触发自动压缩
      const longText = "压".repeat(1500);
      const historyMessages = Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: `历史消息${i} ${longText}` }],
      }));

      const loadMessagesAsPiFormat = vi.fn(
        (_conversationId: string, _options?: { limit?: number; excludeMessageId?: string }) =>
          historyMessages,
      );
      const instancePrompt = vi.fn(async () => {});
      const replaceMessages = vi.fn();
      const compactContextAsync = vi.fn(async () => ({
        success: true,
        previousMessageCount: 20,
        newMessageCount: 20,
        messagesRemoved: 0,
        hadSummary: false,
        conversationTokensBefore: 0,
        conversationTokensAfter: 0,
      }));

      const dispatcher = new BridgePromptDispatcher({
        agentRegistry: {
          get: () => ({
            state: "idle",
            replaceMessages,
            prompt: instancePrompt,
            setMemoryInjectionFlags: () => {},
            setSystemPrompt: () => {},
          }),
        },
        instanceStates,
        instanceToConversation: new Map([["instance-1", "conversation-1"]]),
        instanceToRootSessionKey: new Map([["instance-1", "conversation-1"]]),
        sessionModelCatalog: {
          getPreferredModelRawForStream: () => undefined,
          getCompactionForRootSession: () => ({
            contextWindow: 20_000,
            outputReserveTokens: 0,
            summaryReserveTokens: 0,
          }),
        },
        promptComposer: {},
        featureFlags: {},
        ipcChannel: {
          forwardIpcEvent: () => {},
        },
        compactor: {
          compactContextAsync,
        },
        instanceFactory: {
          buildImageContents: async () => undefined,
        },
        modelRouter: {},
        config: {
          getCwd: () => workspaceDir,
          getMemoryInjectionSettings: () => undefined,
        },
        getSkillEvolutionEngine: () => undefined,
        getConversationRepo: () => ({
          loadMessagesAsPiFormat,
        }),
      } as never);

      await dispatcher.prompt("instance-1", "新消息", undefined, "pending-msg-1");

      expect(loadMessagesAsPiFormat).toHaveBeenCalledWith(
        "conversation-1",
        expect.objectContaining({ excludeMessageId: "pending-msg-1" }),
      );
      expect(compactContextAsync).toHaveBeenCalled();
      expect(instancePrompt).toHaveBeenCalledWith("新消息", undefined);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("不传 pendingUserMsgId 时自动压缩块不加 excludeMessageId（保持旧调用形状）", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-no-exclude-msg-"));

    try {
      const ctx = createRunContext("conversation-1", "instance-1", "conversation-1");
      const state = createInstanceState(ctx, {
        definitionId: "agent",
        runningStartedAt: null,
        completedTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      const instanceStates = new InstanceStateStore();
      instanceStates.set("instance-1", state);

      const longText = "压".repeat(1500);
      const historyMessages = Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: `历史消息${i} ${longText}` }],
      }));

      const loadMessagesAsPiFormat = vi.fn(
        (_conversationId: string, _options?: { limit?: number; excludeMessageId?: string }) =>
          historyMessages,
      );
      const dispatcher = new BridgePromptDispatcher({
        agentRegistry: {
          get: () => ({
            state: "idle",
            replaceMessages: () => {},
            prompt: async () => {},
            setMemoryInjectionFlags: () => {},
            setSystemPrompt: () => {},
          }),
        },
        instanceStates,
        instanceToConversation: new Map([["instance-1", "conversation-1"]]),
        instanceToRootSessionKey: new Map([["instance-1", "conversation-1"]]),
        sessionModelCatalog: {
          getPreferredModelRawForStream: () => undefined,
          getCompactionForRootSession: () => ({
            contextWindow: 20_000,
            outputReserveTokens: 0,
            summaryReserveTokens: 0,
          }),
        },
        promptComposer: {},
        featureFlags: {},
        ipcChannel: {
          forwardIpcEvent: () => {},
        },
        compactor: {
          compactContextAsync: async () => ({
            success: true,
            previousMessageCount: 20,
            newMessageCount: 20,
            messagesRemoved: 0,
            hadSummary: false,
            conversationTokensBefore: 0,
            conversationTokensAfter: 0,
          }),
        },
        instanceFactory: {
          buildImageContents: async () => undefined,
        },
        modelRouter: {},
        config: {
          getCwd: () => workspaceDir,
          getMemoryInjectionSettings: () => undefined,
        },
        getSkillEvolutionEngine: () => undefined,
        getConversationRepo: () => ({
          loadMessagesAsPiFormat,
        }),
      } as never);

      await dispatcher.prompt("instance-1", "新消息");

      expect(loadMessagesAsPiFormat).toHaveBeenCalledWith(
        "conversation-1",
        expect.objectContaining({ limit: 500 }),
      );
      const options = loadMessagesAsPiFormat.mock.calls[0]?.[1];
      expect(options?.excludeMessageId).toBeUndefined();
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
