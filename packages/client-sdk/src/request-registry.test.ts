import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestRegistry } from "./request-registry.js";

describe("createRequestRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("生成唯一 id", () => {
    const reg = createRequestRegistry();
    const ids = new Set(Array.from({ length: 1000 }, () => reg.createId()));
    expect(ids.size).toBe(1000);
  });

  it("可注入自定义 id 生成器", () => {
    let n = 0;
    const reg = createRequestRegistry({ createId: () => `x-${++n}` });
    expect(reg.createId()).toBe("x-1");
    expect(reg.createId()).toBe("x-2");
  });

  it("settle(ok=true) 兑现 register 的 Promise 并清表", async () => {
    const reg = createRequestRegistry();
    const id = reg.createId();
    const p = reg.register(id, { timeoutMs: 1000 });
    expect(reg.size).toBe(1);

    expect(reg.settle(id, true, { value: 42 })).toBe(true);
    await expect(p).resolves.toEqual({ value: 42 });
    expect(reg.size).toBe(0);
  });

  it("settle(ok=false) 用 Error 实例 reject", async () => {
    const reg = createRequestRegistry();
    const id = reg.createId();
    const p = reg.register(id, { timeoutMs: 1000 });
    const err = new Error("boom");

    reg.settle(id, false, err);
    await expect(p).rejects.toBe(err);
    expect(reg.size).toBe(0);
  });

  it("settle(ok=false) 把非 Error 包装成 Error", async () => {
    const reg = createRequestRegistry();
    const id = reg.createId();
    const p = reg.register(id, { timeoutMs: 1000 });

    reg.settle(id, false, "string failure");
    await expect(p).rejects.toThrow("string failure");
  });

  it("settle 未知 id 返回 false 且不抛错", () => {
    const reg = createRequestRegistry();
    expect(reg.settle("nope", true, {})).toBe(false);
  });

  it("超时后自动 reject 并清表", async () => {
    const reg = createRequestRegistry();
    const id = reg.createId();
    const p = reg.register(id, { timeoutMs: 5000, method: "chat.send" });

    const assertion = expect(p).rejects.toThrow("Request timeout: chat.send");
    vi.advanceTimersByTime(5000);
    await assertion;
    expect(reg.size).toBe(0);
  });

  it("自定义超时错误工厂生效", async () => {
    const reg = createRequestRegistry();
    const id = reg.createId();
    const p = reg.register(id, {
      timeoutMs: 1000,
      method: "m",
      onTimeoutError: (rid, method) => new Error(`custom ${method} ${rid}`),
    });

    const assertion = expect(p).rejects.toThrow(`custom m ${id}`);
    vi.advanceTimersByTime(1000);
    await assertion;
  });

  it("settle 后超时不再触发（定时器已清）", async () => {
    const reg = createRequestRegistry();
    const id = reg.createId();
    const p = reg.register(id, { timeoutMs: 1000 });

    reg.settle(id, true, "done");
    await expect(p).resolves.toBe("done");

    // 推进时间，不应有未捕获的 reject
    vi.advanceTimersByTime(5000);
    expect(reg.size).toBe(0);
  });

  it("track 登记外部构造的 pending，可被 settle 兑现并触发副作用", async () => {
    const reg = createRequestRegistry();
    const id = reg.createId();
    let sideEffect = false;

    const p = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 1000);
      reg.track(id, {
        resolve: (value) => {
          sideEffect = true;
          resolve(value);
        },
        reject,
        timeout,
      });
    });
    expect(reg.size).toBe(1);

    reg.settle(id, true, "ok");
    await expect(p).resolves.toBe("ok");
    expect(sideEffect).toBe(true);
    expect(reg.size).toBe(0);
    vi.advanceTimersByTime(5000);
  });

  it("track 的 pending 也会被 rejectAll 拒绝", async () => {
    const reg = createRequestRegistry();
    const id = reg.createId();
    const p = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 1000);
      reg.track(id, { resolve, reject, timeout });
    });

    const err = new Error("Connection closed");
    reg.rejectAll(err);
    await expect(p).rejects.toBe(err);
    expect(reg.size).toBe(0);
    vi.advanceTimersByTime(5000);
  });
});
