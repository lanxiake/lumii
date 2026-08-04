/**
 * 权限检查管线
 *
 * 五步管线实现: deny→allow→工具自身→permissionMode→用户确认
 * 设计依据: .qoder/design/client-agent-runtime/09-安全与权限模型.md §4.1
 */

import type { PermissionDecision, PermissionMode, ToolPermissionChecker } from "./permission-types";
import { WRITE_TOOL_NAMES } from "./permission-types";
import type { ToolPermissionContext } from "./permission-context";
import { findMatchingRule } from "./permission-context";
import type { PermissionMemory } from "./permission-memory";
import { checkParameterConstraints } from "./param-permission-parser";

/**
 * 权限检查结果 — 如果需要用户确认，消费方需要异步等待用户响应
 */
export type PermissionCheckResult =
  | { readonly outcome: "allowed"; readonly decision: PermissionDecision }
  | { readonly outcome: "denied"; readonly decision: PermissionDecision }
  | { readonly outcome: "needs_confirmation"; readonly decision: PermissionDecision };

/**
 * 执行权限检查管线
 *
 * 管线概览:
 * 1. deny 规则匹配检查
 * 2. allow 规则匹配检查
 * 3. 工具自身 checkPermission()
 * 4. permissionMode 判断
 * 5. 需要用户确认（返回 needs_confirmation）
 *
 * @param ctx - 权限上下文（包含规则和模式）
 * @param toolName - 工具名称
 * @param toolInput - 工具输入参数
 * @param toolChecker - 工具自身的权限检查器（可选）
 * @param memory - 用户近期「允许并记住」的进程内缓存（可选，在 mode 判断之前生效）
 */
export function checkPermission(
  ctx: ToolPermissionContext,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolChecker?: ToolPermissionChecker,
  memory?: Pick<PermissionMemory, "getDecision">,
): PermissionCheckResult {
  // Step 1: deny 规则匹配
  const denyRule = findMatchingRule(ctx.alwaysDenyRules, toolName, toolInput, "deny");
  if (denyRule) {
    return {
      outcome: "denied",
      decision: {
        behavior: "deny",
        message: `Tool "${toolName}" is blocked by deny rule`,
        reason: { type: "rule", rule: denyRule },
      },
    };
  }

  // Step 1.5: 参数级约束检查（优先于 allow 规则，确保参数约束不会被绕过）
  if (ctx.parameterConstraints?.length) {
    const paramResult = checkParameterConstraints(ctx.parameterConstraints, toolName, toolInput);
    if (paramResult === "denied") {
      return {
        outcome: "denied",
        decision: {
          behavior: "deny",
          message: `Tool "${toolName}" call does not satisfy parameter constraints`,
          reason: { type: "mode", mode: ctx.mode },
        },
      };
    }
    // paramResult === 'allowed' 或 'not_applicable' → 继续
  }

  // Step 2: allow 规则匹配
  const allowRule = findMatchingRule(ctx.alwaysAllowRules, toolName, toolInput, "allow");
  if (allowRule) {
    return {
      outcome: "allowed",
      decision: {
        behavior: "allow",
        reason: { type: "rule", rule: allowRule },
      },
    };
  }

  // Step 3: 工具自身 checkPermission()
  if (toolChecker) {
    const toolDecision = toolChecker.checkPermission(toolInput, ctx.mode);
    if (toolDecision.behavior === "deny") {
      return { outcome: "denied", decision: toolDecision };
    }
    if (toolDecision.behavior === "allow") {
      return { outcome: "allowed", decision: toolDecision };
    }
    // behavior === 'ask' → 继续到 Step 4
  }

  // Step 4: permissionMode 判断（记忆仅用于跳过「需确认」，不绕过 readOnly 等硬拒绝）
  return checkByMode(ctx.mode, toolName, toolInput, memory);
}

/**
 * 若即将要求用户确认，先查进程内记忆是否已允许同类工具
 */
function allowIfRemembered(
  toolName: string,
  memory: Pick<PermissionMemory, "getDecision"> | undefined,
): PermissionCheckResult | null {
  if (!memory) return null;
  if (memory.getDecision(toolName) === true) {
    return {
      outcome: "allowed",
      decision: {
        behavior: "allow",
        reason: { type: "user", action: "allow" },
      },
    };
  }
  return null;
}

/**
 * 根据 PermissionMode 判断权限
 */
function checkByMode(
  mode: PermissionMode,
  toolName: string,
  toolInput: Record<string, unknown>,
  memory?: Pick<PermissionMemory, "getDecision">,
): PermissionCheckResult {
  switch (mode) {
    case "unrestricted": {
      return {
        outcome: "allowed",
        decision: {
          behavior: "allow",
          reason: { type: "mode", mode: "unrestricted" },
        },
      };
    }

    case "readOnly": {
      if (WRITE_TOOL_NAMES.has(toolName)) {
        return {
          outcome: "denied",
          decision: {
            behavior: "deny",
            message: `Tool "${toolName}" is a write operation, blocked in readOnly mode`,
            reason: { type: "mode", mode: "readOnly" },
          },
        };
      }
      return {
        outcome: "allowed",
        decision: {
          behavior: "allow",
          reason: { type: "mode", mode: "readOnly" },
        },
      };
    }

    case "acceptEdits": {
      // 文件编辑类工具自动通过
      if (
        toolName === "Edit" ||
        toolName === "Write" ||
        toolName === "file_edit" ||
        toolName === "file_write"
      ) {
        return {
          outcome: "allowed",
          decision: {
            behavior: "allow",
            reason: { type: "mode", mode: "acceptEdits" },
          },
        };
      }
      // 其他工具仍需确认
      {
        const remembered = allowIfRemembered(toolName, memory);
        if (remembered) return remembered;
      }
      return {
        outcome: "needs_confirmation",
        decision: {
          behavior: "ask",
          message: buildConfirmationMessage(toolName, toolInput),
        },
      };
    }

    case "bubble": {
      {
        const remembered = allowIfRemembered(toolName, memory);
        if (remembered) return remembered;
      }
      // bubble 模式: 返回需要确认，由父级处理
      return {
        outcome: "needs_confirmation",
        decision: {
          behavior: "ask",
          message: buildConfirmationMessage(toolName, toolInput),
        },
      };
    }

    case "default":
    default: {
      // default 模式: 只读工具自动通过，写操作需确认
      if (!WRITE_TOOL_NAMES.has(toolName)) {
        return {
          outcome: "allowed",
          decision: {
            behavior: "allow",
            reason: { type: "mode", mode: "default" },
          },
        };
      }
      {
        const remembered = allowIfRemembered(toolName, memory);
        if (remembered) return remembered;
      }
      return {
        outcome: "needs_confirmation",
        decision: {
          behavior: "ask",
          message: buildConfirmationMessage(toolName, toolInput),
        },
      };
    }
  }
}

/**
 * 构建用户确认消息
 */
function buildConfirmationMessage(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
    case "bash": {
      const cmd = (toolInput.command as string) ?? "<unknown>";
      const truncated = cmd.length > 500 ? `${cmd.slice(0, 500)}...` : cmd;
      return `执行命令：${truncated}`;
    }
    case "Edit":
    case "file_edit": {
      const filePath = (toolInput.file_path as string) ?? "<unknown>";
      return `编辑文件：${filePath}`;
    }
    case "Write":
    case "file_write": {
      const filePath = (toolInput.file_path as string) ?? "<unknown>";
      return `写入文件：${filePath}`;
    }
    case "Read":
    case "file_read": {
      const filePath = (toolInput.file_path as string) ?? "<unknown>";
      return `读取文件：${filePath}`;
    }
    default:
      return `执行工具：${toolName}`;
  }
}

/**
 * 解析子 Agent 的 permissionMode
 *
 * 父级高权限模式优先于子 Agent 声明。
 * 设计依据: 09-安全与权限模型.md §2.4
 */
export function resolveChildPermissionMode(
  parentMode: PermissionMode,
  childDeclaredMode?: PermissionMode,
): PermissionMode {
  // 父级为 unrestricted 或 acceptEdits → 忽略子 Agent 声明
  if (parentMode === "unrestricted" || parentMode === "acceptEdits") {
    return parentMode;
  }
  // 使用子 Agent 声明的模式，未声明则继承父级
  return childDeclaredMode ?? parentMode;
}

/**
 * readOnly 模式下的工具过滤
 *
 * 在子 Agent 初始化时执行，过滤写工具。
 * 比在权限管线中逐次拒绝更高效。
 */
export function filterToolsForReadOnly<T extends { name: string }>(
  tools: readonly T[],
): readonly T[] {
  return tools.filter((tool) => !WRITE_TOOL_NAMES.has(tool.name));
}
