import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReadBeforeWriteHook } from "../hooks/read-before-write-hook.js";
import { getFileStateCache, _clearFileStateRegistry } from "../file-state-cache.js";
import { computeFileHash } from "../file-hash.js";
import type { ToolHookContext } from "../tool-hooks.js";

const hook = createReadBeforeWriteHook();
const hookWithHashFallback = createReadBeforeWriteHook({ enableMtimeHashFallback: true });
const INST = "test-instance";

let dir: string;

function makeCtx(toolName: string, params: Record<string, unknown>): ToolHookContext {
  return {
    toolCallId: "tc",
    toolName,
    category: "filesystem",
    isReadOnly: false,
    needsPermission: true,
    params: Object.freeze(params),
    context: { instanceId: INST } as never,
    startTime: Date.now(),
    meta: {},
  };
}

beforeEach(() => {
  _clearFileStateRegistry();
  dir = mkdtempSync(path.join(tmpdir(), "rbw-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("read-before-write hook", () => {
  it("已存在文件未被 Read → 拒绝", async () => {
    const fp = path.join(dir, "a.txt");
    writeFileSync(fp, "hello");
    const out = await hook.beforeExecute!(makeCtx("file_edit", { filePath: fp }));
    expect(out).toBeDefined();
    expect((out as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(out)).toContain("未被 file_read 读取过");
  });

  it("新文件（不存在）→ 放行", async () => {
    const fp = path.join(dir, "new.txt");
    const out = await hook.beforeExecute!(makeCtx("file_write", { filePath: fp }));
    expect(out).toBeUndefined();
  });

  it("file_write append 模式 → 放行（即使未读）", async () => {
    const fp = path.join(dir, "b.txt");
    writeFileSync(fp, "x");
    const out = await hook.beforeExecute!(
      makeCtx("file_write", { filePath: fp, mode: "append" }),
    );
    expect(out).toBeUndefined();
  });

  it("Read 后 mtime 未变 → 放行", async () => {
    const fp = path.join(dir, "c.txt");
    writeFileSync(fp, "data");
    const mtimeMs = Math.floor(statSync(fp).mtimeMs);
    getFileStateCache(INST).set(fp, { mtimeMs, offset: 1, limit: 500, isPartialView: false });
    const out = await hook.beforeExecute!(makeCtx("file_edit", { filePath: fp }));
    expect(out).toBeUndefined();
  });

  it("Read 后 mtime 漂移（外部修改）→ 拒绝", async () => {
    const fp = path.join(dir, "d.txt");
    writeFileSync(fp, "v1");
    const oldMtime = Math.floor(statSync(fp).mtimeMs);
    getFileStateCache(INST).set(fp, { mtimeMs: oldMtime, offset: 1, limit: 500 });
    // 人为把磁盘 mtime 往后推 5 秒
    const future = new Date(Date.now() + 5000);
    utimesSync(fp, future, future);
    const out = await hook.beforeExecute!(makeCtx("file_write", { filePath: fp }));
    expect(out).toBeDefined();
    expect((out as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(out)).toContain("被外部修改");
  });

  it("afterExecute 写成功后回写 mtime → 连续二次 edit 第二次放行", async () => {
    const fp = path.join(dir, "e.txt");
    writeFileSync(fp, "init");
    const mtimeMs = Math.floor(statSync(fp).mtimeMs);
    getFileStateCache(INST).set(fp, { mtimeMs, offset: 1, limit: 500, isPartialView: false });

    // 第一次 edit 通过
    expect(await hook.beforeExecute!(makeCtx("file_edit", { filePath: fp }))).toBeUndefined();

    // 模拟写入改了文件内容与 mtime
    const future = new Date(Date.now() + 3000);
    writeFileSync(fp, "edited");
    utimesSync(fp, future, future);

    // afterExecute 回写最新 mtime
    await hook.afterExecute!({
      ...makeCtx("file_edit", { filePath: fp }),
      result: { content: [] },
      isError: false,
      durationMs: 1,
    } as never);

    // 第二次 edit 不应被自身拦截
    const out2 = await hook.beforeExecute!(makeCtx("file_edit", { filePath: fp }));
    expect(out2).toBeUndefined();
  });

  describe("P1-1: Windows mtime 哈希回退", () => {
    it("flag 开启 + mtime 漂移但内容哈希匹配 → 放行", async () => {
      const fp = path.join(dir, "h1.txt");
      const content = "stable content";
      writeFileSync(fp, content);
      const oldMtime = Math.floor(statSync(fp).mtimeMs);
      // 记录 Read 时的 contentHash（内容未变）
      getFileStateCache(INST).set(fp, {
        mtimeMs: oldMtime,
        offset: 1,
        limit: 500,
        contentHash: computeFileHash(content),
      });
      // 仅 mtime 抖动（内容不变）
      const future = new Date(Date.now() + 5000);
      utimesSync(fp, future, future);

      const out = await hookWithHashFallback.beforeExecute!(makeCtx("file_edit", { filePath: fp }));
      expect(out).toBeUndefined(); // 哈希匹配 → 放行
    });

    it("flag 开启 + mtime 漂移且内容已变 → 仍拒绝", async () => {
      const fp = path.join(dir, "h2.txt");
      writeFileSync(fp, "original");
      const oldMtime = Math.floor(statSync(fp).mtimeMs);
      getFileStateCache(INST).set(fp, {
        mtimeMs: oldMtime,
        offset: 1,
        limit: 500,
        contentHash: computeFileHash("original"),
      });
      // 内容真实改变 + mtime 漂移
      const future = new Date(Date.now() + 5000);
      writeFileSync(fp, "modified externally");
      utimesSync(fp, future, future);

      const out = await hookWithHashFallback.beforeExecute!(makeCtx("file_write", { filePath: fp }));
      expect(out).toBeDefined();
      expect((out as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(out)).toContain("被外部修改");
    });

    it("flag 关闭（默认）+ mtime 漂移即使哈希匹配 → 仍拒绝", async () => {
      const fp = path.join(dir, "h3.txt");
      const content = "same";
      writeFileSync(fp, content);
      const oldMtime = Math.floor(statSync(fp).mtimeMs);
      getFileStateCache(INST).set(fp, {
        mtimeMs: oldMtime,
        offset: 1,
        limit: 500,
        contentHash: computeFileHash(content),
      });
      const future = new Date(Date.now() + 5000);
      utimesSync(fp, future, future);

      const out = await hook.beforeExecute!(makeCtx("file_edit", { filePath: fp }));
      expect(out).toBeDefined();
      expect((out as { isError?: boolean }).isError).toBe(true);
    });
  });
});
