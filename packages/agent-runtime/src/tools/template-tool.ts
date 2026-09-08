/**
 * TemplateTool — 参数化命令模板执行器（工具进化 M2）
 *
 * 「工具进化」批准后的工具以命令模板 + JSON Schema 形式落盘，
 * 运行时由本工厂转换为标准 MtBotTool：
 * - 参数按占位符 {{name}} 替换进模板，值做单引号转义，不经 shell 拼接语义
 * - 复用 ToolExecutionContext.executeCommand（继承权限弹窗、超时、取消、审计）
 *
 * 安全约束：
 * - 模板只允许出现已在参数 schema 中声明的占位符（extraPlaceholders 校验）
 * - 值中的单引号会被转义为 '\''，杜绝引号逃逸注入
 */

import type { TSchema } from "@sinclair/typebox";
import type { MtBotToolConfig } from "./tool-adapter.js";
import type { ToolExecutionContext } from "../types/tool.js";

export interface TemplateToolDefinition {
  /** 工具名（kebab-case，注册前需做重名检查） */
  name: string;
  description: string;
  /** 何时使用 / 何时不用（并入 description 传给模型） */
  whenToUse?: string;
  whenNotToUse?: string;
  /** 参数 JSON Schema（draft-07，type: object + properties） */
  parameters: Record<string, unknown>;
  /** 命令模板：参数位为 {{paramName}} */
  commandTemplate: string;
  isReadOnly: boolean;
  needsPermission: boolean;
  /** 默认工作目录（可选） */
  cwd?: string;
  /** 默认超时（毫秒，可选，默认走宿主 120s） */
  timeoutMs?: number;
}

export interface TemplateToolExecutionError {
  message: string;
}

/** 提取模板中的全部占位符名 */
export function extractPlaceholders(template: string): string[] {
  const names: string[] = [];
  const re = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m[1] && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * 将参数值替换进模板：值统一用单引号包裹并转义内部单引号。
 * 不包裹 undefined/null（该参数位未提供时保留占位符原样，让命令报错可见）。
 */
export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (whole, name: string) => {
    if (!(name in values)) return whole;
    const v = values[name];
    if (v === undefined || v === null) return whole;
    const s = String(v);
    if (s === "") return "''";
    // 单引号转义：' → '\''
    return `'${s.replace(/'/g, `'\\''`)}'`;
  });
}

/**
 * 校验工具定义静态合法性。返回错误信息数组，空数组 = 通过。
 */
export function validateTemplateToolDefinition(def: TemplateToolDefinition): string[] {
  const errors: string[] = [];

  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(def.name)) {
    errors.push(`工具名 "${def.name}" 不是 kebab-case`);
  }
  if (!def.description || def.description.trim().length < 10) {
    errors.push("description 过短（至少 10 字符）");
  }

  // 参数 schema 基础结构
  const params = def.parameters as { type?: unknown; properties?: Record<string, unknown> };
  if (params?.type !== "object" || typeof params.properties !== "object" || params.properties === null) {
    errors.push("parameters 必须是 { type: 'object', properties: {...} } 结构");
    return errors;
  }
  const declared = Object.keys(params.properties);

  const placeholders = extractPlaceholders(def.commandTemplate);
  if (placeholders.length === 0) {
    errors.push("commandTemplate 不含任何占位符（纯固定命令无需工具化）");
  }
  for (const ph of placeholders) {
    if (!declared.includes(ph)) {
      errors.push(`模板占位符 {{${ph}}} 未在 parameters 中声明`);
    }
  }
  for (const name of declared) {
    if (!placeholders.includes(name)) {
      errors.push(`参数 "${name}" 未在模板中使用`);
    }
  }

  return errors;
}

/**
 * 构造模板工具配置（宿主用 createMtBotTool(config, context) 绑定后注册）
 *
 * parameters 为 JSON Schema 对象：pi-agent-core 按 JSON Schema 消费，
 * 此处以 TSchema 类型透传（运行时不走 TypeBox 编译）。
 */
export function createTemplateTool(
  def: TemplateToolDefinition,
): MtBotToolConfig {
  const description =
    `${def.description}\n` +
    (def.whenToUse ? `\n何时使用: ${def.whenToUse}` : "") +
    (def.whenNotToUse ? `\n何时不用: ${def.whenNotToUse}` : "");

  return {
    name: def.name,
    label: def.name,
    description,
    parameters: def.parameters as unknown as TSchema,
    category: "shell",
    isReadOnly: def.isReadOnly,
    needsPermission: def.needsPermission,
    execute: async (_toolCallId, params, context: ToolExecutionContext, signal) => {
      const command = renderTemplate(def.commandTemplate, params as Record<string, unknown>);
      const result = await context.executeCommand(command, {
        cwd: def.cwd ?? context.getCwd(),
        timeoutMs: def.timeoutMs ?? 120000,
        signal,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: output || "(no output)" }],
        details: { exitCode: result.exitCode, command },
      };
    },
  };
}
