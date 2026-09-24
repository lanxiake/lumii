/**
 * 路径常量与解析函数
 *
 * 提供客户端数据根目录下所有标准路径的纯函数计算，与 DirectoryManager 的职责分离：
 * - 此模块: 路径拼接 (纯函数，无副作用)
 * - DirectoryManager: 目录创建与管理 (有副作用)
 *
 * 路径约定:
 * %USERPROFILE%\.lumii\
 * ├── config/
 * ├── cache/
 * ├── workspace/
 * │   ├── skills/
 * │   ├── uploads/
 * │   ├── outputs/
 * │   ├── files/
 * │   └── .system/
 * ├── logs/
 * └── temp/
 */

import path from 'node:path'
import { resolveClientStateDir } from './client-data-root'

/**
 * 客户端数据根——实现已合并到 `client-data-root.ts`（T3.7）。
 *
 * 合并前这里有一份与 `client-data-root.ts` **逐字重复**的实现（含 `expandUserPath`），
 * 各持一份进程级缓存，是「改一处漏一处」的隐患。现在统一从那里导入，
 * 两个导出名指向同一份实现与缓存；`expandUserPath` 也随之只剩一份。
 */
export { resolveClientStateDir, WINDOWS_CLIENT_DATA_DIRNAME } from './client-data-root'

// ============================================================================
// 共享资源路径 (根级别)
// ============================================================================

/**
 * 获取应用级配置目录（根级别）
 * @returns %USERPROFILE%/.lumii/config/ 的完整路径
 */
export function resolveSharedConfigDir(): string {
  return path.join(resolveClientStateDir(), 'config')
}

/**
 * 获取应用级日志目录（根级别）
 * @returns %USERPROFILE%/.lumii/logs/ 的完整路径
 */
export function resolveSharedLogsDir(): string {
  return path.join(resolveClientStateDir(), 'logs')
}

/**
 * 获取性能诊断日志目录
 * @returns %USERPROFILE%/.lumii/logs/perf/ 的完整路径
 */
export function resolvePerfLogsDir(): string {
  return path.join(resolveSharedLogsDir(), 'perf')
}

/**
 * 插件独立运行时目录（Python embed、原生工具等）
 * @returns 例如 %USERPROFILE%/.lumii/runtimes/python-embed
 */
export function resolvePluginRuntimeDir(name: string): string {
  return path.join(resolveClientStateDir(), 'runtimes', name)
}

// ============================================================================
// Legacy 兼容路径（用于过渡）
// ============================================================================

/**
 * 获取 legacy 工作区目录（直接位于根目录下）
 * 用于兼容旧版本数据目录结构
 * @returns %USERPROFILE%/.lumii/workspace/ 的完整路径
 */
export function resolveLegacyWorkspaceDir(): string {
  return path.join(resolveClientStateDir(), 'workspace')
}

/**
 * 获取 legacy 技能目录（直接位于工作区下）
 * 用于兼容旧版本的技能存储结构
 * @returns %USERPROFILE%/.lumii/workspace/skills/ 的完整路径
 */
export function resolveLegacySkillsDir(): string {
  return path.join(resolveLegacyWorkspaceDir(), 'skills')
}
