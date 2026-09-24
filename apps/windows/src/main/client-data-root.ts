/**
 * Lumii 客户端数据根的**唯一实现**（T3.7 合并）。
 *
 * 合并前 `paths.ts` 与 `client-data-root.ts` 各有一份**逐字重复**的实现
 * （连 `expandUserPath` 辅助函数都一样），分别导出 `resolveClientStateDir` 与
 * `resolveWindowsClientDataRoot`，共 77 处调用。两份实现各持一份进程级缓存，
 * 是典型的「改一处漏一处」隐患。
 *
 * 合并后**保留两个导出名**（77 处调用不动），都指向本文件这一份实现与这一份缓存。
 * 行为规格由 `client-data-root.test.ts` 锁定——那些用例在合并前后原样通过。
 */
import os from 'node:os'
import path from 'node:path'

/** 设计约定：Lumii 独立版客户端数据根目录名（与原 MtBot 产品彻底隔离，避免冲突） */
export const WINDOWS_CLIENT_DATA_DIRNAME = '.lumii'

/**
 * 展开以 ~ 开头的路径为当前用户主目录下的绝对路径。
 *
 * 正则 `^~(?=$|[/\\])` 限定 `~` 必须**单独成段**：`~foo` 是「用户 foo 的家目录」
 * 这一 POSIX 语义，但我们不支持也不需要——只认 `~` 与 `~/...`。
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

/** 缓存：进程生命周期内数据根不变，避免重复磁盘检查 */
let _cachedRoot: string | undefined

/**
 * 测试用：重置数据根缓存（修改 LUMII_CLIENT_DATA_DIR 后调用）。
 */
export function _resetWindowsClientDataRootCacheForTest(): void {
  _cachedRoot = undefined
}

/**
 * 解析客户端数据根目录（用户文件、配置、日志、RFS 设备根等）。
 * 与网关安装目录（见 `src/config/gateway-install-paths.ts`）完全分离。
 *
 * 优先级：`LUMII_CLIENT_DATA_DIR`（自定义覆盖）→ 默认 `~/.lumii`。
 *
 * 结果在进程级别缓存——数据根在进程生命周期内不会变，
 * 而调用点很多（77 处），每次都做 `os.homedir()` 与路径拼接是浪费。
 */
function resolveClientDataRoot(): string {
  if (_cachedRoot !== undefined) {
    return _cachedRoot
  }

  const clientEnv = process.env.LUMII_CLIENT_DATA_DIR?.trim()
  if (clientEnv) {
    _cachedRoot = expandUserPath(clientEnv)
    return _cachedRoot
  }

  _cachedRoot = path.join(os.homedir(), WINDOWS_CLIENT_DATA_DIRNAME)
  return _cachedRoot
}

/**
 * 客户端数据根目录（原名保留，见文件头）。
 *
 * 名字里的 "Windows" 是历史遗留——这个路径在 Linux 上同样用 `~/.lumii`
 * （`os.homedir()` 是跨平台的），改名会波及 44 处调用，本次不做。
 */
export function resolveWindowsClientDataRoot(): string {
  return resolveClientDataRoot()
}

/** 客户端数据根目录（原名保留，见文件头） */
export function resolveClientStateDir(): string {
  return resolveClientDataRoot()
}
