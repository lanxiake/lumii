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

    it("开关关闭时清除占位符（防字面量泄漏）", () => {
      const manager = makeManager();
      const { deps, state } = makeDeps([userMsg("hi")], manager, { getInjectWorkMemory: () => false });
      state.prompt = "SYS\n{{LUMII_MEMORY_BLOCK}}\nEND";
      new MemoryIntegration(deps).loadAndInjectMemories();
      expect(state.prompt).toBe("SYS\n\nEND");
      expect(manager.injectIntoSystemPrompt).not.toHaveBeenCalled();
    });

    it("无 manager 时清除占位符", () => {
      const { deps, state } = makeDeps([userMsg("hi")], undefined);
      state.prompt = "before {{LUMII_MEMORY_BLOCK}} after";
      new MemoryIntegration(deps).loadAndInjectMemories();
      expect(state.prompt).toBe("before  after");
    });

    it("无命中记忆但含占位符：占位符出清、快照为空", () => {
      const manager = makeManager({
        injectIntoSystemPrompt: vi.fn((p: string) => ({
          updatedPrompt: p.replace("{{LUMII_MEMORY_BLOCK}}", ""),
          injected: [] as MemoryEntry[],
        })),
      });
      const { deps, state } = makeDeps([userMsg("q")], manager);
      state.prompt = "base {{LUMII_MEMORY_BLOCK}}";
      const mi = new MemoryIntegration(deps);
      mi.loadAndInjectMemories();
      expect(state.prompt).toBe("base ");
      expect(mi.injectedSnapshot).toEqual([]);
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

  /**
   * 注入自 2026-09-13 起改在宿主侧构建期完成，本类里的 loadAndInjectMemories 不再被调用。
   * 若不回填快照，两个消费者会静默失效：UI 的「本轮注入了什么」与效用观测。
   * （2026-09-17 真实库实测：注入在发生，但 memory_usage_feedback 恒 0 行。）
   */
  describe("注入快照回填（setInjectedSnapshot）", () => {
    it("宿主回填后，效用观测能读到该快照", () => {
      const recordInjectionOutcome = vi.fn(() => 2);
      const manager = makeManager({ recordInjectionOutcome });
      const { deps } = makeDeps(
        [userMsg("我们聊聊 pnpm"), assistantMsg("好的，后续安装依赖统一用 pnpm。")],
        manager,
      );
      const mi = new MemoryIntegration(deps);
      mi.setInjectedSnapshot([fakeMemory("用户偏好用 pnpm 而不是 npm")]);

      expect(mi.injectedSnapshot).toHaveLength(1);
      mi.recordInjectionOutcome();

      expect(recordInjectionOutcome).toHaveBeenCalledOnce();
      const [entries, reply, sessionId] = recordInjectionOutcome.mock.calls[0]!;
      expect(entries).toHaveLength(1);
      expect(reply).toContain("pnpm");
      expect(sessionId).toBe("test");
    });

    it("快照为空时不做观测（不产生无源反馈）", () => {
      const recordInjectionOutcome = vi.fn(() => 0);
      const manager = makeManager({ recordInjectionOutcome });
      const { deps } = makeDeps([userMsg("q"), assistantMsg("a")], manager);

      new MemoryIntegration(deps).recordInjectionOutcome();

      expect(recordInjectionOutcome).not.toHaveBeenCalled();
    });

    it("clearInjectedSnapshot 之后快照为空，观测不再触发", () => {
      const recordInjectionOutcome = vi.fn(() => 1);
      const manager = makeManager({ recordInjectionOutcome });
      const { deps } = makeDeps([userMsg("q"), assistantMsg("a")], manager);
      const mi = new MemoryIntegration(deps);
      mi.setInjectedSnapshot([fakeMemory("某条记忆")]);

      mi.clearInjectedSnapshot();
      mi.recordInjectionOutcome();

      expect(mi.injectedSnapshot).toHaveLength(0);
      expect(recordInjectionOutcome).not.toHaveBeenCalled();
    });

    it("无助手回复时不观测（没有比对文本）", () => {
      const recordInjectionOutcome = vi.fn(() => 1);
      const manager = makeManager({ recordInjectionOutcome });
      const { deps } = makeDeps([userMsg("只有用户消息")], manager);
      const mi = new MemoryIntegration(deps);
      mi.setInjectedSnapshot([fakeMemory("某条记忆")]);

      mi.recordInjectionOutcome();

      expect(recordInjectionOutcome).not.toHaveBeenCalled();
    });
  });
});
