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
