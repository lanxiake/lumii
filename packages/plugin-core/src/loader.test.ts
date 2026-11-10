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

  it("exclude 里的插件不激活但仍登记，之后可以 activate 起来（运行时启用的前提）", async () => {
    const host = new PluginHost<TestEvents>();
    const applied: string[] = [];

    host.register(
      definePlugin<TestEvents>({
        id: "off",
        apply() {
          applied.push("off");
        },
      }),
    );
    host.register(
      definePlugin<TestEvents>({
        id: "on",
        apply() {
          applied.push("on");
        },
      }),
    );

    const report = await host.start({ exclude: new Set(["off"]) });

    expect(applied).toEqual(["on"]);
    expect(report.activated).toEqual(["on"]);
    expect(host.get("off")?.state).toBe("registered");

    expect(await host.activate("off")).toBeUndefined();
    expect(applied).toEqual(["on", "off"]);
    expect(host.get("off")?.state).toBe("active");
  });

  it("缺必需依赖的插件停在 pending（不是 failed），其余照常激活", async () => {
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
    expect(report.failed).toEqual([]);
    expect(report.pending).toEqual(["needy"]);
    expect(host.get("needy")?.state).toBe("pending");
    expect(host.get("needy")?.missingServices).toEqual(["missing"]);
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

  it("activate 单独激活，unregister 摘掉后 get 为 undefined", async () => {
    const host = new PluginHost<TestEvents>();
    let disposed = false;

    host.register(
      definePlugin<TestEvents>({
        id: "one",
        apply(ctx) {
          ctx.effect(() => {
            disposed = true;
          });
        },
      }),
    );

    expect(await host.activate("one")).toBeUndefined();
    expect(host.get("one")?.state).toBe("active");

    await host.unregister("one");

    expect(disposed).toBe(true);
    expect(host.get("one")).toBeUndefined();
  });

  it("activate 失败返回错误而不抛出，且作用域已清理", async () => {
    const host = new PluginHost<TestEvents>();
    let cleaned = false;

    host.register(
      definePlugin<TestEvents>({
        id: "boom",
        apply(ctx) {
          ctx.effect(() => {
            cleaned = true;
          });
          throw new Error("boom");
        },
      }),
    );

    const error = await host.activate("boom");

    expect(error).toBeInstanceOf(Error);
    expect(host.get("boom")?.state).toBe("failed");
    expect(cleaned).toBe(true);
  });

  it("同一 id 可先 unregister 再重新注册（热重载路径）", async () => {
    const host = new PluginHost<TestEvents>();

    host.register(definePlugin<TestEvents>({ id: "p", apply() {} }));
    await host.activate("p");
    await host.unregister("p");

    host.register(definePlugin<TestEvents>({ id: "p", apply() {} }));
    expect(await host.activate("p")).toBeUndefined();
    expect(host.get("p")?.state).toBe("active");
  });

  it("重复注册同一 id 抛错", () => {
    const host = new PluginHost<TestEvents>();
    host.register(definePlugin<TestEvents>({ id: "p", apply() {} }));

    expect(() => host.register(definePlugin<TestEvents>({ id: "p", apply() {} }))).toThrow(/重复注册/);
  });
});

describe("PluginHost v2：依赖驱动", () => {
  it("服务出现后，pending 的插件自动激活（不必手动 activate）", async () => {
    const host = new PluginHost<TestEvents>();
    const applied: string[] = [];

    host.register(
      definePlugin<TestEvents>({
        id: "consumer",
        inject: ["storage"],
        apply() {
          applied.push("consumer");
        },
      }),
    );
    await host.start();
    expect(host.get("consumer")?.state).toBe("pending");
    expect(applied).toEqual([]);

    // 宿主外部（另一个插件、或核心）此时才把服务放进来
    host.container.provide(STORAGE, { value: "late" });
    await flush();

    expect(host.get("consumer")?.state).toBe("active");
    expect(applied).toEqual(["consumer"]);
  });

  it("提供方停用后，依赖它的插件级联回 pending；服务恢复后自动重新激活", async () => {
    const host = new PluginHost<TestEvents>();
    const events: string[] = [];

    host.register(
      definePlugin<TestEvents>({
        id: "provider",
        provides: ["storage"],
        apply(ctx) {
          ctx.provide(STORAGE, { value: "x" });
        },
      }),
    );
    host.register(
      definePlugin<TestEvents>({
        id: "consumer",
        inject: ["storage"],
        apply(ctx) {
          events.push("consumer-applied");
          ctx.effect(() => {
            events.push("consumer-cleaned");
          });
        },
      }),
    );
    await host.start();
    expect(host.get("consumer")?.state).toBe("active");

    await host.stop("provider");
    await flush();

    expect(host.get("consumer")?.state).toBe("pending");
    expect(host.get("consumer")?.missingServices).toEqual(["storage"]);
    expect(events).toEqual(["consumer-applied", "consumer-cleaned"]);

    // 重新激活提供方 → 依赖方跟着回来
    await host.activate("provider");
    await flush();
    expect(host.get("consumer")?.state).toBe("active");
    expect(events).toEqual(["consumer-applied", "consumer-cleaned", "consumer-applied"]);
  });

  it("injectOptional 缺失不阻塞激活", async () => {
    const host = new PluginHost<TestEvents>();
    let applied = false;

    host.register(
      definePlugin<TestEvents>({
        id: "optional",
        injectOptional: ["not-there"],
        apply() {
          applied = true;
        },
      }),
    );
    await host.start();

    expect(applied).toBe(true);
    expect(host.get("optional")?.state).toBe("active");
  });

  it("exclude 的插件不会被服务出现顺带激活", async () => {
    const host = new PluginHost<TestEvents>();
    const applied: string[] = [];

    host.register(
      definePlugin<TestEvents>({
        id: "off",
        inject: ["storage"],
        apply() {
          applied.push("off");
        },
      }),
    );

    await host.start({ exclude: new Set(["off"]) });
    host.container.provide(STORAGE, { value: "x" });
    await flush();

    expect(applied).toEqual([]);
    expect(host.get("off")?.state).toBe("registered");
  });
});

describe("PluginHost v2：激活看门狗", () => {
  it("apply 永不 resolve 时超时判 failed，且已登记的作用域被清理", async () => {
    const host = new PluginHost<TestEvents>(
      // 用极短的超时，否则这条测试要等默认的 10s
      { activationTimeoutMs: 30 },
    );
    let cleaned = false;

    host.register(
      definePlugin<TestEvents>({
        id: "hang",
        apply(ctx) {
          ctx.effect(() => {
            cleaned = true;
          });
          return new Promise<void>(() => {
            /* 永不 settle */
          });
        },
      }),
    );

    const report = await host.start();

    expect(report.failed.map((f) => f.id)).toEqual(["hang"]);
    expect(host.get("hang")?.state).toBe("failed");
    expect(String((host.get("hang")?.error as Error)?.message)).toMatch(/激活超时/);
    expect(cleaned).toBe(true);
  }, 5_000);

  it("插件可以用自己的 activationTimeoutMs 覆盖宿主默认值", async () => {
    const host = new PluginHost<TestEvents>({ activationTimeoutMs: 10_000 });

    host.register(
      definePlugin<TestEvents>({
        id: "slow-ok",
        activationTimeoutMs: 30,
        apply: () =>
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error("自己超时")), 60)),
      }),
    );

    const report = await host.start();

    expect(report.failed.map((f) => f.id)).toEqual(["slow-ok"]);
  }, 5_000);
});

describe("PluginHost v2：状态事件", () => {
  it("按 registered→pending→active 的顺序推送迁移，停用时推 stopped", async () => {
    const host = new PluginHost<TestEvents>();
    const transitions: string[] = [];
    host.onStateChange((c) => transitions.push(`${c.from}->${c.to}:${c.id}`));

    host.register(definePlugin<TestEvents>({ id: "needy", inject: ["storage"], apply() {} }));
    await host.start();
    host.container.provide(STORAGE, { value: "x" });
    await flush();
    await host.stop("needy");

    expect(transitions).toEqual([
      "registered->pending:needy",
      "pending->activating:needy",
      "activating->active:needy",
      "active->stopped:needy",
    ]);
  });
});

/** 让依赖驱动的异步收敛跑完（reconcile 是 fire-and-forget 的） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
