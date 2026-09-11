/**
 * BashToolDrafter — LLM 从命令模式草拟参数化工具定义（工具进化 M2）
 *
 * 输入：规则粗模式 + 原始样本；
 * 输出：TemplateToolDefinition 草稿（JSON），由 ToolQualityGate 校验后进审批。
 *
 * 单次 LLM 合并「语义模板精修 + 工具定义草拟」，避免串行两次平凡调用。
 *
 * 硬性约束（写入 prompt）：
 * - 命令模板必须能在样本上还原（结构来自真实观察，禁止发明新命令结构）；
 * - 参数 schema 与占位符一一对应，参数类型限 string/number/boolean/enum；
 * - 破坏性命令（rm / git reset --hard / push --force 等）直接拒绝草拟。
 */

import type { CommandPattern } from "./command-miner.js";
import type { RefinedPattern } from "./refine-patterns.js";

export interface ToolDraft {
  name: string;
  description: string;
  whenToUse: string;
  whenNotToUse: string;
  /** 参数 JSON Schema（type: object + properties） */
  parameters: Record<string, unknown>;
  commandTemplate: string;
  isReadOnly: boolean;
}

export interface DraftToolDeps {
  callLLM: (prompt: string) => Promise<string>;
  /** 现有工具名清单（重名检查用） */
  existingToolNames: readonly string[];
}

/** 从 LLM 输出中稳健提取 JSON 对象（容忍 markdown 代码块） */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isToolDraft(value: unknown): value is ToolDraft {
  const v = value as Record<string, unknown>;
  if (typeof v?.name !== "string" || v.name.length === 0) return false;
  if (typeof v?.description !== "string" || v.description.length === 0) return false;
  if (typeof v?.commandTemplate !== "string" || v.commandTemplate.length === 0) return false;
  if (typeof v?.parameters !== "object" || v.parameters === null) return false;
  if (typeof v?.isReadOnly !== "boolean") return false;
  return true;
}

/**
 * 模板规范化：剥离占位符周围的引号（LLM 常照抄样本引号，如 `git commit -m "{{msg}}"`）。
 * 渲染层统一用单引号包裹参数值，模板保留引号会让值被双引号内的字面单引号污染。
 */
export function normalizeDraftTemplate(template: string): string {
  return template.replace(/(["'])\{\{([A-Za-z][A-Za-z0-9_]*)\}\}\1/g, "{{$2}}");
}

/**
 * 草拟 prompt 组装（单次调用：语义化模板 + 工具定义）。
 * @param refined 可选参考模板；主路径不再单独 refine，通常传 null
 */
export function buildDraftPrompt(
  pattern: CommandPattern,
  refined: RefinedPattern | null,
  existingToolNames: readonly string[],
): string {
  const samples = pattern.samples.slice(0, 10).join("\n");
  const refinedHint = refined
    ? [
        "",
        `已有精归一化模板（优先采用，可修正）：${refined.template}`,
        `参数说明：${JSON.stringify(refined.parameterHints, null, 2)}`,
      ].join("\n")
    : "";

  return [
    "你是 Agent 工具设计器。把一组近一周高频重复出现的 shell 命令设计成一个参数化工具，",
    "让 Agent 以后直接调用工具而不是每次重新编写命令。",
    "请在同一次输出中完成：语义化命令模板抽象 + 完整工具定义。",
    "",
    "输出 JSON（只输出 JSON，不要其他文字）：",
    "{",
    '  "name": "<kebab-case 工具名，含动词，如 pnpm-build>",',
    '  "description": "<一句话说明工具做什么，>10 字符>",',
    '  "whenToUse": "<何时使用>",',
    '  "whenNotToUse": "<何时不要用>",',
    '  "parameters": { "type": "object", "properties": { "<参数名>": { "type": "string|number|boolean", "description": "..." } } },',
    '  "commandTemplate": "<命令模板，参数位为 {{语义名}}>",',
    '  "isReadOnly": <布尔值>',
    "}",
    "",
    "硬性要求：",
    "1. commandTemplate 必须能通过参数替换还原下面的每一条样本命令，禁止发明样本中不存在的命令结构；",
    "2. 参数占位符使用语义化命名 {{name}}（如 {{pkg}}、{{script}}、{{branch}}），不能只用 {{path}} 这种模糊名字；",
    "3. parameters.properties 的键必须与模板中的 {{占位符}} 一一对应；",
    "4. 参数类型只能用 string / number / boolean（string 优先）；",
    "5. 以下破坏性命令直接拒绝草拟（返回 {\\\"error\\\": \\\"destructive\\\"}）：",
    "   rm -rf、git reset --hard、git push --force、DROP、TRUNCATE、chmod -R 777、mkfs；",
    `6. 工具名不能与现有工具重名。现有工具：${existingToolNames.join(", ")}；`,
    "7. 模板中参数位不要保留引号：样本里的引号内容已抽象为占位符（如 `git commit -m {{msg}}` 而非 `git commit -m \"{{msg}}\"`）；",
    "",
    `命令模式（规则粗归一化）：${pattern.pattern}`,
    `统计：共 ${pattern.count} 次，失败 ${pattern.errorCount} 次，出现 ${pattern.distinctDays} 天`,
    refinedHint,
    "",
    "真实命令样本：",
    samples,
  ].join("\n");
}

/**
 * 草拟工具定义（单次 LLM）。失败 / 输出非法 / 判定破坏性命令时返回 null。
 */
export async function draftToolFromPattern(
  pattern: CommandPattern,
  refined: RefinedPattern | null,
  deps: DraftToolDeps,
): Promise<ToolDraft | null> {
  const prompt = buildDraftPrompt(pattern, refined, deps.existingToolNames);
  try {
    const output = await deps.callLLM(prompt);
    const parsed = parseJsonObject(output);
    if (!parsed) return null;
    if (parsed.error) return null; // LLM 判定破坏性命令
    if (!isToolDraft(parsed)) return null;
    return { ...parsed, commandTemplate: normalizeDraftTemplate(parsed.commandTemplate) };
  } catch {
    return null;
  }
}
