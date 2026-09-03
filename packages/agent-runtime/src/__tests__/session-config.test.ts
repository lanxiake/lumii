/**
 * 会话级配置：合并规则与读写
 *
 * 核心语义：全局启用 且 会话未禁用 = 生效。全局关闭时会话级无法翻回启用。
 */

import { describe, it, expect } from "vitest";
import {
  isEnabledForSession,
  filterEnabledForSession,
  readSessionConfig,
  patchSessionConfig,
  clearInvalidSessionPreferredModels,
  toggleSessionDisabled,
} from "../storage/session-config.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

function seedDb(): { db: ReturnType<typeof createMigratedTestDb>; convId: string } {
  const db = createMigratedTestDb();
  const convId = "conv-session-config";
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
     VALUES (?, 'local-user', 'direct', 'test', 1, ?)`,
  ).run(convId, new Date().toISOString());
  return { db, convId };
}

describe("isEnabledForSession — 全局与会话的合并", () => {
  it("全局启用且会话未禁用 → 生效", () => {
    expect(isEnabledForSession(true, [], "ynote")).toBe(true);
    expect(isEnabledForSession(true, undefined, "ynote")).toBe(true);
  });

  it("全局启用但会话禁用 → 不生效", () => {
    expect(isEnabledForSession(true, ["ynote"], "ynote")).toBe(false);
  });

  it("全局禁用时会话级无法翻回启用", () => {
    expect(isEnabledForSession(false, [], "ynote")).toBe(false);
    expect(isEnabledForSession(false, undefined, "ynote")).toBe(false);
  });
});

describe("filterEnabledForSession", () => {
  const tools = [{ name: "mcp__ynote__create" }, { name: "mcp__fs__read" }];

  it("空禁用集时原样返回全部条目", () => {
    expect(filterEnabledForSession(tools, undefined, (t) => t.name)).toHaveLength(2);
    expect(filterEnabledForSession(tools, [], (t) => t.name)).toHaveLength(2);
  });

  it("按名字剔除会话禁用项", () => {
    const out = filterEnabledForSession(tools, ["mcp__ynote__create"], (t) => t.name);
    expect(out.map((t) => t.name)).toEqual(["mcp__fs__read"]);
  });
});

describe("readSessionConfig / patchSessionConfig", () => {
  it("无记录时返回空配置", () => {
    const { db, convId } = seedDb();
    expect(readSessionConfig(db, convId)).toEqual({});
  });

  it("不存在的会话 id 返回空配置而非抛错", () => {
    const { db } = seedDb();
    expect(readSessionConfig(db, "nope")).toEqual({});
  });

  it("JSON 损坏时降级为空配置，不阻断会话", () => {
    const { db, convId } = seedDb();
    db.prepare("UPDATE conversations SET session_config = ? WHERE id = ?").run("{broken", convId);
    expect(readSessionConfig(db, convId)).toEqual({});
  });

  it("patch 增量合并，保留未涉及的字段", () => {
    const { db, convId } = seedDb();
    patchSessionConfig(db, convId, { preferredModel: "MiniMax-M2.7" });
    patchSessionConfig(db, convId, { disabledSkills: ["art"] });
    expect(readSessionConfig(db, convId)).toEqual({
      preferredModel: "MiniMax-M2.7",
      disabledSkills: ["art"],
    });
  });

  it("patch 传 undefined 删除该键", () => {
    const { db, convId } = seedDb();
    patchSessionConfig(db, convId, { preferredModel: "m1", disabledSkills: ["art"] });
    patchSessionConfig(db, convId, { preferredModel: undefined });
    expect(readSessionConfig(db, convId)).toEqual({ disabledSkills: ["art"] });
  });

  it("clears model overrides that are unavailable from the active provider", () => {
    const { db, convId } = seedDb();
    const validConvId = "conv-valid-model";
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, is_active, created_at)
       VALUES (?, 'local-user', 'direct', 'valid', 1, ?)`,
    ).run(validConvId, new Date().toISOString());

    patchSessionConfig(db, convId, {
      preferredModel: "qwen3.8-27b",
      disabledSkills: ["art"],
    });
    patchSessionConfig(db, validConvId, { preferredModel: "gpt-5.6-luna" });

    expect(clearInvalidSessionPreferredModels(db, ["gpt-5.6-luna"])).toBe(1);
    expect(readSessionConfig(db, convId)).toEqual({ disabledSkills: ["art"] });
    expect(readSessionConfig(db, validConvId)).toEqual({ preferredModel: "gpt-5.6-luna" });
  });
});

describe("toggleSessionDisabled", () => {
  it("禁用后再启用回到空集，且重复禁用不产生重复项", () => {
    const { db, convId } = seedDb();

    expect(toggleSessionDisabled(db, convId, "disabledMcpServers", "ynote", true)).toEqual(["ynote"]);
    // 重复禁用应幂等
    expect(toggleSessionDisabled(db, convId, "disabledMcpServers", "ynote", true)).toEqual(["ynote"]);
    expect(toggleSessionDisabled(db, convId, "disabledMcpServers", "ynote", false)).toEqual([]);
  });

  it("不同字段互不干扰", () => {
    const { db, convId } = seedDb();
    toggleSessionDisabled(db, convId, "disabledMcpServers", "ynote", true);
    toggleSessionDisabled(db, convId, "disabledSkills", "art", true);
    const cfg = readSessionConfig(db, convId);
    expect(cfg.disabledMcpServers).toEqual(["ynote"]);
    expect(cfg.disabledSkills).toEqual(["art"]);
  });
});
