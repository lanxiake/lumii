/**
 * vcs-snapshot 队列单测：队列深度可观测 + 排队中的重复快照合并。
 *
 * 背景（2026-09-17 P0）：多 Agent 并行时同一工作区堆了 14 个待执行快照，
 * 每个要跑 30–80 秒（1977 个文件逐个 `git.add`），把**共用同一条串行队列**的
 * 云同步堵到分钟级 —— 表现为设置页「立即同步」按钮一直转圈、状态栏却显示
 * 上一次的「同步完成」。快照提交的是「执行那一刻」的树，同一时刻排队的多个
 * 请求看到的是同一棵，因此排队中的可以合并成一个。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enqueueSyncMaintenance, enqueueWorkspace, getWorkspaceQueueDepth, getWorkspaceVcs, maybeSnapshot } from "./vcs-snapshot";

describe("vcs-snapshot 队列", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-snapq-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("队列深度可观测：空队列为 0，被占用时为 1", async () => {
    expect(getWorkspaceQueueDepth(dir)).toBe(0);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blocked = enqueueWorkspace(dir, () => gate, "test:blocker");
    expect(getWorkspaceQueueDepth(dir)).toBe(1);

    release();
    await blocked;
    expect(getWorkspaceQueueDepth(dir)).toBe(0);
  });

  it("同一 tick 内连发的快照请求合并成一个队列任务", async () => {
    // 先触发初始化（ensureInitialized 的首个 commit 会先做一次 stageAll），
    // 再写文件 —— 否则内容已被初始化提交收走，后续快照会判「无变更」而返回 null
    await getWorkspaceVcs(dir).hasUncommittedChanges()
    fs.writeFileSync(path.join(dir, "a.txt"), "v1");

    // 5 次请求都发生在第一个任务开始执行之前 → 全部落在「排队中」，可合并
    const ps = [1, 2, 3, 4, 5].map((n) =>
      maybeSnapshot({ workspaceDir: dir, runId: `r${n}`, conversationId: `c${n}` }),
    );

    // 关键断言：只占 1 个队列位（未合并时这里是 5，正是 P0 的成因）
    expect(getWorkspaceQueueDepth(dir)).toBe(1);
    // 后来者复用的是同一次快照，返回同一个 promise
    expect(ps[1]).toBe(ps[0]);
    expect(ps[4]).toBe(ps[0]);

    const results = await Promise.all(ps);
    // 合并不能把变更弄丢：这一次依然要真的提交
    expect(results[0]).not.toBeNull();
    // 且只提交一次
    expect(new Set(results.map((r) => r?.oid)).size).toBe(1);
    expect(getWorkspaceQueueDepth(dir)).toBe(0);
  });

  // sync 仓库维护（目前是 maybePruneObjectStore 的 git gc）曾与 Turn 快照争同一条队列。
  // 2026-09-19 实测：一次 gc 占住 222 秒，期间所有工作区快照排队等待 —— 用户侧就是
  // 「客户端不动了」。它不读也不写工作区，凭什么堵住快照？改成独立队列。
  it("sync 维护任务不阻塞工作区队列（gc 曾占 222 秒把快照全堵住）", async () => {
    const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-syncmaint-"));
    try {
      let releaseGc!: () => void
      const gcGate = new Promise<void>((r) => { releaseGc = r })
      const gc = enqueueSyncMaintenance(syncDir, () => gcGate, "test:gc")

      // 维护任务正在跑（且永不主动结束）—— 工作区队列必须完全不受影响
      let ran = false
      await enqueueWorkspace(dir, async () => { ran = true }, "test:quick")
      expect(ran).toBe(true)
      // 工作区队列的深度里不该看见维护任务
      expect(getWorkspaceQueueDepth(dir)).toBe(0)

      releaseGc()
      await gc
    } finally {
      fs.rmSync(syncDir, { recursive: true, force: true })
    }
  })

  it("sync 维护队列自身串行（避免两次 gc 撞同一个 objects 目录）", async () => {    const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-syncmaint2-"));
    try {
      const order: string[] = []
      let releaseFirst!: () => void
      const gate = new Promise<void>((r) => { releaseFirst = r })

      const first = enqueueSyncMaintenance(syncDir, async () => { order.push("a-start"); await gate; order.push("a-end") }, "test:gc-a")
      const second = enqueueSyncMaintenance(syncDir, async () => { order.push("b") }, "test:gc-b")

      // 给第二个任务一个「本可以不排队就执行」的机会
      await new Promise((r) => setTimeout(r, 30))
      expect(order).toEqual(["a-start"]) // 第二个必须还在等

      releaseFirst()
      await Promise.all([first, second])
      expect(order).toEqual(["a-start", "a-end", "b"])
    } finally {
      fs.rmSync(syncDir, { recursive: true, force: true })
    }
  })

  // 队列是纯 promise 链（prev.then(wrapped)），嵌套入队会双方永久互等：
  // 内层等外层 settle，外层等内层返回。2026-09-19 给 syncInner 按操作细分加锁时
  // 发现这个形状 —— 冲突落决那条路径把 import→export 整体包住，内部再调就会嵌套。
  it("队列可重入：任务内部再入队直接执行，不死锁", async () => {
    const order: string[] = []
    await enqueueWorkspace(
      dir,
      async () => {
        order.push("outer-start")
        // 这一层若重新排队，就永远等不到 —— 用例会超时而不是失败
        await enqueueWorkspace(dir, async () => {
          order.push("inner")
        }, "test:inner")
        order.push("outer-end")
      },
      "test:outer",
    )
    expect(order).toEqual(["outer-start", "inner", "outer-end"])
  })

  it("重入结束后队列恢复串行（计数必须正确退栈）", async () => {
    const order: string[] = []
    let releaseOuter!: () => void
    const gate = new Promise<void>((r) => { releaseOuter = r })

    const outer = enqueueWorkspace(dir, async () => {
      await enqueueWorkspace(dir, async () => { order.push("inner") }, "test:inner")
      await gate
      order.push("outer-end")
    }, "test:outer")

    // 外层还在执行 → 新任务必须排队，不能因为「刚才重入过」就放行
    const after = enqueueWorkspace(dir, async () => { order.push("after") }, "test:after")
    await new Promise((r) => setTimeout(r, 30))
    expect(order).toEqual(["inner"])

    releaseOuter()
    await Promise.all([outer, after])
    expect(order).toEqual(["inner", "outer-end", "after"])
  })

  it("不同工作区各自独立排队，不互相合并", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-snapq-b-"));
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "v1");
      fs.writeFileSync(path.join(other, "b.txt"), "v1");

      const p1 = maybeSnapshot({ workspaceDir: dir, runId: "a" });
      const p2 = maybeSnapshot({ workspaceDir: other, runId: "b" });

      expect(getWorkspaceQueueDepth(dir)).toBe(1);
      expect(getWorkspaceQueueDepth(other)).toBe(1);
      expect(p2).not.toBe(p1);
      await Promise.all([p1, p2]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("已在执行的快照不吸收新请求（新请求要能捕获其后的变更）", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "v1");

    const p1 = maybeSnapshot({ workspaceDir: dir, runId: "r1" });
    // 让出事件循环：第一个任务体已跑过「出队即摘牌」并停在 repo.commit 的 await 上
    await new Promise((r) => setTimeout(r, 0));
    const p2 = maybeSnapshot({ workspaceDir: dir, runId: "r2" });

    expect(p2).not.toBe(p1);
    await Promise.all([p1, p2]);
  });
});
