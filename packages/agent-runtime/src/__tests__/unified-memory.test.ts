/**
 * S8 统一注入块单测：formatUnifiedMemoryBlock
 */

import { describe, it, expect } from "vitest";
import { formatUnifiedMemoryBlock } from "../memory/memory-injector.js";
import type { MemoryEntry, MemoryCategory } from "../memory/types.js";

function mem(content: string, category: MemoryCategory): MemoryEntry {
  return {
    id: "m-" + Math.random().toString(36).slice(2),
    agent_id: "a1",
    user_id: "u1",
    category,
    content,
    importance: 0.5,
    tags: [],
    source_message_id: null,
    created_at: "2026-01-01",
    last_used: "2026-01-01",
    use_count: 0,
    is_archived: false,
  };
}

describe("formatUnifiedMemoryBlock", () => {
  it("全空返回空串", () => {
    expect(formatUnifiedMemoryBlock(undefined, [])).toBe("");
  });

  it("只有一个 ## 记忆 块（不再分散多段）", () => {
    const out = formatUnifiedMemoryBlock("用户叫张三，喜欢简洁回复", [
      mem("用户计划去日本旅行", "project"),
    ]);
    expect((out.match(/## 记忆/g) ?? []).length).toBe(1);
    // 旧的独立顶级段标题不再出现（精确匹配行首 "## "，不误伤 "### 关于用户"）
    expect(/(?:^|\n)## 关于用户/.test(out)).toBe(false);
    expect(/(?:^|\n)## 你的记忆/.test(out)).toBe(false);
  });

  it("含关于用户层（Markdown 画像）", () => {
    const out = formatUnifiedMemoryBlock("用户叫张三", []);
    expect(out).toContain("### 关于用户");
    expect(out).toContain("用户叫张三");
  });

  it("含相关记忆层（SQLite，按类别小标签分组）", () => {
    const out = formatUnifiedMemoryBlock(undefined, [
      mem("用户计划去日本旅行", "project"),
      mem("用户常用 Notion", "reference"),
    ]);
    expect(out).toContain("### 工作记忆（当前任务与资源）");
    expect(out).toContain("**进行中的事**");
    expect(out).toContain("**外部资源**");
  });

  it("相关记忆按 limit 截断", () => {
    const mems = Array.from({ length: 12 }, (_, i) => mem(`记忆${i}`, "general"));
    const out = formatUnifiedMemoryBlock(undefined, mems, { related: 3 });
    const count = (out.match(/- 记忆\d+/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("仅画像无 SQLite 记忆时不输出工作记忆层", () => {
    const out = formatUnifiedMemoryBlock("用户叫张三", []);
    expect(out).not.toContain("### 工作记忆");
  });
});
