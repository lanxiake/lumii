/**
 * 内置使用指南目录解析（开发 / 打包一致）
 *
 * 开发：apps/windows/resources/user-guides/
 * 打包：process.resourcesPath/user-guides/（extraResources）
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const USER_GUIDES_DIR_NAME = 'user-guides'

/**
 * 返回内置指南根目录绝对路径。
 */
export function getUserGuidesDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, USER_GUIDES_DIR_NAME)
  }
  return join(__dirname, '../../../resources/user-guides')
}

/**
 * 解析指南目录；不存在时返回 null（便于测试降级）。
 */
export function resolveUserGuidesDir(): string | null {
  const dir = getUserGuidesDir()
  return existsSync(dir) ? dir : null
}
