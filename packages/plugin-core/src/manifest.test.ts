import { describe, expect, it } from "vitest";
import { validateManifest, type LumiiPluginManifest } from "./manifest.js";

const base: LumiiPluginManifest = {
  id: "com.lumii.demo",
  name: "演示插件",
  version: "0.1.0",
  engines: { lumii: ">=0.1.0" },
  kind: "code",
  main: "./dist/main.js",
};

describe("validateManifest", () => {
  it("合法清单原样返回", () => {
    expect(validateManifest(base)).toBe(base);
  });

  it("id 必须是反向域名形态", () => {
    expect(() => validateManifest({ ...base, id: "nope" })).toThrow(/id/);
  });

  it("kind=code 必须声明入口", () => {
    expect(() => validateManifest({ ...base, main: undefined, client: undefined })).toThrow(
      /main 或 client/,
    );
  });

  it("kind=asset 不需要入口", () => {
    expect(() => validateManifest({ ...base, kind: "asset", main: undefined })).not.toThrow();
  });

  it("宿主版本不满足时拒绝", () => {
    expect(() => validateManifest({ ...base, engines: { lumii: ">=9.0.0" } }, { appVersion: "0.1.5" })).toThrow(
      /不满足/,
    );
  });

  it("非法版本范围视为不满足，而不是放行", () => {
    expect(() => validateManifest({ ...base, engines: { lumii: "not-a-range" } }, { appVersion: "0.1.5" })).toThrow(
      /不满足/,
    );
  });

  it("一次性报告全部结构问题", () => {
    try {
      validateManifest({ id: "x" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/required property 'name'/);
    }
  });
});
