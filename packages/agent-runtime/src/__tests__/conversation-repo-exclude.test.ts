/**
 * loadMessagesAsPiFormat 的 excludeMessageId 排除逻辑测试
 *
 * 回归保护：修复"用户消息被重复注入"bug。
 * 用户消息在 prompt 前已存 DB，恢复历史时若不排除它，会与 instance.prompt()
 * 追加的同一条消息重复（表现为 [user "你好", user "你好"]）。
 */

import { describe, it, expect } from "vitest";
import type { DatabaseAdapter, PreparedStatement, StatementResult } from "../storage/local-database.js";
import { ConversationRepo, type MessageRow } from "../storage/conversation-repo.js";

/** 构造一个 all() 返回固定行的 mock db，用于验证 JS 层过滤逻辑 */
function createRowsMockDb(rows: readonly MessageRow[]): DatabaseAdapter {
  return {
    exec() {},
    prepare<T = Record<string, unknown>>(): PreparedStatement<T> {
      return {
        run(): StatementResult {
          return { changes: 0, lastInsertRowid: 0 };
        },
        get(): T | undefined {
          return undefined;
        },
        all(): T[] {
          return rows as unknown as T[];
        },
      };
    },
    close() {},
  };
}

function row(id: string, role: "user" | "assistant", text: string): MessageRow {
  return {
    id,
    conversation_id: "conv-1",
    agent_id: null,
    role,
    content_json: JSON.stringify({ type: "text", text }),
    is_proactive: 0,
    timestamp: new Date().toISOString(),
    is_streaming: 0,
  };
}

const sampleRows: readonly MessageRow[] = [
  row("m1", "user", "你好"),
  row("m2", "assistant", "你好！有什么可以帮你的吗？"),
  row("m3", "user", "你好"), // 本轮待处理消息：已先存 DB
];

describe("loadMessagesAsPiFormat excludeMessageId", () => {
  it("不传 excludeMessageId 时返回全部消息", () => {
    const repo = new ConversationRepo(createRowsMockDb(sampleRows));
    const msgs = repo.loadMessagesAsPiFormat("conv-1");
    expect(msgs).toHaveLength(3);
  });

  it("传 excludeMessageId 时排除该条，避免与 prompt() 重复注入", () => {
    const repo = new ConversationRepo(createRowsMockDb(sampleRows));
    const msgs = repo.loadMessagesAsPiFormat("conv-1", { excludeMessageId: "m3" });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("excludeMessageId 不匹配任何行时不影响结果", () => {
    const repo = new ConversationRepo(createRowsMockDb(sampleRows));
    const msgs = repo.loadMessagesAsPiFormat("conv-1", { excludeMessageId: "not-exist" });
    expect(msgs).toHaveLength(3);
  });
});
