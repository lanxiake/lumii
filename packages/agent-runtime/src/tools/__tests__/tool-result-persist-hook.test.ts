import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolResultPersistHook } from "../hooks/tool-result-persist-hook.js";
import type { ToolHookResultContext } from "../tool-hooks.js";

let dir: string;

function resultCtx(
  toolName: string,
  text: string,
  isError = false,
): ToolHookResultContext {
  return {
    toolCallId: "tc",
    toolName,
    category: "shell",
    isReadOnly: false,
    needsPermission: false,
    params: Object.freeze({}),
    context: { instanceId: "inst" } as never,
    startTime: Date.now(),
    meta: {},
    result: { content: [{ type: "text", text }], details: undefined },
    isError,
    durationMs: 1,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "trph-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("tool-result-persist hook", () => {
  it("短结果 → 不改写", async () => {
    const hook = createToolResultPersistHook({ baseDir: dir, threshold: 100 });
    const out = await hook.afterExecute!(resultCtx("bash", "short"));
    expect(out).toBeUndefined();
  });

  it("超长结果 → 落盘并改写为预览", async () => {
    const hook = createToolResultPersistHook({ baseDir: dir, threshold: 100, previewLength: 30 });
    const longText = "x".repeat(500);
    const out = await hook.afterExecute!(resultCtx("bash", longText));
    expect(out).toBeDefined();
    const content = (out as { content: { type: string; text: string }[] }).content;
    expect(content[0].text).toContain("输出过长");
    expect(content[0].text.length).toBeLessThan(longText.length);
    // 落盘文件存在
    const match = content[0].text.match(/落盘到：(.+\.txt)/);
    expect(match).not.toBeNull();
    expect(existsSync(match![1].trim())).toBe(true);
  });

  it("错误结果 → 不落盘", async () => {
    const hook = createToolResultPersistHook({ baseDir: dir, threshold: 100 });
    const out = await hook.afterExecute!(resultCtx("bash", "x".repeat(500), true));
    expect(out).toBeUndefined();
  });

  it("非文本内容（空 content）→ 不改写", async () => {
    const hook = createToolResultPersistHook({ baseDir: dir, threshold: 100 });
    const ctx = resultCtx("bash", "");
    ctx.result = { content: [], details: undefined };
    const out = await hook.afterExecute!(ctx);
    expect(out).toBeUndefined();
  });
});
