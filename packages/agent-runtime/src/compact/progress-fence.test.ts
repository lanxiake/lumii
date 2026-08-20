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

describe("ProgressFence - Phase 3: 原子提交期（Commit Fence）", () => {
  it("beginCommit → commitInFlight=true；finishCommit → 变 false", () => {
    const fence = new ProgressFence();
    expect(fence.commitInFlight).toBe(false);
    expect(fence.beginCommit()).toBe(true);
    expect(fence.commitInFlight).toBe(true);
    fence.finishCommit();
    expect(fence.commitInFlight).toBe(false);
  });

  it("revoke 赢了 race：先 revoke 再 begin → begin 返回 false，DB 写入不执行", () => {
    const fence = new ProgressFence();
    fence.revokeCommitAdmission();
    expect(fence.beginCommit()).toBe(false);
    expect(fence.commitInFlight).toBe(false);
  });

  it("cancelBeforeCommit 赢了 race → begin 拿不到入场权", () => {
    const fence = new ProgressFence();
    expect(fence.cancelBeforeCommit()).toBe(true);
    expect(fence.beginCommit()).toBe(false);
  });

  it("begin 已在飞 → cancel 输 race；revoke 不打断当前提交但禁止后续", () => {
    const fence = new ProgressFence();
    expect(fence.beginCommit()).toBe(true);
    // 已经开始写 DB → cancel 输了
    expect(fence.cancelBeforeCommit()).toBe(false);
    fence.revokeCommitAdmission();
    // 当前提交不受影响
    expect(fence.commitInFlight).toBe(true);
    fence.finishCommit();
    // 后续新提交被禁止
    expect(fence.beginCommit()).toBe(false);
  });

  it("begin/finish 配对 10 次不泄漏：最终 commitInFlight=false", () => {
    const fence = new ProgressFence();
    for (let i = 0; i < 10; i++) {
      expect(fence.beginCommit()).toBe(true);
      fence.finishCommit();
    }
    expect(fence.commitInFlight).toBe(false);
  });
});

describe("withProgressTimeout - Phase 3: commit-in-flight 永不中断", () => {
  it("ceiling 到了但 commitInFlight=true → 不返回 null，分段续等直到提交完成", async () => {
    vi.useFakeTimers();
    const fence = new ProgressFence(120_000, 600_000);
    const logger = { warn: vi.fn(), error: vi.fn() };

    let release!: (v: string) => void;
    const pending = new Promise<string>((r) => {
      release = r;
    });

    const task = withProgressTimeout(
      fence,
      async (f) => {
        f.beginCommit();
        return pending;
      },
      logger,
    );

    // 推进到远超 ceiling（1000s），期间不允许返回 null
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(logger.warn.mock.calls.length + logger.error.mock.calls.length).toBeGreaterThan(0);

    // DB 终于回来 → 正常拿到结果，而不是被杀
    release("committed");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(task).resolves.toBe("committed");
    vi.useRealTimers();
  });

  it("commit overrun 日志升级：前 2 次 WARNING，第 3 次起 ERROR", async () => {
    vi.useFakeTimers();
    const fence = new ProgressFence(1_000, 2_000);
    const logger = { warn: vi.fn(), error: vi.fn() };

    let release!: (v: string) => void;
    const pending = new Promise<string>((r) => {
      release = r;
    });

    const task = withProgressTimeout(
      fence,
      async (f) => {
        f.beginCommit();
        return pending;
      },
      logger,
    );

    // ceiling 2s 后进入 overrun，每 30s 一段报一次
    await vi.advanceTimersByTimeAsync(2_000 + 30_000 * 3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls.length).toBeGreaterThanOrEqual(1);

    release("done");
    await vi.advanceTimersByTimeAsync(30_000);
    await task;
    vi.useRealTimers();
  });

  it("finally 撤销未来入场权：超时返回后 worker 再调 beginCommit 拿不到权限", async () => {
    vi.useFakeTimers();
    const fence = new ProgressFence(120_000, 600_000);
    const result = await withProgressTimeout(fence, async () => {
      await vi.advanceTimersByTimeAsync(121_000);
      return new Promise<string>(() => {});
    });
    expect(result).toBe(null);
    // detached worker 事后想偷偷写 DB → 被拒
    expect(fence.beginCommit()).toBe(false);
    vi.useRealTimers();
  });
});
