import fs from 'node:fs'
import path from 'node:path'
import { resolveScreenshotTempDir } from '../workspace-paths'

/**
 * 返回截图临时目录绝对路径。
 * 生产：`{当前工作空间}/temp/screenshots`（缺失自动创建）。
 * @param testRoot 仅测试：在给定根下使用 `temp/screenshots`，便于隔离
 */
export function getScreenshotTempDir(testRoot?: string): string {
  if (testRoot) {
    return path.join(testRoot, 'temp', 'screenshots')
  }
  return resolveScreenshotTempDir()
}

/**
 * 应用启动时清空截图临时目录并重建空目录。
 * 目录级清空，避免历史截图累积占用磁盘。
 */
export function clearScreenshotTempDir(testRoot?: string): void {
  const dir = getScreenshotTempDir(testRoot)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}
