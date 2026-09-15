/**
 * 工具定义载荷裁剪（极简档）契约测试
 *
 * 关键契约：
 * - 简单工具：工具级与参数内 description 全部消失，结构信息（类型/必填/枚举/嵌套）保留；
 * - 复杂工具：整条定义对象引用不变（零拷贝）；
 * - 非极简风格：返回原数组（引用相等）；
 * - 裁剪不修改原对象。
 */

import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  COMPLEX_TOOL_MIN_PARAMS,
  applyToolDefinitionStyle,
  isComplexTool,
  stripToolDefinition,
} from "../tool-definition-style.js";

const SIMPLE_TOOL = {
  name: "file_read",
  description: "Read a file from the workspace as text.",
  parameters: Type.Object({
    filePath: Type.String({ description: "Path to the file to read." }),
    offset: Type.Optional(
      Type.Number({ description: "Line number to start reading from (1-based)." }),
    ),
  }),
  execute: async () => ({ content: [] }),
};

describe("isComplexTool", () => {
  it("组合流程清单内的工具为复杂（含单参数工具）", () => {
    expect(isComplexTool("bash", Type.Object({}))).toBe(true);
    expect(isComplexTool("skill_invoke", undefined)).toBe(true);
  });

  it("browser_* 前缀为复杂（eval 定位 + 截图观察的交互循环）", () => {
    expect(isComplexTool("browser_click", Type.Object({ ref: Type.String() }))).toBe(true);
  });

  it(`参数数量 ≥ ${COMPLEX_TOOL_MIN_PARAMS} 为复杂`, () => {
    const many = Type.Object({
      a: Type.String(),
      b: Type.String(),
      c: Type.String(),
      d: Type.String(),
      e: Type.String(),
    });
    expect(isComplexTool("some_tool", many)).toBe(true);
    expect(isComplexTool("some_tool", Type.Object({ a: Type.String() }))).toBe(false);
  });

  it("清单外且参数少的工具为简单", () => {
    expect(isComplexTool("file_read", Type.Object({ filePath: Type.String() }))).toBe(false);
    expect(isComplexTool("glob", undefined)).toBe(false);
  });
});

describe("stripToolDefinition", () => {
  it("删工具级描述并递归删参数内描述，结构信息保留", () => {
    const stripped = stripToolDefinition(SIMPLE_TOOL);
    expect(stripped.description).toBe("");
    const params = stripped.parameters as {
      properties: Record<string, { description?: string; type?: string }>;
      required: string[];
    };
    expect(params.properties.filePath.description).toBeUndefined();
    expect(params.properties.filePath.type).toBe("string");
    expect(params.properties.offset.description).toBeUndefined();
    expect(params.required).toEqual(["filePath"]);
  });

  it("不修改原对象，其余字段（execute）引用不变", () => {
    const stripped = stripToolDefinition(SIMPLE_TOOL);
    expect(SIMPLE_TOOL.description.length).toBeGreaterThan(0);
    expect(
      (SIMPLE_TOOL.parameters as { properties: { filePath: { description?: string } } }).properties
        .filePath.description,
    ).toBeDefined();
    expect(stripped.execute).toBe(SIMPLE_TOOL.execute);
  });

  it("嵌套结构（数组 / 联合 / 深层对象）内的描述一并移除", () => {
    const nested = {
      name: "nested_tool",
      description: "top",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "array level",
            items: { type: "object", properties: { id: { type: "string", description: "deep" } } },
          },
          mode: {
            anyOf: [
              { const: "a", description: "mode a" },
              { const: "b", description: "mode b" },
            ],
          },
        },
        required: ["items"],
      },
    };
    const stripped = stripToolDefinition(nested) as typeof nested;
    const props = stripped.parameters.properties as Record<string, unknown>;
    expect(JSON.stringify(props)).not.toContain("description");
    expect(JSON.stringify(props)).toContain("\"const\":\"a\"");
    expect(stripped.parameters.required).toEqual(["items"]);
  });
});

describe("applyToolDefinitionStyle", () => {
  const tools = [
    SIMPLE_TOOL,
    {
      name: "spawn_agent",
      description: "Launch a sub-agent.",
      parameters: Type.Object({ prompt: Type.String({ description: "brief" }) }),
      execute: async () => ({ content: [] }),
    },
  ];

  it("detailed / terse 档原样返回（同一数组引用）", () => {
    expect(applyToolDefinitionStyle(tools, "detailed")).toBe(tools);
    expect(applyToolDefinitionStyle(tools, "terse")).toBe(tools);
  });

  it("minimal 档裁剪简单工具、复杂工具保持对象引用", () => {
    const applied = applyToolDefinitionStyle(tools, "minimal");
    expect(applied[0]).not.toBe(tools[0]);
    expect(applied[0]!.description).toBe("");
    expect(applied[1]).toBe(tools[1]);
  });
});
