import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./events.js";

interface TestEvents {
  ping: { n: number };
  chain: { value: string };
}

describe("EventBus", () => {
  it("emit 派发给全部监听器，监听器异常不影响其他监听器", () => {
    const errors: unknown[] = [];
    const bus = new EventBus<TestEvents>({ onListenerError: (_e, err) => void errors.push(err) });
    const seen: number[] = [];

    bus.on("ping", () => {
      throw new Error("boom");
    });
    bus.on("ping", (payload) => void seen.push(payload.n));

    bus.emit("ping", { n: 1 });

    expect(seen).toEqual([1]);
    expect(errors).toHaveLength(1);
  });

  it("emit 不等异步监听器", () => {
    const bus = new EventBus<TestEvents>();
    let done = false;
    bus.on("ping", async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });

    bus.emit("ping", { n: 1 });

    expect(done).toBe(false);
  });

  it("waterfall 依次传递修改后的 payload", async () => {
    const bus = new EventBus<TestEvents>();
    bus.onWaterfall("chain", async (payload, next) => {
      payload.value += "a";
      return next();
    });
    bus.onWaterfall("chain", async (payload) => {
      payload.value += "b";
      return payload;
    });

    const result = await bus.waterfall("chain", { value: "" });

    expect(result.value).toBe("ab");
  });

  it("waterfall 不调 next 即短路", async () => {
    const bus = new EventBus<TestEvents>();
    const second = vi.fn();
    bus.onWaterfall("chain", async (payload) => payload);
    bus.onWaterfall("chain", async (payload) => {
      second();
      return payload;
    });

    await bus.waterfall("chain", { value: "" });

    expect(second).not.toHaveBeenCalled();
  });

  it("serial 按注册顺序 await，值依次传递", async () => {
    const bus = new EventBus<TestEvents>();
    const order: string[] = [];
    bus.on("chain", async (payload) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("first");
      return { value: `${payload.value}1` };
    });
    bus.on("chain", async (payload) => {
      order.push("second");
      return { value: `${payload.value}2` };
    });

    const result = await bus.serial("chain", { value: "" });

    expect(order).toEqual(["first", "second"]);
    expect(result.value).toBe("12");
  });

  it("parallel 等全部完成，失败者抛 AggregateError 但不影响其他人", async () => {
    const bus = new EventBus<TestEvents>({ onListenerError: () => {} });
    let finished = 0;

    bus.on("ping", async () => {
      await new Promise((r) => setTimeout(r, 5));
      finished++;
    });
    bus.on("ping", async () => {
      finished++;
      throw new Error("boom");
    });

    await expect(bus.parallel("ping", { n: 0 })).rejects.toThrow(AggregateError);
    expect(finished).toBe(2);
  });

  it("注销后不再收到事件，且派发中途增删不影响本轮快照", () => {
    const bus = new EventBus<TestEvents>();
    const seen: string[] = [];

    const off = bus.on("ping", () => {
      seen.push("a");
      off();
      bus.on("ping", () => void seen.push("late"));
    });

    bus.emit("ping", { n: 0 });
    bus.emit("ping", { n: 1 });

    expect(seen).toEqual(["a", "late"]);
  });
});
