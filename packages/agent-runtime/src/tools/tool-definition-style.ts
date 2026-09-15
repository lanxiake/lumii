/**
 * 工具定义载荷裁剪（提示词风格实验：极简档）
 *
 * 极简档下，发给模型的工具定义只保留「名称 + 参数 schema」：
 * - 简单工具：删工具级 description，并递归删参数 schema 内的 description；
 * - 复杂工具（参数 ≥ 5 或组合流程类）：整条定义原样保留——其描述即使用提示。
 *
 * 只影响发往模型的定义载荷（pi-ai convertTools 读取 name/description/parameters），
 * 不影响工具执行：裁剪产生浅拷贝，execute 等其余字段引用不变。
 */

import type { PromptStyle } from "../prompt/system-prompt.types.js"

/** 参数数量达到该值即视为复杂工具（保留完整定义） */
export const COMPLEX_TOOL_MIN_PARAMS = 5

/**
 * 组合流程类工具：用法依赖跨工具协作（先查后读 / 先列后发 / 引导先行），
 * 名称与参数不足以表达，保留完整定义。
 */
export const COMPLEX_TOOL_NAMES: ReadonlySet<string> = new Set([
  // 通用执行：内含「专用工具优先」等行为契约
  "bash",
  // 委派与编排
  "spawn_agent",
  "send_message",
  "todo_write",
  "task_complete",
  // 调度（参数格式复杂，需先调 cron_guide）
  "cron_create",
  "cron_guide",
  // 技能流程（搜索 → 加载 → 执行）
  "skill_search",
  "skill_invoke",
  "execute_skill",
  // 记忆与知识（读取有顺序约束）
  "memory_search",
  "memory_read",
  "memory_manage",
  "scene_memory",
  "wiki_overview",
  "wiki_search",
  "wiki_read",
  // 渠道投递（先列后发 / NO_REPLY 流程）
  "message",
  "channel_list",
  "channel_send",
  "weixin_send_guide",
  // 会话与交互
  "session_list",
  "session_resume",
  "ask_user_question",
  // 渐进式加载引导（描述即「何时调用」）
  "prompt_guide",
  "a2ui_guide",
])

/** 工具定义的最小结构（AgentTool / MtBotTool 均满足） */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
}

/** 顶层参数数量（properties 计数；结构不符合时按 0 处理） */
function countParams(parameters: unknown): number {
  if (!parameters || typeof parameters !== "object") return 0
  const props = (parameters as { properties?: unknown }).properties
  if (!props || typeof props !== "object") return 0
  return Object.keys(props).length
}

/** 是否复杂工具：参数多，或属组合流程清单 / 浏览器交互循环 */
export function isComplexTool(name: string, parameters: unknown): boolean {
  if (COMPLEX_TOOL_NAMES.has(name)) return true
  if (name.startsWith("browser_")) return true
  return countParams(parameters) >= COMPLEX_TOOL_MIN_PARAMS
}

/**
 * 递归移除 JSON Schema 内的 description 字段。
 * 保留类型 / 必填 / 枚举 / 嵌套结构与符号键（TypeBox 的 Kind 标记）。
 */
function stripSchemaDescriptions<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map((item) => stripSchemaDescriptions(item)) as unknown as T
  }
  if (node === null || typeof node !== "object") return node
  const out: Record<string | symbol, unknown> = { ...(node as object) }
  delete (out as { description?: unknown }).description
  for (const key of Object.keys(out)) {
    out[key] = stripSchemaDescriptions(out[key])
  }
  return out as T
}

/** 裁剪单条工具定义：工具级 description 置空，参数 schema 去描述 */
export function stripToolDefinition<T extends ToolDefinitionLike>(tool: T): T {
  return {
    ...tool,
    description: "",
    parameters: stripSchemaDescriptions(tool.parameters),
  }
}

/**
 * 按风格产出工具定义：极简档裁剪简单工具；其余风格原样返回（同一数组引用）。
 */
export function applyToolDefinitionStyle<T extends ToolDefinitionLike>(
  tools: readonly T[],
  style: PromptStyle,
): readonly T[] {
  if (style !== "minimal") return tools
  return tools.map((tool) =>
    isComplexTool(tool.name, tool.parameters) ? tool : stripToolDefinition(tool),
  )
}
