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

import os from 'node:os'
import path from 'node:path'

/**
 * 展开以 ~ 开头的路径为当前用户主目录下的绝对路径。
 */
function expandUserPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return trimmed
  }
  if (trimmed.startsWith('~')) {
    return path.resolve(trimmed.replace(/^~(?=$|[/\\])/, os.homedir()))
  }
  return path.resolve(trimmed)
}

const WINDOWS_CLIENT_DATA_DIRNAME = '.lumii' as const

/** 缓存：进程生命周期内数据根不变，避免重复磁盘检查 */
let _cachedClientStateDir: string | undefined

/**
 * 解析 Lumii 独立版客户端数据根目录（用户文件、配置、日志、RFS 设备根等）。
 * 与原 MtBot 产品彻底隔离，避免目录冲突。
 *
 * 优先级: LUMII_CLIENT_DATA_DIR（自定义覆盖）→ 默认 ~/.lumii
 *
 * @returns 客户端数据根目录的绝对路径
 */
export function resolveClientStateDir(): string {
  if (_cachedClientStateDir !== undefined) {
    return _cachedClientStateDir
  }

  const clientEnv = process.env.LUMII_CLIENT_DATA_DIR?.trim()
  if (clientEnv) {
    _cachedClientStateDir = expandUserPath(clientEnv)
    return _cachedClientStateDir
  }

  _cachedClientStateDir = path.join(os.homedir(), WINDOWS_CLIENT_DATA_DIRNAME)
  return _cachedClientStateDir
}

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
 * 获取应用级缓存目录（根级别）
 * @returns %USERPROFILE%/.lumii/cache/ 的完整路径
 */
export function resolveSharedCacheDir(): string {
  return path.join(resolveClientStateDir(), 'cache')
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
 * 获取应用级临时目录（根级别）
 * @returns %USERPROFILE%/.lumii/temp/ 的完整路径
 */
export function resolveSharedTempDir(): string {
  return path.join(resolveClientStateDir(), 'temp')
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

/**
 * 获取 legacy RFS 根目录（远程文件系统操作所使用的）
 * 用于兼容旧版本的 RFS 路径解析
 * @returns %USERPROFILE%/.lumii/ 的完整路径（客户端数据根目录）
 */
export function resolveRfsRootDir(): string {
  return resolveClientStateDir()
}
