import { describe, expect, it } from "vitest";
import { PluginScope } from "./scope.js";

describe("PluginScope", () => {
  it("按 LIFO 顺序清理", async () => {
    const scope = new PluginScope("p");
    const order: number[] = [];
    scope.effect(() => void order.push(1));
    scope.effect(() => void order.push(2));
    scope.effect(() => void order.push(3));

    const result = await scope.dispose();

    expect(result.ok).toBe(true);
    expect(order).toEqual([3, 2, 1]);
  });

  it("异步 disposer 严格串行，后注册的先跑完才轮到前一个", async () => {
    const scope = new PluginScope("p");
    const timeline: string[] = [];

    scope.effect(async () => {
      timeline.push("A-start");
      await new Promise((r) => setTimeout(r, 10));
      timeline.push("A-end");
    });
    scope.effect(async () => {
      timeline.push("B-start");
      await new Promise((r) => setTimeout(r, 5));
      timeline.push("B-end");
    });

    await scope.dispose();

    expect(timeline).toEqual(["B-start", "B-end", "A-start", "A-end"]);
  });

  it("中途失败不中断，其余照常清理", async () => {
    const scope = new PluginScope("p");
    let cleaned = false;

    scope.effect(() => {
      cleaned = true;
    });
    scope.effect(() => {
      throw new Error("boom");
    });

    const result = await scope.dispose();

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(cleaned).toBe(true);
  });

  it("dispose 幂等，disposer 只跑一次", async () => {
    const scope = new PluginScope("p");
    let count = 0;
    scope.effect(() => void count++);

    const [a, b] = await Promise.all([scope.dispose(), scope.dispose()]);

    expect(a).toEqual(b);
    expect(count).toBe(1);
  });

  it("销毁后注册 effect 抛错", async () => {
    const scope = new PluginScope("p");
    await scope.dispose();

    expect(() => scope.effect(() => {})).toThrow(/作用域已销毁/);
  });
});
