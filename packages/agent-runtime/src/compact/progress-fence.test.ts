import { describe, it, expect, vi } from "vitest";
import { ProgressFence, withProgressTimeout } from "./progress-fence.js";

describe("ProgressFence - Phase 2: 双预算 + touch续命", () => {
  it("touchProgress 续命：每 5s 调一次，200s 后 shouldKeepAlive()=true", () => {
    vi.useFakeTimers();
    const fence = new ProgressFence(120_000, 600_000);

    // 循环 40 次，每次 advance 5s 并 touch
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(5000);
      fence.touchProgress();
    }
    // 200s 后，远超 idle=120s 但仍活着
    expect(fence.shouldKeepAlive()).toBe(true);
    vi.useRealTimers();
  });

  it("停止 touch 后 121s 超时死亡", () => {
    vi.useFakeTimers();
    const fence = new ProgressFence(120_000, 600_000);
    fence.touchProgress();
    vi.advanceTimersByTime(121_000);
    expect(fence.shouldKeepAlive()).toBe(false);
    vi.useRealTimers();
  });

  it("ceiling 600s 绝对封顶：哪怕每 5s touch，601s 后必须死", () => {
    vi.useFakeTimers();
    const fence = new ProgressFence(120_000, 600_000);
    for (let i = 0; i < 121; i++) {
      // 121次 * 5s = 605s
      vi.advanceTimersByTime(5000);
      fence.touchProgress();
    }
    expect(fence.shouldKeepAlive()).toBe(false);
    vi.useRealTimers();
  });

  it("nextWaitSliceMs 在 1s/10ms 量级收敛", () => {
    vi.useFakeTimers();
    const fence = new ProgressFence(120_000, 600_000);
    fence.touchProgress();
    vi.advanceTimersByTime(119_000); // 到 119s，剩余 idle 1s
    const slice1 = fence.nextWaitSliceMs();
    expect(slice1).toBeLessThanOrEqual(1000);
    expect(slice1).toBeGreaterThanOrEqual(5); // 最小 5ms
    vi.useRealTimers();
  });
});

describe("withProgressTimeout - Phase 2", () => {
  it("在 fence.touch 时成功续命不超时", async () => {
    vi.useFakeTimers();
    const fence = new ProgressFence(120_000, 600_000);
    const result = await withProgressTimeout(fence, async (f) => {
      // 模拟每 5s touch 一次，总耗时 200s
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(5000);
        f.touchProgress();
      }
      return "success";
    });
    expect(result).toBe("success");
    vi.useRealTimers();
  });

  it("在 121s 无 touch 时超时返回 null", async () => {
    vi.useFakeTimers();
    const fence = new ProgressFence(120_000, 600_000);
    const result = await withProgressTimeout(fence, async () => {
      await vi.advanceTimersByTimeAsync(121_000);
      // 永不 resolve
      return new Promise<string>(() => {});
    });
    expect(result).toBe(null);
    vi.useRealTimers();
  });
});
