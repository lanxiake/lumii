/**
 * P0-5 幽灵清理：提示词不再指向不存在的工具，个人记忆候选不再静默消失。
 *
 * 两条都是「提示词许了愿、代码没兑现」的实例（评审 §2.4.4）：
 * 1. `memory_store` 被记忆指南与分层架构表告知模型「这是记忆宫殿的写入方式」，
 *    但全仓库没有这个工具的定义，MemPalace MCP 客户端也未暴露它。模型被引向一个调不通的工具。
 * 2. `writeCandidatesMerged` 在没有 `onPersonalMemoryExtracted` 回调时把 user/feedback
 *    候选直接丢掉——无日志、且仍计入返回值，让「记忆没长出来」在日志里完全不可见。
 */
import { describe, it, expect, vi } from "vitest";
import { MemoryManager } from "../manager.js";
import { AgentMemoryRepo } from "../memory-repo.js";
import { MEMORY_LAYERS } from "../memory-architecture.js";
import { MEMORY_GUIDE_CONTENT } from "../../prompt/guides/memory-guide.js";
import { createMigratedTestDb } from "../../__tests__/helpers/sqlite-test-db.js";

const A = "assistant";
const U = "local-user";

describe("P0-5 提示词不再引用 memory_store", () => {
  it("记忆分层架构表的宫殿写入方不含 memory_store", () => {
    const palace = MEMORY_LAYERS.find((l) => l.id === "palace")!;
    expect(palace.writeTools.join(",")).not.toContain("memory_store");
    expect(palace.writeTools.join(",")).toContain("段落管线");
  });

  it("记忆指南全文不含 memory_store", () => {
    expect(MEMORY_GUIDE_CONTENT).not.toContain("memory_store");
  });

  it("记忆指南如实说明宫殿没有面向模型的写入工具", () => {
    expect(MEMORY_GUIDE_CONTENT).toContain("没有写入工具");
  });
});

describe("P0-5 个人记忆候选不再静默丢弃", () => {
  it("无回调时告警，且不计入返回值", () => {
    const db = createMigratedTestDb();
    const manager = new MemoryManager(new AgentMemoryRepo(db)); // 不注入 onPersonalMemoryExtracted
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const n = manager.saveRuleExtractedCandidates(["我叫李明"], A, U);

    expect(n).toBe(0); // 候选无处可写，不能声称存下了
    expect(warn.mock.calls.some((c) => String(c[0]).includes("丢弃 1 条个人记忆候选"))).toBe(true);
    warn.mockRestore();
  });

  it("有回调时正常转交并计入返回值", () => {
    const db = createMigratedTestDb();
    const received: unknown[] = [];
    const manager = new MemoryManager(new AgentMemoryRepo(db), {
      onPersonalMemoryExtracted: (c) => received.push(...c),
    });

    const n = manager.saveRuleExtractedCandidates(["我叫李明"], A, U);

    expect(n).toBe(1);
    expect(received).toHaveLength(1);
    expect((received[0] as { content: string }).content).toContain("李明");
  });
});
