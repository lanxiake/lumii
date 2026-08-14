import fs from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from '../client-data-root'

/** 截图临时文件子目录（相对数据根） */
const SCREENSHOT_TEMP_SUBDIR = path.join('temp', 'screenshots')

/**
 * 返回截图临时目录绝对路径。
 */
export function getScreenshotTempDir(dataRoot?: string): string {
  const root = dataRoot ?? resolveWindowsClientDataRoot()
  return path.join(root, SCREENSHOT_TEMP_SUBDIR)
}

/**
 * 应用启动时清空截图临时目录并重建空目录。
 * 目录级清空，避免历史截图累积占用磁盘。
 */
export function clearScreenshotTempDir(dataRoot?: string): void {
  const dir = getScreenshotTempDir(dataRoot)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}
