import { describe, it, expect } from "vitest";
import { mergePetRegistries, normalizePetModelEntry } from "./pet-registry.js";

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `名字-${id}`,
  rendererType: "live2d",
  modelUrl: `${id}/model.model3.json`,
  ...extra,
});

const registry = (models: unknown[], defaultModelId = "") => ({
  version: 2,
  models,
  defaultModelId,
});

describe("mergePetRegistries", () => {
  it("用户新增条目追加在内置之后", () => {
    const r = mergePetRegistries(registry([entry("a"), entry("b")]), registry([entry("c")]));
    expect(r.models.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(r.models.map((m) => m.source)).toEqual(["builtin", "builtin", "user"]);
  });

  it("同 id 用户版本覆盖内置，且位置不变", () => {
    const r = mergePetRegistries(
      registry([entry("a"), entry("b"), entry("c")]),
      registry([entry("b", { name: "我的 b" })]),
    );
    expect(r.models.map((m) => m.id)).toEqual(["a", "b", "c"]);
    const b = r.models[1];
    expect(b.name).toBe("我的 b");
    expect(b.source).toBe("user");
    expect(b.shadowedBuiltin).toBe(true);
    // 未覆盖的内置项不带该标记
    expect(r.models[0].shadowedBuiltin).toBeUndefined();
    expect(r.models[2].source).toBe("builtin");
  });

  it("单条坏数据只跳过该条，不影响其余条目", () => {
    const r = mergePetRegistries(
      registry([entry("a"), { id: "bad" }, entry("c")]),
      registry([{ name: "没有 id" }, entry("d")]),
    );
    expect(r.models.map((m) => m.id)).toEqual(["a", "c", "d"]);
    expect(r.diagnostics.filter((d) => d.level === "error")).toHaveLength(2);
    expect(r.diagnostics.every((d) => d.id !== "bad" || d.message.length > 0)).toBe(true);
  });

  it("同一注册表内 id 重复时保留第一条并告警", () => {
    const r = mergePetRegistries(registry([entry("a", { name: "第一个" }), entry("a", { name: "第二个" })]), null);
    expect(r.models).toHaveLength(1);
    expect(r.models[0].name).toBe("第一个");
    expect(r.diagnostics.some((d) => d.level === "warn" && d.message.includes("重复"))).toBe(true);
  });

  it("rendererType 缺省视为 live2d（兼容老注册表）", () => {
    const r = mergePetRegistries(registry([{ id: "a", name: "a", modelUrl: "a.model3.json" }]), null);
    expect(r.models[0].rendererType).toBe("live2d");
  });

  it("非法 rendererType 拒绝该条", () => {
    const r = mergePetRegistries(registry([entry("a", { rendererType: "3d" })]), null);
    expect(r.models).toHaveLength(0);
    expect(r.diagnostics[0].level).toBe("error");
  });

  it("未知字段不透传到结果（注册表只是配置，但也不许夹带）", () => {
    const r = mergePetRegistries(registry([entry("a", { cubismVersion: 2, 恶意字段: "x" })]), null);
    expect(r.models[0]).not.toHaveProperty("cubismVersion");
    expect(r.models[0]).not.toHaveProperty("恶意字段");
  });

  it("保住 actionMotions（合并后仍可用于动作提示词）", () => {
    const r = mergePetRegistries(
      registry([entry("a", { actionMotions: { 挥手: { group: "$unnamed", index: 0 } } })]),
      null,
    );
    expect(r.models[0].actionMotions).toEqual({ 挥手: { group: "$unnamed", index: 0 } });
  });

  describe("defaultModelId 三级回退", () => {
    it("用户声明且存在 → 用用户的", () => {
      const r = mergePetRegistries(registry([entry("a")], "a"), registry([entry("b")], "b"));
      expect(r.defaultModelId).toBe("b");
    });

    it("用户声明但不存在 → 回落内置", () => {
      const r = mergePetRegistries(registry([entry("a")], "a"), registry([entry("b")], "不存在"));
      expect(r.defaultModelId).toBe("a");
      expect(r.diagnostics.some((d) => d.source === "user" && d.message.includes("不存在"))).toBe(true);
    });

    it("两者都没有声明 → 取列表首项", () => {
      const r = mergePetRegistries(registry([entry("a")]), registry([entry("b")]));
      expect(r.defaultModelId).toBe("a");
    });

    it("用户默认指向被自己覆盖的内置 id → 仍然有效", () => {
      const r = mergePetRegistries(registry([entry("a")], "a"), registry([entry("a")], "a"));
      expect(r.defaultModelId).toBe("a");
      expect(r.models).toHaveLength(1);
    });
  });

  it("空表 / null 输入不抛异常", () => {
    expect(mergePetRegistries(null, null).models).toEqual([]);
    expect(mergePetRegistries(null, null).defaultModelId).toBe("");
    expect(mergePetRegistries(undefined, undefined).models).toEqual([]);
    expect(mergePetRegistries("不是对象", 42).models).toEqual([]);
    expect(mergePetRegistries({ version: 2 }, null).models).toEqual([]);
  });

  it("内置目录缺失（null）时用户表仍可用", () => {
    const r = mergePetRegistries(null, registry([entry("my-pet")], "my-pet"));
    expect(r.models.map((m) => m.id)).toEqual(["my-pet"]);
    expect(r.defaultModelId).toBe("my-pet");
  });
});

describe("normalizePetModelEntry", () => {
  it("合法条目补全默认值", () => {
    const { entry: e, diagnostics } = normalizePetModelEntry(entry("x"));
    expect(e?.scale).toBe(0.4);
    expect(e?.emotionMap).toEqual({});
    expect(diagnostics).toEqual([]);
  });

  it("缺 id 时不给条目，只给诊断", () => {
    const { entry: e, diagnostics } = normalizePetModelEntry({ name: "x", modelUrl: "y" });
    expect(e).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
  });

  it("null 值按未声明处理，不用 null 覆盖默认值", () => {
    const { entry: e } = normalizePetModelEntry(entry("x", { scale: null, emotionMap: null }));
    expect(e?.scale).toBe(0.4);
    expect(e?.emotionMap).toEqual({});
  });
});
