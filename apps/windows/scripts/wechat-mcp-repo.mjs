/**
 * 定位独立的 wechat-mcp 仓库。
 *
 * Python 源码已迁出 Lumii（2026-10-20）：主产品三档与 CRM/导出/撤回三个兄弟产品
 * 都在同一个仓库里维护，Lumii 只负责构建与发版。默认按并排布局推断
 * `<open-source>/wechat-mcp`，可用 `WECHAT_MCP_DIR` 覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function wechatMcpRepo() {
  const want = process.env.WECHAT_MCP_DIR
  const dir = want
    ? path.resolve(want)
    : path.resolve(WINDOWS_ROOT, '../../..', 'wechat-mcp')
  if (!fs.existsSync(path.join(dir, 'scripts', 'build-wechat-mcp.mjs'))) {
    throw new Error(
      `找不到 wechat-mcp 仓库：${dir}\n` +
      '请把源码仓库放在 Lumii 旁边（<open-source>/wechat-mcp），或设 WECHAT_MCP_DIR。')
  }
  return dir
}
