/**
 * 把用户级 CLI 目录并入进程 PATH。
 *
 * Electron 从开始菜单启动时拿不到安装脚本刚写入的 User PATH，
 * uv / uvx 默认落在 ~/.local/bin，不并入就会 spawn ENOENT。
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 用户机器上常见的 CLI 安装目录（uv、cargo、npm 全局 bin 等）
 */
export function listUserCliBinDirs(): string[] {
  const home = os.homedir()
  const extras: string[] = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
  ]
  const local = process.env.LOCALAPPDATA
  if (local) {
    extras.push(path.join(local, 'Programs', 'uv'))
    extras.push(path.join(local, 'cursor-agent'))
  }
  const npmPrefix = process.env.npm_config_prefix
  if (npmPrefix) extras.push(npmPrefix)
  const appDataRoaming = process.env.APPDATA
  if (appDataRoaming) extras.push(path.join(appDataRoaming, 'npm'))
  return extras
}

/**
 * 把 extras 中已存在的目录前置到 PATH 字符串（去重，大小写不敏感）
 */
export function mergePathWithCliDirs(
  current: string,
  extras: readonly string[],
  existsFn: (dir: string) => boolean = existsSync,
): string {
  const parts = current.split(path.delimiter).filter(Boolean)
  const seen = new Set(parts.map((p) => p.toLowerCase()))
  const prepended: string[] = []
  for (const dir of extras) {
    if (!dir || !existsFn(dir)) continue
    const key = dir.toLowerCase()
    if (seen.has(key)) continue
    prepended.push(dir)
    seen.add(key)
  }
  return [...prepended, ...parts].join(path.delimiter)
}

/**
 * 把常见 CLI 目录并入当前进程 PATH（安装脚本写入 User PATH 后，Electron 不会自动刷新）
 */
export function refreshCommonCliPathsInProcessEnv(): void {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const current = process.env[pathKey] ?? ''
  process.env[pathKey] = mergePathWithCliDirs(current, listUserCliBinDirs())
}
