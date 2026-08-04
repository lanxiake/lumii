import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryIntegration, type MemoryIntegrationDeps } from "../memory-integration.js";
import type { MemoryManager } from "../../memory/manager.js";
import type { MemoryEntry } from "../../memory/types.js";

function userMsg(text: string): unknown {
  return { role: "user", content: text };
}

function assistantMsg(text: string): unknown {
  return { role: "assistant", content: text };
}

function fakeMemory(content: string): MemoryEntry {
  return { content } as unknown as MemoryEntry;
}

function makeManager(overrides: Partial<MemoryManager> = {}): MemoryManager {
  return {
    injectIntoSystemPrompt: vi.fn(() => ({ updatedPrompt: "base", injected: [] as MemoryEntry[] })),
    saveRuleExtractedCandidates: vi.fn(() => 0),
    saveLLMExtractedCandidates: vi.fn(async () => 0),
    ...overrides,
  } as unknown as MemoryManager;
}

function makeDeps(
  messages: unknown[],
  manager: MemoryManager | undefined,
  overrides: Partial<MemoryIntegrationDeps> = {},
): { deps: MemoryIntegrationDeps; state: { prompt: string } } {
  const state = { prompt: "base" };
  const deps: MemoryIntegrationDeps = {
    instanceId: "test",
    definitionId: "def",
    memoryManager: manager,
    userId: "u1",
    memoryConfig: { scope: "user" } as MemoryIntegrationDeps["memoryConfig"],
    memoryExtractEvery: 3,
    getAgent: () => ({
      messages,
      systemPrompt: state.prompt,
      setSystemPrompt: (p: string) => {
        state.prompt = p;
      },
    }),
    getTurnCount: () => 3,
    getInjectWorkMemory: () => true,
    ...overrides,
  };
  return { deps, state };
}

describe("MemoryIntegration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("loadAndInjectMemories", () => {
    it("无 manager / 无 userId 时跳过", () => {
      const { deps } = makeDeps([userMsg("hi")], undefined);
      const mi = new MemoryIntegration(deps);
      mi.loadAndInjectMemories();
      expect(mi.injectedSnapshot).toEqual([]);
    });

    it("scope=none 时跳过", () => {
      const manager = makeManager();
      const { deps } = makeDeps([userMsg("hi")], manager, {
        memoryConfig: { scope: "none" } as MemoryIntegrationDeps["memoryConfig"],
      });
      new MemoryIntegration(deps).loadAndInjectMemories();
      expect(manager.injectIntoSystemPrompt).not.toHaveBeenCalled();
    });

    it("getInjectWorkMemory=false 时跳过", () => {
      const manager = makeManager();
      const { deps } = makeDeps([userMsg("hi")], manager, { getInjectWorkMemory: () => false });
      new MemoryIntegration(deps).loadAndInjectMemories();
      expect(manager.injectIntoSystemPrompt).not.toHaveBeenCalled();
    });

    it("有命中记忆：写回系统提示词并记录快照", () => {
      const injected = [fakeMemory("用户喜欢简洁")];
      const manager = makeManager({
        injectIntoSystemPrompt: vi.fn(() => ({ updatedPrompt: "base+mem", injected })),
      });
      const { deps, state } = makeDeps([userMsg("最新问题")], manager);
      const mi = new MemoryIntegration(deps);
      mi.loadAndInjectMemories();
      expect(manager.injectIntoSystemPrompt).toHaveBeenCalledWith(
        "base",
        "def",
        "u1",
        undefined,
        "最新问题",
      );
      expect(state.prompt).toBe("base+mem");
      expect(mi.injectedSnapshot).toEqual(injected);
    });

    it("无命中记忆：不改提示词，快照为空", () => {
      const manager = makeManager();
      const { deps, state } = makeDeps([userMsg("q")], manager);
      const mi = new MemoryIntegration(deps);
      mi.loadAndInjectMemories();
      expect(state.prompt).toBe("base");
      expect(mi.injectedSnapshot).toEqual([]);
    });

    it("clearInjectedSnapshot 清空快照", () => {
      const injected = [fakeMemory("m")];
      const manager = makeManager({
        injectIntoSystemPrompt: vi.fn(() => ({ updatedPrompt: "x", injected })),
      });
      const { deps } = makeDeps([userMsg("q")], manager);
      const mi = new MemoryIntegration(deps);
      mi.loadAndInjectMemories();
      expect(mi.injectedSnapshot).toHaveLength(1);
      mi.clearInjectedSnapshot();
      expect(mi.injectedSnapshot).toEqual([]);
    });
  });

  describe("extractMemoriesIfNeeded", () => {
    it("autoExtract=false 时跳过", () => {
      const manager = makeManager();
      const { deps } = makeDeps([userMsg("hello world")], manager, {
        memoryConfig: { scope: "user", autoExtract: false } as MemoryIntegrationDeps["memoryConfig"],
      });
      new MemoryIntegration(deps).extractMemoriesIfNeeded();
      expect(manager.saveRuleExtractedCandidates).not.toHaveBeenCalled();
    });

    it("turnCount 未到 extractEvery 倍数时跳过规则提取", () => {
      const manager = makeManager();
      const { deps } = makeDeps([userMsg("hello world")], manager, { getTurnCount: () => 2 });
      new MemoryIntegration(deps).extractMemoriesIfNeeded();
      expect(manager.saveRuleExtractedCandidates).not.toHaveBeenCalled();
    });

    it("到达节流轮次：调用规则提取并传入用户文本", () => {
      const manager = makeManager({ saveRuleExtractedCandidates: vi.fn(() => 2) });
      const { deps } = makeDeps([userMsg("记账规则"), assistantMsg("ok")], manager, {
        getTurnCount: () => 3,
      });
      new MemoryIntegration(deps).extractMemoriesIfNeeded();
      expect(manager.saveRuleExtractedCandidates).toHaveBeenCalledWith(["记账规则"], "def", "u1");
    });

    it("命中记忆触发词：跳过节流，走 LLM 提取", () => {
      const manager = makeManager();
      const { deps } = makeDeps(
        [userMsg("请记住我喜欢喝美式咖啡"), assistantMsg("好的")],
        manager,
        { getTurnCount: () => 1 },
      );
      new MemoryIntegration(deps).extractMemoriesIfNeeded();
      expect(manager.saveRuleExtractedCandidates).not.toHaveBeenCalled();
      expect(manager.saveLLMExtractedCandidates).toHaveBeenCalledOnce();
    });
  });

  describe("extractMemoriesByLLMIfNeeded", () => {
    it("收集最近 user+assistant 文本对，fire-and-forget 调用", async () => {
      const save = vi.fn(async () => 1);
      const manager = makeManager({ saveLLMExtractedCandidates: save });
      const { deps } = makeDeps([userMsg("问题A"), assistantMsg("回答A")], manager);
      new MemoryIntegration(deps).extractMemoriesByLLMIfNeeded();
      await Promise.resolve();
      expect(save).toHaveBeenCalledWith(
        [
          { role: "user", content: "问题A" },
          { role: "assistant", content: "回答A" },
        ],
        "def",
        "u1",
      );
    });

    it("无可用消息时不调用", () => {
      const save = vi.fn(async () => 0);
      const manager = makeManager({ saveLLMExtractedCandidates: save });
      const { deps } = makeDeps([], manager);
      new MemoryIntegration(deps).extractMemoriesByLLMIfNeeded();
      expect(save).not.toHaveBeenCalled();
    });

    it("未到节流轮次（默认 force=false）时跳过", () => {
      const save = vi.fn(async () => 1);
      const manager = makeManager({ saveLLMExtractedCandidates: save });
      const { deps } = makeDeps([userMsg("问题A"), assistantMsg("回答A")], manager, {
        getTurnCount: () => 2,
      });
      new MemoryIntegration(deps).extractMemoriesByLLMIfNeeded();
      expect(save).not.toHaveBeenCalled();
    });

    it("force=true 时绕过节流立即提取", async () => {
      const save = vi.fn(async () => 1);
      const manager = makeManager({ saveLLMExtractedCandidates: save });
      const { deps } = makeDeps([userMsg("问题A"), assistantMsg("回答A")], manager, {
        getTurnCount: () => 2,
      });
      new MemoryIntegration(deps).extractMemoriesByLLMIfNeeded(true);
      await Promise.resolve();
      expect(save).toHaveBeenCalledOnce();
    });
  });
});
