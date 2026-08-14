/**
 * lumii-ui CLI 脚本路径解析（开发 / 打包一致）
 */

import { join } from 'node:path'
import { app } from 'electron'

/**
 * 返回 lumii-ui.mjs 绝对路径。
 * 打包：process.resourcesPath/app-ui-cli/lumii-ui.mjs（extraResources）
 * 开发：apps/windows/resources/app-ui-cli/lumii-ui.mjs
 */
export function resolveLumiiUiScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app-ui-cli', 'lumii-ui.mjs')
  }
  return join(__dirname, '../../resources/app-ui-cli/lumii-ui.mjs')
}
