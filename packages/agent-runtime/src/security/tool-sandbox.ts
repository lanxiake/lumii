/**
 * 工具沙箱 — 路径穿越防护 + 环境变量清洗
 *
 * 设计依据: .qoder/design/client-agent-runtime/09-安全与权限模型.md §6.2
 */

import path from "node:path";

// ============================================================
// 路径穿越防护
// ============================================================

/**
 * 验证文件路径是否在允许的工作目录范围内
 *
 * 防止 Agent 通过 `../` 等路径穿越访问受保护目录。
 *
 * @param filePath - 要验证的文件路径
 * @param allowedDirectories - 允许访问的目录列表
 * @returns true 表示路径合法，false 表示路径穿越
 */
export function validatePath(filePath: string, allowedDirectories: readonly string[]): boolean {
  if (allowedDirectories.length === 0) return false;

  const resolved = path.resolve(filePath);
  return allowedDirectories.some((dir) => {
    const resolvedDir = path.resolve(dir);
    return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
  });
}

/**
 * 规范化文件路径并检查合法性
 *
 * @returns 规范化后的绝对路径，如果不合法则返回 null
 */
export function normalizePath(
  filePath: string,
  allowedDirectories: readonly string[],
): string | null {
  const resolved = path.resolve(filePath);
  if (!validatePath(resolved, allowedDirectories)) {
    return null;
  }
  return resolved;
}

// ============================================================
// 环境变量清洗
// ============================================================

/** 敏感环境变量名模式 */
const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  /^.*_KEY$/,
  /^.*_SECRET$/,
  /^.*_TOKEN$/,
  /^.*_PASSWORD$/,
  /^DATABASE_URL$/,
  /^REDIS_URL$/,
  /^MONGODB_URI$/,
  /^AWS_ACCESS_KEY_ID$/,
  /^AWS_SECRET_ACCESS_KEY$/,
];

/**
 * Bash 工具执行时过滤敏感环境变量
 *
 * 移除所有匹配敏感模式的环境变量，防止 Agent 通过 Bash 工具泄露密钥。
 *
 * @param env - 原始环境变量
 * @returns 清洗后的环境变量（不含敏感项）
 */
export function sanitizeEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isSensitiveEnvKey(key)));
}

/**
 * 检查环境变量名是否为敏感项
 */
export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * 列出环境变量中的敏感 key（用于审计日志）
 */
export function listSensitiveEnvKeys(env: Record<string, string | undefined>): readonly string[] {
  return Object.keys(env).filter(isSensitiveEnvKey);
}
