/**
 * 解析应用品牌图标路径（开发 / 打包一致）
 *
 * 开发：apps/windows/assets/*
 * 打包：process.resourcesPath/assets/*（extraResources）
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 返回 assets 目录绝对路径
 */
export function getAssetsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'assets')
  }
  // 开发：编译产物在 out/main，assets 在 apps/windows/assets
  return join(__dirname, '../../assets')
}

/**
 * 解析指定资源文件；若不存在则尝试备选名
 */
export function resolveAssetPath(...candidates: string[]): string {
  const dir = getAssetsDir()
  for (const name of candidates) {
    const full = join(dir, name)
    if (existsSync(full)) return full
  }
  // 兜底返回第一个候选（便于日志定位）
  return join(dir, candidates[0] ?? 'icon.ico')
}

/** 窗口标题栏 / 任务栏图标（ICO） */
export function getAppIconPath(): string {
  return resolveAssetPath('icon.ico', 'icon.png', 'logo.png')
}

/** 系统托盘图标（优先小尺寸 PNG，清晰度更好） */
export function getTrayIconPath(): string {
  return resolveAssetPath('tray-icon.png', 'icon.png', 'icon.ico', 'logo.png')
}
