import { describe, expect, it, vi } from "vitest";
import { PluginHost, definePlugin } from "./loader.js";
import { createServiceKey } from "./types.js";

interface TestEvents {
  tick: { n: number };
}

const STORAGE = createServiceKey<{ value: string }>("storage");

describe("PluginHost", () => {
  it("按依赖顺序激活：提供者先于消费者", async () => {
    const host = new PluginHost<TestEvents>();
    const order: string[] = [];

    host.register(
      definePlugin<TestEvents>({
        id: "consumer",
        inject: ["storage"],
        apply() {
          order.push("consumer");
        },
      }),
    );
    host.register(
      definePlugin<TestEvents>({
        id: "provider",
        provides: ["storage"],
        apply(ctx) {
          order.push("provider");
          ctx.provide(STORAGE, { value: "ok" });
        },
      }),
    );

    const report = await host.start();

    expect(order).toEqual(["provider", "consumer"]);
    expect(report.failed).toEqual([]);
  });

  it("缺必需依赖的插件标记 failed，其余照常激活", async () => {
    const host = new PluginHost<TestEvents>();
    const applied: string[] = [];

    host.register(
      definePlugin<TestEvents>({
        id: "needy",
        inject: ["missing"],
        apply() {
          applied.push("needy");
        },
      }),
    );
    host.register(
      definePlugin<TestEvents>({
        id: "healthy",
        apply() {
          applied.push("healthy");
        },
      }),
    );

    const report = await host.start();

    expect(applied).toEqual(["healthy"]);
    expect(report.failed.map((f) => f.id)).toEqual(["needy"]);
    expect(host.get("needy")?.state).toBe("failed");
  });

  it("apply 抛错的插件不拖垮宿主", async () => {
    const host = new PluginHost<TestEvents>();
    const applied: string[] = [];

    host.register(
      definePlugin<TestEvents>({
        id: "boom",
        apply() {
          throw new Error("boom");
        },
      }),
    );
    host.register(
      definePlugin<TestEvents>({
        id: "ok",
        apply() {
          applied.push("ok");
        },
      }),
    );

    const report = await host.start();

    expect(applied).toEqual(["ok"]);
    expect(report.activated).toEqual(["ok"]);
    expect(report.failed.map((f) => f.id)).toEqual(["boom"]);
  });

  it("依赖成环直接抛错并指出环路", async () => {
    const host = new PluginHost<TestEvents>();
    host.register(definePlugin<TestEvents>({ id: "a", provides: ["s1"], inject: ["s2"], apply() {} }));
    host.register(definePlugin<TestEvents>({ id: "b", provides: ["s2"], inject: ["s1"], apply() {} }));

    await expect(host.start()).rejects.toThrow(/成环/);
  });

  it("stop 移除服务与监听器", async () => {
    const host = new PluginHost<TestEvents>();
    const listener = vi.fn();

    host.register(
      definePlugin<TestEvents>({
        id: "p",
        provides: ["storage"],
        apply(ctx) {
          ctx.provide(STORAGE, { value: "x" });
          ctx.on("tick", listener);
        },
      }),
    );
    await host.start();

    host.eventBus.emit("tick", { n: 1 });
    await host.stop("p");
    host.eventBus.emit("tick", { n: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(host.container.has(STORAGE)).toBe(false);
    expect(host.get("p")?.state).toBe("stopped");
  });

  it("重复注册同一 id 抛错", () => {
    const host = new PluginHost<TestEvents>();
    host.register(definePlugin<TestEvents>({ id: "p", apply() {} }));

    expect(() => host.register(definePlugin<TestEvents>({ id: "p", apply() {} }))).toThrow(/重复注册/);
  });
});
