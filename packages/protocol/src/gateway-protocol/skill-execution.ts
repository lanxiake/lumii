/**
 * 技能执行协议定义
 *
 * 定义 Gateway ↔ Client 之间的技能执行通信协议
 * 支持本地执行、远程执行和混合执行模式
 */

// ============================================================================
// 技能执行请求
// ============================================================================

/**
 * 技能执行模式
 */
export type SkillRunMode =
  | "server" // 服务端执行
  | "local" // 客户端本地执行
  | "hybrid"; // 混合执行 (部分服务端，部分本地)

/**
 * 技能执行请求
 *
 * 从 Gateway 发送到 Client
 */
export interface SkillExecuteRequest {
  /** 请求 ID (用于关联响应) */
  requestId: string;
  /** 技能 ID */
  skillId: string;
  /** 技能名称 (用于显示) */
  skillName?: string;
  /** 执行参数 */
  params: Record<string, unknown>;
  /** 是否需要用户确认 */
  requireConfirm: boolean;
  /** 确认消息 (如果需要确认) */
  confirmMessage?: string;
  /** 执行超时 (毫秒) */
  timeoutMs: number;
  /** 执行模式 */
  runMode: SkillRunMode;
  /** 优先级 (0-10, 10 最高) */
  priority?: number;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 技能执行结果
 *
 * 从 Client 返回到 Gateway
 */
export interface SkillExecuteResult {
  /** 请求 ID (与请求对应) */
  requestId: string;
  /** 是否成功 */
  success: boolean;
  /** 执行结果 (成功时) */
  result?: unknown;
  /** 错误信息 (失败时) */
  error?: SkillExecuteError;
  /** 执行耗时 (毫秒) */
  executionTimeMs: number;
  /** 资源使用情况 */
  resourceUsage?: SkillResourceUsage;
}

/**
 * 技能执行错误
 */
export interface SkillExecuteError {
  /** 错误代码 */
  code: SkillErrorCode;
  /** 错误消息 */
  message: string;
  /** 错误详情 */
  details?: Record<string, unknown>;
  /** 错误堆栈 (调试用) */
  stack?: string;
}

/**
 * 技能错误代码
 */
export type SkillErrorCode =
  | "SKILL_NOT_FOUND" // 技能不存在
  | "SKILL_DISABLED" // 技能已禁用
  | "PERMISSION_DENIED" // 权限不足
  | "USER_CANCELLED" // 用户取消
  | "TIMEOUT" // 执行超时
  | "EXECUTION_ERROR" // 执行错误
  | "INVALID_PARAMS" // 参数无效
  | "RESOURCE_LIMIT" // 资源限制
  | "SANDBOX_VIOLATION" // 沙箱违规
  | "NETWORK_ERROR" // 网络错误
  | "INTERNAL_ERROR"; // 内部错误

/**
 * 资源使用情况
 */
export interface SkillResourceUsage {
  /** CPU 时间 (毫秒) */
  cpuTimeMs?: number;
  /** 内存峰值 (字节) */
  memoryPeakBytes?: number;
  /** 网络请求数 */
  networkRequests?: number;
  /** 文件操作数 */
  fileOperations?: number;
}

// ============================================================================
// 技能权限
// ============================================================================

/**
 * 技能权限类型
 */
export type SkillPermissionType =
  | "fileSystem" // 文件系统访问
  | "network" // 网络访问
  | "process" // 进程操作
  | "clipboard" // 剪贴板访问
  | "notification" // 系统通知
  | "camera" // 摄像头
  | "microphone" // 麦克风
  | "location" // 位置信息
  | "system"; // 系统信息

/**
 * 技能权限声明
 */
export interface SkillPermissions {
  /** 文件系统权限 */
  fileSystem?: {
    /** 允许读取的路径模式 */
    read?: string[];
    /** 允许写入的路径模式 */
    write?: string[];
  };
  /** 网络权限 */
  network?: {
    /** 允许访问的域名 */
    allowedHosts?: string[];
    /** 是否允许所有网络访问 */
    allowAll?: boolean;
  };
  /** 进程权限 */
  process?: {
    /** 允许执行的命令 */
    allowedCommands?: string[];
    /** 是否允许所有命令 */
    allowAll?: boolean;
  };
  /** 是否需要用户确认 */
  requireConfirm?: boolean;
}

// ============================================================================
// 技能元数据
// ============================================================================

/**
 * 技能元数据
 *
 * 描述技能的基本信息和执行要求
 */
export interface SkillMetadata {
  /** 技能 ID */
  id: string;
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description?: string;
  /** 技能版本 */
  version: string;
  /** 作者 */
  author?: string;
  /** 执行模式 */
  runMode: SkillRunMode;
  /** 权限声明 */
  permissions?: SkillPermissions;
  /** 支持的平台 */
  platforms?: Array<"windows" | "macos" | "linux" | "ios" | "android">;
  /** 依赖的二进制文件 */
  requiredBinaries?: string[];
  /** 依赖的环境变量 */
  requiredEnvVars?: string[];
  /** 是否启用 */
  enabled: boolean;
  /** 图标 */
  icon?: string;
  /** 分类 */
  category?: string;
}

// ============================================================================
// 协议事件和方法名称
// ============================================================================

/**
 * 技能执行事件名称
 *
 * Gateway → Client
 */
export const SKILL_EXECUTE_EVENT = "skill.execute.request";

/**
 * 技能执行结果 RPC 方法名称
 *
 * Client → Gateway
 */
export const SKILL_RESULT_METHOD = "assistant.skill.result";

/**
 * 技能列表请求方法
 */
export const SKILL_LIST_METHOD = "assistant.skill.list";

/**
 * 技能元数据请求方法
 */
export const SKILL_METADATA_METHOD = "assistant.skill.metadata";

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 创建技能执行请求
 */
export function createSkillExecuteRequest(
  skillId: string,
  params: Record<string, unknown>,
  options: Partial<Omit<SkillExecuteRequest, "requestId" | "skillId" | "params">> = {},
): SkillExecuteRequest {
  return {
    requestId: generateRequestId(),
    skillId,
    params,
    requireConfirm: options.requireConfirm ?? false,
    timeoutMs: options.timeoutMs ?? 60000,
    runMode: options.runMode ?? "local",
    ...options,
  };
}

/**
 * 创建成功的执行结果
 */
export function createSuccessResult(
  requestId: string,
  result: unknown,
  executionTimeMs: number,
): SkillExecuteResult {
  return {
    requestId,
    success: true,
    result,
    executionTimeMs,
  };
}

/**
 * 创建失败的执行结果
 */
export function createErrorResult(
  requestId: string,
  code: SkillErrorCode,
  message: string,
  executionTimeMs: number,
  details?: Record<string, unknown>,
): SkillExecuteResult {
  return {
    requestId,
    success: false,
    error: { code, message, details },
    executionTimeMs,
  };
}

/**
 * 生成请求 ID
 */
function generateRequestId(): string {
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 检查技能是否支持当前平台
 */
export function isSkillSupportedOnPlatform(
  metadata: SkillMetadata,
  platform: "windows" | "macos" | "linux" | "ios" | "android",
): boolean {
  if (!metadata.platforms || metadata.platforms.length === 0) {
    return true; // 未指定平台限制，默认支持所有
  }
  return metadata.platforms.includes(platform);
}

/**
 * 检查技能权限是否满足
 */
export function checkSkillPermissions(
  metadata: SkillMetadata,
  requestedPermissions: SkillPermissionType[],
): { allowed: boolean; missing: SkillPermissionType[] } {
  const missing: SkillPermissionType[] = [];

  for (const permission of requestedPermissions) {
    const hasPermission = metadata.permissions?.[permission as keyof SkillPermissions];
    if (!hasPermission) {
      missing.push(permission);
    }
  }

  return {
    allowed: missing.length === 0,
    missing,
  };
}
