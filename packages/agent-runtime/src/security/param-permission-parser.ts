/**
 * 参数级工具权限解析器
 *
 * 支持 "bash(git:*)" 等参数级权限声明语法，用于精确限制子 Agent 的工具参数范围。
 *
 * 语法格式: toolName(constraint1,constraint2)
 * - constraint: prefix:pattern（prefix 为参数前缀，pattern 为 glob 模式）
 * - 示例: "bash(git:*)" — bash 工具的 command 参数必须以 "git" 开头
 * - 示例: "file_read(workspace/**)" — file_read 的 file_path 必须在 workspace/ 下
 *
 * 设计参考: Claude Code Agent 的参数化权限模型
 */

/**
 * 参数级工具权限声明
 */
export interface ParameterizedToolPermission {
  /** 工具名称（不含括号部分） */
  readonly toolName: string;
  /** 参数约束列表 */
  readonly constraints: readonly ToolParamConstraint[];
}

/**
 * 单个参数约束
 */
export interface ToolParamConstraint {
  /** 约束前缀（如 "git"、"workspace"） */
  readonly prefix: string;
  /** glob 模式（如 "*"、"**"） */
  readonly pattern: string;
}

/** 解析语法的正则：toolName(constraint1,constraint2) */
const PARAMETERIZED_SPEC_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\((.+)\)$/;

/** 约束分隔的正则：prefix:pattern */
const CONSTRAINT_RE = /^(.+?):(.+)$/;

/**
 * 解析参数级权限声明
 *
 * @param spec - 如 "bash(git:*)" 或 "file_read(workspace/**)"
 * @returns 解析结果，如果不含括号则返回 null（表示普通工具名）
 *
 * @example
 * parseToolPermissionSpec("bash(git:*)")
 * // → { toolName: "bash", constraints: [{ prefix: "git", pattern: "*" }] }
 *
 * parseToolPermissionSpec("file_read")
 * // → null（普通工具名，无参数级约束）
 */
export function parseToolPermissionSpec(spec: string): ParameterizedToolPermission | null {
  const match = spec.match(PARAMETERIZED_SPEC_RE);
  if (!match) return null;

  const toolName = match[1];
  const constraintsPart = match[2];

  const constraints: ToolParamConstraint[] = [];
  for (const raw of constraintsPart.split(",")) {
    const trimmed = raw.trim();
    const cMatch = trimmed.match(CONSTRAINT_RE);
    if (cMatch) {
      constraints.push({ prefix: cMatch[1], pattern: cMatch[2] });
    } else {
      // 没有冒号的约束视为 prefix:*
      constraints.push({ prefix: trimmed, pattern: "*" });
    }
  }

  return { toolName, constraints };
}

/**
 * 从权限声明中提取工具名（无论是否含参数级约束）
 *
 * @example
 * extractToolName("bash(git:*)") → "bash"
 * extractToolName("file_read") → "file_read"
 * extractToolName("*") → "*"
 */
export function extractToolName(spec: string): string {
  const parsed = parseToolPermissionSpec(spec);
  return parsed ? parsed.toolName : spec;
}

/**
 * 检查工具调用是否满足参数约束
 *
 * 所有约束必须至少满足一个（OR 语义）。
 * 每个约束检查工具的主要参数是否以 prefix 开头，且满足 glob pattern。
 *
 * @param permission - 参数级权限声明
 * @param toolName - 实际调用的工具名
 * @param toolInput - 工具输入参数
 * @returns true 表示工具调用满足约束
 */
export function matchesParameterizedPermission(
  permission: ParameterizedToolPermission,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  // 工具名不匹配直接失败
  if (permission.toolName !== toolName) return false;

  // 无约束 = 允许所有参数
  if (permission.constraints.length === 0) return true;

  // 提取工具的主要参数值
  const mainParam = extractMainParam(toolName, toolInput);
  if (mainParam === null) return false;

  // 任意一个约束满足即可（OR 语义）
  return permission.constraints.some((c) => matchConstraint(c, mainParam));
}

/**
 * 从参数级权限列表中检查工具调用是否被允许
 *
 * 语义：同一工具名的多条约束使用 AND 逻辑（全部满足才允许）。
 * 这保证子 Agent 不能通过添加约束来扩大父级的权限范围。
 *
 * @returns "allowed" | "denied" | "not_applicable"
 */
export function checkParameterConstraints(
  constraints: readonly ParameterizedToolPermission[],
  toolName: string,
  toolInput: Record<string, unknown>,
): "allowed" | "denied" | "not_applicable" {
  // 筛选出针对该工具的约束
  const relevantConstraints = constraints.filter((c) => c.toolName === toolName);
  if (relevantConstraints.length === 0) return "not_applicable";

  // AND 语义：所有约束都必须满足
  const allSatisfied = relevantConstraints.every((c) =>
    matchesParameterizedPermission(c, toolName, toolInput),
  );
  return allSatisfied ? "allowed" : "denied";
}

// ==================== 内部函数 ====================

/**
 * 从工具输入中提取主要参数
 *
 * 约定：每种工具有一个"主要参数"用于参数级约束匹配。
 */
function extractMainParam(toolName: string, toolInput: Record<string, unknown>): string | null {
  switch (toolName) {
    // Shell 工具：主参数是 command
    case "Bash":
    case "bash":
      return (toolInput.command as string) ?? null;

    // 文件工具：主参数是 file_path
    case "Read":
    case "Write":
    case "Edit":
    case "file_read":
    case "file_write":
    case "file_edit":
      return (toolInput.file_path as string) ?? null;

    // Glob：主参数是 pattern
    case "glob":
      return (toolInput.pattern as string) ?? null;

    // Grep：主参数是 path
    case "grep":
      return (toolInput.path as string) ?? null;

    // Web：主参数是 url
    case "web_fetch":
    case "web_search":
      return (toolInput.url as string) ?? (toolInput.query as string) ?? null;

    default:
      return null;
  }
}

/**
 * 检查单个约束是否满足
 *
 * 约束 {prefix: "git", pattern: "*"} 要求主参数以 "git" 开头。
 * pattern 部分做 glob 匹配（匹配 prefix 之后的内容）。
 */
function matchConstraint(constraint: ToolParamConstraint, value: string): boolean {
  const trimmedValue = value.trim();

  // 检查值是否以 prefix 开头
  if (!trimmedValue.startsWith(constraint.prefix)) return false;

  // prefix 之后的剩余内容做 glob 匹配
  const remainder = trimmedValue.slice(constraint.prefix.length);

  // 如果 pattern 是 "*"，匹配任意内容
  if (constraint.pattern === "*") return true;
  if (constraint.pattern === "**") return true;

  // 通用 glob 匹配
  return matchGlob(constraint.pattern, remainder);
}

/**
 * 简化 glob 匹配（复用 permission-context.ts 中的逻辑）
 */
function matchGlob(pattern: string, input: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");

  return new RegExp(`^${regexStr}$`).test(input);
}
