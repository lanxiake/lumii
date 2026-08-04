/**
 * 集成工具配置单测（memory_read 等）
 */

import { describe, expect, it } from "vitest";
import { memoryReadToolConfig, memorySearchToolConfig } from "../built-in/integration-tools.js";

describe("memoryReadToolConfig", () => {
  it("工具名与参数 schema 符合 Phase 4 约定", () => {
    expect(memoryReadToolConfig.name).toBe("memory_read");
    expect(memoryReadToolConfig.category).toBe("memory");
    expect(memoryReadToolConfig.isReadOnly).toBe(true);
    expect(memoryReadToolConfig.needsPermission).toBe(false);
    const props = (memoryReadToolConfig.parameters as { properties?: Record<string, unknown> })
      .properties;
    expect(props).toHaveProperty("drawerId");
  });

  it("描述引导先 memory_search 再 memory_read", () => {
    expect(memoryReadToolConfig.description).toContain("memory_search");
    expect(memoryReadToolConfig.description).toContain("drawer_id");
  });

  it("stub execute 返回 not_implemented（由宿主 override）", async () => {
    const result = await memoryReadToolConfig.execute!("call-1", { drawerId: "abc" });
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("not_implemented");
  });
});

describe("memorySearchToolConfig", () => {
  it("与 memory_read 配对存在", () => {
    expect(memorySearchToolConfig.name).toBe("memory_search");
    expect(memorySearchToolConfig.category).toBe("memory");
  });
});
