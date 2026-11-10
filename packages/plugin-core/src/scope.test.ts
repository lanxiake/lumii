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

  it("generator 产出的每个 disposer 都被登记，并按 LIFO 清理", async () => {
    const scope = new PluginScope("p");
    const order: string[] = [];

    scope.effect(function* () {
      yield () => void order.push("a");
      yield () => void order.push("b");
      yield () => void order.push("c");
    });

    await scope.dispose();

    expect(order).toEqual(["c", "b", "a"]);
  });

  it("子作用域随父作用域清理，且清理顺序是嵌套整体逆序", async () => {
    const scope = new PluginScope("p");
    const order: string[] = [];

    scope.effect(() => void order.push("parent-1"));
    const child = scope.fork();
    child.effect(() => void order.push("child-1"));
    child.effect(() => void order.push("child-2"));
    scope.effect(() => void order.push("parent-2"));

    await scope.dispose();

    // parent-2 后注册 → 先清理；再轮到「fork 时登记的那个清理器」把整棵子树拆掉；最后 parent-1
    expect(order).toEqual(["parent-2", "child-2", "child-1", "parent-1"]);
    expect(child.isDisposed).toBe(true);
  });

  it("子作用域可以单独提前 dispose，父作用域不受影响", async () => {
    const scope = new PluginScope("p");
    let parentCleaned = false;
    let childCleaned = false;

    scope.effect(() => {
      parentCleaned = true;
    });
    const child = scope.fork();
    child.effect(() => {
      childCleaned = true;
    });

    await child.dispose();

    expect(childCleaned).toBe(true);
    expect(parentCleaned).toBe(false);
    expect(scope.isDisposed).toBe(false);

    await scope.dispose();
    expect(parentCleaned).toBe(true);
  });

  it("父作用域销毁后再开子作用域抛错", async () => {
    const scope = new PluginScope("p");
    await scope.dispose();

    expect(() => scope.fork()).toThrow(/作用域已销毁/);
  });
});
