import { describe, expect, it, vi } from "vitest";
import { createPluginContext, ServiceContainer } from "./context.js";
import { EventBus } from "./events.js";
import { PluginScope } from "./scope.js";
import { createPluginLogger, createServiceKey } from "./types.js";

interface TestEvents {
  tick: { n: number };
}

const silentLogger = createPluginLogger("test", {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

function makeContext() {
  const scope = new PluginScope("test");
  const container = new ServiceContainer();
  const eventBus = new EventBus<TestEvents>();
  const ctx = createPluginContext<TestEvents>({
    pluginId: "test",
    container,
    eventBus,
    scope,
    logger: silentLogger,
  });
  return { ctx, scope, container, eventBus };
}

const TOOLS = createServiceKey<{ list: string[] }>("tools");

describe("PluginContext", () => {
  it("provide / require 取回同一个实例", () => {
    const { ctx } = makeContext();
    const tools = { list: ["a"] };

    ctx.provide(TOOLS, tools);

    expect(ctx.require(TOOLS)).toBe(tools);
    expect(ctx.get(TOOLS)).toBe(tools);
  });

  it("工厂形态只在首次 get 时求值一次", () => {
    const { ctx } = makeContext();
    const factory = vi.fn(() => ({ list: [] as string[] }));

    ctx.provide(TOOLS, factory);
    expect(factory).not.toHaveBeenCalled();

    ctx.get(TOOLS);
    ctx.get(TOOLS);

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("重复 provide 抛错", () => {
    const { ctx } = makeContext();
    ctx.provide(TOOLS, { list: [] });

    expect(() => ctx.provide(TOOLS, { list: [] })).toThrow(/已被注册/);
  });

  it("缺服务时 get 返回 undefined、require 抛错且带 pluginId", () => {
    const { ctx } = makeContext();

    expect(ctx.get(TOOLS)).toBeUndefined();
    expect(() => ctx.require(TOOLS)).toThrow(/\[test\]/);
  });

  it("作用域销毁后，provide 的服务被移除", async () => {
    const { ctx, container, scope } = makeContext();
    ctx.provide(TOOLS, { list: [] });

    await scope.dispose();

    expect(container.has(TOOLS)).toBe(false);
  });

  it("on 注册的监听器随作用域销毁自动移除", async () => {
    const { ctx, eventBus, scope } = makeContext();
    const listener = vi.fn();
    ctx.on("tick", listener);

    ctx.emit("tick", { n: 1 });
    await scope.dispose();
    ctx.emit("tick", { n: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
