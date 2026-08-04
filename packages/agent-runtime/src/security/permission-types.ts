/**
 * 安全权限类型定义
 *
 * PermissionMode, PermissionRule, PermissionDecision 等核心类型。
 * 设计依据: .qoder/design/client-agent-runtime/09-安全与权限模型.md §2-§4
 */

// ============================================================
// 权限模式
// ============================================================

/**
 * MtBot PermissionMode — 客户端 Agent 运行时的权限控制模式
 *
 * 与 Claude Code 不同，MtBot 不需要 'auto'(分类器) 和 'plan'(规划) 模式，
 * 因为客户端运行时场景更聚焦。
 */
export type PermissionMode =
  | "default" // 危险操作需用户确认
  | "acceptEdits" // 自动接受文件编辑，其他危险操作仍需确认
  | "readOnly" // 只允许只读工具，所有写操作自动拒绝
  | "unrestricted" // 无限制，跳过所有权限检查
  | "bubble"; // 子 Agent 专用：权限请求冒泡到父级 UI

/** 用户可通过 UI 设置的外部模式（不含 bubble） */
export type ExternalPermissionMode = Exclude<PermissionMode, "bubble">;

// ============================================================
// 权限规则
// ============================================================

/** 权限行为: 允许 / 拒绝 / 需要确认 */
export type PermissionBehavior = "allow" | "deny" | "ask";

/** 规则来源，决定优先级（高 → 低） */
export type PermissionRuleSource =
  | "system" // 系统内置（最高优先级）
  | "user" // 用户全局配置
  | "agent" // Agent 定义中的权限声明
  | "session"; // 运行时会话级（最低优先级）

/** 规则匹配条件 */
export interface PermissionRuleValue {
  /** 工具名称，支持通配符 (e.g., 'Bash', 'Edit', '*') */
  readonly toolName: string;
  /** 可选: 内容模式匹配 (e.g., 'rm -rf *', '/etc/**') */
  readonly contentPattern?: string;
}

/** 完整的权限规则 */
export interface PermissionRule {
  readonly source: PermissionRuleSource;
  readonly behavior: PermissionBehavior;
  readonly value: PermissionRuleValue;
}

// ============================================================
// 权限判定结果
// ============================================================

export type PermissionDecision =
  | PermissionAllowDecision
  | PermissionAskDecision
  | PermissionDenyDecision;

export interface PermissionAllowDecision {
  readonly behavior: "allow";
  readonly updatedInput?: Record<string, unknown>;
  readonly reason?: PermissionDecisionReason;
}

export interface PermissionAskDecision {
  readonly behavior: "ask";
  readonly message: string;
  readonly suggestions?: readonly PermissionUpdate[];
}

export interface PermissionDenyDecision {
  readonly behavior: "deny";
  readonly message: string;
  readonly reason: PermissionDecisionReason;
}

/** 判定原因追踪（用于审计和调试） */
export type PermissionDecisionReason =
  | { readonly type: "rule"; readonly rule: PermissionRule }
  | { readonly type: "mode"; readonly mode: PermissionMode }
  | { readonly type: "tool"; readonly toolName: string; readonly detail: string }
  | { readonly type: "user"; readonly action: "allow" | "deny" | "abort" }
  | { readonly type: "bubble"; readonly parentDecision: PermissionDecision };

// ============================================================
// 权限更新
// ============================================================

export type PermissionUpdate =
  | {
      readonly type: "addRules";
      readonly destination: "user" | "agent" | "session";
      readonly rules: readonly PermissionRuleValue[];
      readonly behavior: PermissionBehavior;
    }
  | {
      readonly type: "setMode";
      readonly destination: "user" | "session";
      readonly mode: ExternalPermissionMode;
    };

// ============================================================
// 工具权限检查接口
// ============================================================

/**
 * 工具自身的权限检查接口
 *
 * 每个工具可选实现此接口，在全局规则之后提供工具特定的权限判断。
 */
export interface ToolPermissionChecker {
  /** 工具自身的权限检查逻辑 */
  checkPermission(toolInput: Record<string, unknown>, mode: PermissionMode): PermissionDecision;
}

// ============================================================
// 规则来源优先级顺序
// ============================================================

/** 规则来源优先级（高 → 低） */
export const RULE_SOURCE_PRIORITY: readonly PermissionRuleSource[] = [
  "system",
  "user",
  "agent",
  "session",
] as const;

/**
 * 写操作工具名集合
 *
 * 包含两种命名约定：
 * - PascalCase: 网关侧工具名（Bash, Edit, Write, NotebookEdit）
 * - snake_case: 客户端 agent-runtime 工具名（bash, file_edit, file_write）
 */
export const WRITE_TOOL_NAMES = new Set([
  // 网关侧 (PascalCase)
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  // 客户端 agent-runtime (snake_case)
  "bash",
  "file_edit",
  "file_write",
  "notebook_edit",
]);
