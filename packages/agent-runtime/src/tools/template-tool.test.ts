/**
 * template-tool 单测 — 占位符提取 / 渲染转义 / 定义校验 / 执行
 */

import { describe, expect, it } from "vitest";
import {
  createTemplateTool,
  extractPlaceholders,
  renderTemplate,
  validateTemplateToolDefinition,
  type TemplateToolDefinition,
} from "./template-tool.js";
import type { ToolExecutionContext } from "../types/tool.js";

const baseDef: TemplateToolDefinition = {
  name: "pnpm-build",
  description: "构建指定 workspace 包，输出产物到 dist",
  whenToUse: "需要重新构建某个包时",
  whenNotToUse: "只想跑测试时不要用（改用 test 命令）",
  parameters: {
    type: "object",
    properties: {
      pkg: { type: "string", description: "workspace 包路径" },
    },
  },
  commandTemplate: "pnpm --filter {{pkg}} build",
  isReadOnly: false,
  needsPermission: true,
};

describe("extractPlaceholders", () => {
  it("提取全部占位符并去重", () => {
    expect(extractPlaceholders("pnpm --filter {{pkg}} build {{pkg}}")).toEqual(["pkg"]);
    expect(extractPlaceholders("{{a}} && {{b}}")).toEqual(["a", "b"]);
  });

  it("无占位符返回空数组", () => {
    expect(extractPlaceholders("pnpm build")).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("参数值单引号包裹后替换", () => {
    expect(renderTemplate("pnpm --filter {{pkg}} build", { pkg: "./apps/windows" })).toBe(
      "pnpm --filter './apps/windows' build",
    );
  });

  it("值内单引号被转义，杜绝注入", () => {
    expect(renderTemplate("echo {{msg}}", { msg: "it's; rm -rf /" })).toBe(
      `echo 'it'\\''s; rm -rf /'`,
    );
  });

  it("缺失参数保留占位符原样，让错误可见", () => {
    expect(renderTemplate("echo {{msg}}", {})).toBe("echo {{msg}}");
  });

  it("空字符串替换为空引号对", () => {
    expect(renderTemplate("echo {{msg}}", { msg: "" })).toBe("echo ''");
  });
});

describe("validateTemplateToolDefinition", () => {
  it("合法定义通过", () => {
    expect(validateTemplateToolDefinition(baseDef)).toEqual([]);
  });

  it("name 非 kebab-case 报错", () => {
    const errors = validateTemplateToolDefinition({ ...baseDef, name: "PnpmBuild" });
    expect(errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  it("占位符与参数不一致报错", () => {
    // 模板用了未声明的占位符
    const errors1 = validateTemplateToolDefinition({
      ...baseDef,
      commandTemplate: "pnpm --filter {{pkg}} build {{extra}}",
    });
    expect(errors1.some((e) => e.includes("{{extra}}"))).toBe(true);

    // 参数未在模板中使用
    const errors2 = validateTemplateToolDefinition({
      ...baseDef,
      parameters: {
        type: "object",
        properties: {
          pkg: { type: "string" },
          unused: { type: "string" },
        },
      },
    });
    expect(errors2.some((e) => e.includes('"unused"'))).toBe(true);
  });

  it("无占位符的纯固定命令报错", () => {
    const errors = validateTemplateToolDefinition({ ...baseDef, commandTemplate: "pnpm build" });
    expect(errors.some((e) => e.includes("不含任何占位符"))).toBe(true);
  });

  it("parameters 结构非法报错", () => {
    const errors = validateTemplateToolDefinition({
      ...baseDef,
      parameters: { type: "string" },
    });
    expect(errors.some((e) => e.includes("type: 'object'"))).toBe(true);
  });
});

describe("createTemplateTool", () => {
  it("执行时渲染模板并经 executeCommand 运行", async () => {
    const calls: string[] = [];
    const context = {
      getCwd: () => "C:\\work",
      executeCommand: async (cmd: string, _opts: unknown) => {
        calls.push(cmd);
        return { stdout: "built ok", stderr: "", exitCode: 0 };
      },
    } as unknown as ToolExecutionContext;

    const tool = createTemplateTool(baseDef);
    expect(tool.name).toBe("pnpm-build");
    expect(tool.needsPermission).toBe(true);
    expect(tool.description).toContain("何时使用");
    expect(tool.description).toContain("何时不用");

    const result = await tool.execute("tc-1", { pkg: "./apps/windows" }, context);
    expect(calls).toEqual(["pnpm --filter './apps/windows' build"]);
    expect(result.content).toEqual([{ type: "text", text: "built ok" }]);
  });
});
