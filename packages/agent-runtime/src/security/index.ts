/**
 * 安全与权限模块入口
 */

// 类型导出
export type {
  PermissionMode,
  ExternalPermissionMode,
  PermissionBehavior,
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionRule,
  PermissionDecision,
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDenyDecision,
  PermissionDecisionReason,
  PermissionUpdate,
  ToolPermissionChecker,
} from "./permission-types";
export { RULE_SOURCE_PRIORITY, WRITE_TOOL_NAMES } from "./permission-types";

// 权限上下文
export type { ToolPermissionContext, RulesBySource } from "./permission-context";
export {
  createPermissionContext,
  addRules,
  withMode,
  encodeRuleKey,
  decodeRuleKey,
  findMatchingRule,
  buildChildPermissionContext,
} from "./permission-context";

// 权限检查管线
export type { PermissionCheckResult } from "./permission-checker";
export {
  checkPermission,
  resolveChildPermissionMode,
  filterToolsForReadOnly,
} from "./permission-checker";

// 参数级工具权限
export type { ParameterizedToolPermission, ToolParamConstraint } from "./param-permission-parser";
export {
  parseToolPermissionSpec,
  extractToolName,
  matchesParameterizedPermission,
  checkParameterConstraints,
} from "./param-permission-parser";

// 工具沙箱
export {
  validatePath,
  normalizePath,
  sanitizeEnv,
  isSensitiveEnvKey,
  listSensitiveEnvKeys,
} from "./tool-sandbox";

// 权限记忆
export { PermissionMemory, DEFAULT_PERMISSION_MEMORY_MS } from "./permission-memory";
