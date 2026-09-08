/**
 * RefinePatterns — LLM 辅助归一化
 *
 * 规则归一化（command-miner）对命令结构假设有限：嵌套引号、heredoc、
 * 命令替换 $(...)、管道等都会漏掉或误抽象，且参数只能叫 {{path}}/{{num}}
 * 这种无语义的名字。
 *
 * 本模块用 LLM 做第二级精修：把同一粗簇的真实样本交给模型，
 * 输出语义化的精确模板（如 {{pkg}} / {{script}}）与参数说明，
 * 同时天然产出「参数化工具」草稿所需的参数名与语义。
 *
 * LLM 失败时返回 null，调用方回退到规则模式，不影响主链路。
 */

import type { CommandPattern } from "./command-miner.js";

export interface RefinedPattern {
  /** 精确模板：参数位为 {{语义名}}，其余保持真实命令结构 */
  template: string;
  /** 参数名 → 一句话说明（供工具草拟的 schema 描述使用） */
  parameterHints: Record<string, string>;
}

export interface RefinePatternDeps {
  /** 注入的 LLM 调用（宿主导入会话模型，三级降级由宿主负责） */
  callLLM: (prompt: string) => Promise<string>;
}

/** 从 LLM 输出中稳健地提取 JSON 对象（容忍 markdown 代码块包裹） */
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

function isRefinedPattern(value: unknown): value is RefinedPattern {
  const v = value as Record<string, unknown>;
  if (typeof v?.template !== "string" || v.template.length === 0) return false;
  const hints = v.parameterHints;
  if (typeof hints !== "object" || hints === null) return false;
  for (const val of Object.values(hints)) {
    if (typeof val !== "string") return false;
  }
  return true;
}

/**
 * 用 LLM 把粗模式精修为语义化模板
 *
 * @param pattern 规则挖掘出的粗模式（含原始样本）
 * @returns 精修结果；LLM 失败 / 输出非法时返回 null
 */
export async function refinePatternWithLLM(
  pattern: CommandPattern,
  deps: RefinePatternDeps,
): Promise<RefinedPattern | null> {
  const samples = pattern.samples.slice(0, 10).join("\n");
  const prompt = [
    "你是 shell 命令模式分析器。给定一组由同一个规则模式聚合的真实命令，",
    "把它们抽象为一个精确的命令模板。",
    "",
    "要求：",
    "1. 模板必须能通过参数替换还原每一条样本命令；",
    "2. 参数占位符使用语义化命名 {{name}}（如 {{pkg}}、{{script}}、{{branch}}），",
    "   同一概念用同一占位符，不能只用 {{path}} 这种模糊名字；",
    "3. 保留命令结构（命令名、子命令、flags、管道与重定向），只抽象参数位；",
    "4. 只输出 JSON，不要其他文字。",
    "",
    "输出格式：",
    '{"template": "<精确模板>", "parameterHints": {"<参数名>": "<一句话说明>", ...}}',
    "",
    `规则粗模式：${pattern.pattern}`,
    "",
    "真实命令样本：",
    samples,
  ].join("\n");

  try {
    const output = await deps.callLLM(prompt);
    const parsed = parseJsonObject(output);
    if (!isRefinedPattern(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
