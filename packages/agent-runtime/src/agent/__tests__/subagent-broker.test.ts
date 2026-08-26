/**
 * SubagentBroker 单元测试：并发帽、完成队列、完成文案模板
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SubagentBroker,
  SUBAGENT_DEFAULTS,
  type SubagentCompletionPayload,
} from "../subagent-broker.js";

describe("SubagentBroker", () => {
  let broker: SubagentBroker;

  beforeEach(() => {
    broker = new SubagentBroker();
  });

  it("tryAcquireSlot 在未达上限时返回 true，超限返回 false", () => {
    const parentId = "parent-1";
    const limit = 2;

    expect(broker.tryAcquireSlot(parentId, limit)).toBe(true);
    broker.registerRun({
      childId: "c1",
      parentId,
      name: "a",
      mode: "async",
    });

    expect(broker.tryAcquireSlot(parentId, limit)).toBe(true);
    broker.registerRun({
      childId: "c2",
      parentId,
      name: "b",
      mode: "async",
    });

    expect(broker.countRunning(parentId)).toBe(2);
    expect(broker.tryAcquireSlot(parentId, limit)).toBe(false);
  });

  it("finalizeRun 后释放并发槽，可再次 acquire", () => {
    const parentId = "parent-1";
    expect(broker.tryAcquireSlot(parentId, 1)).toBe(true);
    broker.registerRun({
      childId: "c1",
      parentId,
      name: "a",
      mode: "async",
    });
    expect(broker.tryAcquireSlot(parentId, 1)).toBe(false);

    broker.finalizeRun("c1", "succeeded", "done");
    expect(broker.countRunning(parentId)).toBe(0);
    expect(broker.tryAcquireSlot(parentId, 1)).toBe(true);
  });

  it("enqueueCompletion / drainCompletions 按 parent 隔离并清空", () => {
    const p1: SubagentCompletionPayload = {
      childId: "c1",
      parentId: "p1",
      name: "one",
      status: "succeeded",
      summary: "ok",
    };
    const p2: SubagentCompletionPayload = {
      childId: "c2",
      parentId: "p2",
      name: "two",
      status: "failed",
      summary: "err",
    };

    broker.enqueueCompletion(p1);
    broker.enqueueCompletion(p2);
    broker.enqueueCompletion({
      childId: "c3",
      parentId: "p1",
      name: "three",
      status: "cancelled",
      summary: "abort",
    });

    const drained = broker.drainCompletions("p1");
    expect(drained).toHaveLength(2);
    expect(drained.map((d) => d.childId)).toEqual(["c1", "c3"]);
    expect(broker.drainCompletions("p1")).toEqual([]);
    expect(broker.drainCompletions("p2")).toHaveLength(1);
  });

  it("formatCompletionMessage 生成固定模板文案", () => {
    const text = broker.formatCompletionMessage({
      childId: "inst-42",
      parentId: "p",
      name: "explore",
      status: "succeeded",
      summary: "found 3 files",
    });

    expect(text).toBe(
      [
        "[SUBAGENT_COMPLETE]",
        "name: explore",
        "instanceId: inst-42",
        "status: succeeded",
        "summary:",
        "found 3 files",
      ].join("\n"),
    );
  });

  it("buildCompletion 从 finalize 后的 run 生成 payload", () => {
    broker.registerRun({
      childId: "c1",
      parentId: "p1",
      name: "worker",
      mode: "async",
    });
    broker.finalizeRun("c1", "succeeded", "hello world");

    const payload = broker.buildCompletion("c1");
    expect(payload).toEqual({
      childId: "c1",
      parentId: "p1",
      name: "worker",
      status: "succeeded",
      summary: "hello world",
    });
  });

  it("SUBAGENT_DEFAULTS 含深度=1、默认并发 5、硬顶 10", () => {
    expect(SUBAGENT_DEFAULTS.maxSpawnDepth).toBe(1);
    expect(SUBAGENT_DEFAULTS.maxConcurrentChildren).toBe(5);
    expect(SUBAGENT_DEFAULTS.hardMaxConcurrent).toBe(10);
  });
});
