/**
 * ToolPermissionContext — 按来源分组的权限规则存储
 *
 * 管理权限模式和规则集合，提供规则匹配查询方法。
 * 设计依据: .qoder/design/client-agent-runtime/09-安全与权限模型.md §3.3
 */

import type {
  PermissionMode,
  PermissionBehavior,
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionRule,
} from "./permission-types";
import { RULE_SOURCE_PRIORITY } from "./permission-types";
import type { ParameterizedToolPermission } from "./param-permission-parser";
import { parseToolPermissionSpec, extractToolName } from "./param-permission-parser";
import type { AgentTurnOrigin } from "@mtbot/protocol";

/** 按来源分组的规则集合 */
export type RulesBySource = {
  readonly [S in PermissionRuleSource]?: readonly string[];
};

/** 权限上下文: 按行为和来源分组存储规则 */
export interface ToolPermissionContext {
  readonly mode: PermissionMode;
  readonly alwaysAllowRules: RulesBySource;
  readonly alwaysDenyRules: RulesBySource;
  readonly alwaysAskRules: RulesBySource;
  /** 参数级工具权限约束（如 "bash(git:*)"），由子 Agent 的 allowedTools 解析而来 */
  readonly parameterConstraints?: readonly ParameterizedToolPermission[];
  /** turn 来源（local_ui / cloud_channel / subagent / scheduled / internal），默认 local_ui */
  readonly origin?: AgentTurnOrigin;
}

/**
 * 创建默认的权限上下文
 */
export function createPermissionContext(mode: PermissionMode = "default", origin: AgentTurnOrigin = "local_ui"): ToolPermissionContext {
  return {
    mode,
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    origin,
  };
}

/**
 * 向上下文中添加规则
 *
 * 返回新的 context（不可变更新）
 */
export function addRules(
  ctx: ToolPermissionContext,
  source: PermissionRuleSource,
  behavior: PermissionBehavior,
  ruleKeys: readonly string[],
): ToolPermissionContext {
  const rulesField =
    behavior === "allow"
      ? "alwaysAllowRules"
      : behavior === "deny"
        ? "alwaysDenyRules"
        : "alwaysAskRules";

  const existingRules = ctx[rulesField][source] ?? [];
  const mergedRules = [...existingRules, ...ruleKeys];

  return {
    ...ctx,
    [rulesField]: {
      ...ctx[rulesField],
      [source]: mergedRules,
    },
  };
}

/**
 * 更新权限模式
 */
export function withMode(ctx: ToolPermissionContext, mode: PermissionMode): ToolPermissionContext {
  return { ...ctx, mode };
}

/**
 * 将 PermissionRuleValue 编码为字符串 key
 *
 * 格式: "toolName" 或 "toolName:contentPattern"
 */
export function encodeRuleKey(value: PermissionRuleValue): string {
  if (value.contentPattern) {
    return `${value.toolName}:${value.contentPattern}`;
  }
  return value.toolName;
}

/**
 * 解码字符串 key 为 PermissionRuleValue
 */
export function decodeRuleKey(key: string): PermissionRuleValue {
  const colonIdx = key.indexOf(":");
  if (colonIdx === -1) {
    return { toolName: key };
  }
  return {
    toolName: key.slice(0, colonIdx),
    contentPattern: key.slice(colonIdx + 1),
  };
}

/**
 * 在规则集合中查找匹配的规则
 *
 * 按来源优先级从高到低查找，返回第一个匹配的规则。
 *
 * @param rules - 按来源分组的规则 key 集合
 * @param toolName - 要匹配的工具名称
 * @param toolInput - 工具输入参数（用于内容模式匹配）
 * @param behavior - 规则行为类型
 */
export function findMatchingRule(
  rules: RulesBySource,
  toolName: string,
  toolInput: Record<string, unknown>,
  behavior: PermissionBehavior,
): PermissionRule | null {
  for (const source of RULE_SOURCE_PRIORITY) {
    const ruleKeys = rules[source];
    if (!ruleKeys) continue;

    for (const key of ruleKeys) {
      const ruleValue = decodeRuleKey(key);
      if (matchesRule(ruleValue, toolName, toolInput)) {
        return { source, behavior, value: ruleValue };
      }
    }
  }

  return null;
}

/**
 * 检查工具调用是否匹配规则
 */
function matchesRule(
  ruleValue: PermissionRuleValue,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  // 1. 工具名匹配
  if (ruleValue.toolName !== "*" && ruleValue.toolName !== toolName) {
    return false;
  }

  // 2. 内容模式匹配（如果规则定义了 contentPattern）
  if (ruleValue.contentPattern) {
    const content = extractContentForMatching(toolName, toolInput);
    if (!content) return false;
    return matchGlob(ruleValue.contentPattern, content);
  }

  return true;
}

/**
 * 从工具输入中提取用于匹配的内容
 */
function extractContentForMatching(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  switch (toolName) {
    case "Bash":
      return (toolInput.command as string) ?? null;
    case "Edit":
    case "Write":
    case "Read":
      return (toolInput.file_path as string) ?? null;
    default:
      return null;
  }
}

/**
 * 简化的 glob 匹配
 *
 * 支持 '*' 匹配任意字符序列和 '**' 匹配任意路径层级。
 */
function matchGlob(pattern: string, input: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*");

  return new RegExp(`^${regexStr}$`).test(input);
}

/**
 * 构建子 Agent 的权限上下文
 *
 * 子 Agent 继承父级的 deny 规则，重置 session 级 allow 规则。
 * allowedTools 支持参数级语法（如 "bash(git:*)"），自动分离为：
 * - 纯工具名 → alwaysAllowRules.session
 * - 参数级约束 → parameterConstraints
 *
 * 设计依据: 09-安全与权限模型.md §8.4
 */
export function buildChildPermissionContext(
  parentContext: ToolPermissionContext,
  childMode: PermissionMode,
  allowedTools?: readonly string[],
  parameterConstraints?: readonly ParameterizedToolPermission[],
): ToolPermissionContext {
  // 分离 allowedTools 中的参数级语法和纯工具名
  const { toolNames: sessionAllowKeys, constraints: parsedConstraints } =
    separateParameterizedSpecs(allowedTools);

  return {
    mode: childMode,
    // 继承父级的 deny 规则（安全规则不可削弱）
    alwaysDenyRules: parentContext.alwaysDenyRules,
    alwaysAllowRules: {
      system: parentContext.alwaysAllowRules.system,
      user: parentContext.alwaysAllowRules.user,
      agent: undefined,
      session: sessionAllowKeys.length > 0 ? sessionAllowKeys : undefined,
    },
    alwaysAskRules: {
      system: parentContext.alwaysAskRules.system,
      user: parentContext.alwaysAskRules.user,
    },
    // 参数级约束：显式传入 + 从 allowedTools 解析出的 + 父级继承的
    parameterConstraints: mergeParameterConstraints(
      parentContext.parameterConstraints,
      parameterConstraints,
      parsedConstraints,
    ),
  };
}

/**
 * 分离 allowedTools 列表中的参数级语法和纯工具名
 *
 * "bash(git:*)" → 解析为 ParameterizedToolPermission + 提取工具名 "bash" 放入 allow 列表
 * "file_read" → 直接放入 allow 列表
 */
function separateParameterizedSpecs(specs?: readonly string[]): {
  toolNames: readonly string[];
  constraints: readonly ParameterizedToolPermission[];
} {
  if (!specs?.length) return { toolNames: [], constraints: [] };

  const toolNames: string[] = [];
  const constraints: ParameterizedToolPermission[] = [];

  for (const spec of specs) {
    const parsed = parseToolPermissionSpec(spec);
    if (parsed) {
      // 参数级语法：工具名放入 allow，约束放入 constraints
      toolNames.push(parsed.toolName);
      constraints.push(parsed);
    } else {
      // 纯工具名
      toolNames.push(spec);
    }
  }

  return { toolNames, constraints };
}

/**
 * 合并参数级约束（取交集语义：子级约束不可超越父级）
 *
 * 当父子都有同一工具的约束时，子级必须同时满足父级和自身约束。
 * 通过保留所有约束并在 checkParameterConstraints 中使用 AND 语义实现。
 */
function mergeParameterConstraints(
  parent?: readonly ParameterizedToolPermission[],
  explicit?: readonly ParameterizedToolPermission[],
  parsed?: readonly ParameterizedToolPermission[],
): readonly ParameterizedToolPermission[] | undefined {
  const all = [...(parent ?? []), ...(explicit ?? []), ...(parsed ?? [])];
  return all.length > 0 ? all : undefined;
}
