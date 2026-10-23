/**
 * 定位独立的 wechat-mcp 仓库。
 *
 * Python 源码已迁出 Lumii（2026-10-20）：主产品（统一档位 `wechat-chat-mcp`）与
 * CRM/导出/撤回三个兄弟产品都在同一个仓库里维护，Lumii 只负责构建与发版。
 * 默认按并排布局推断 `<open-source>/wechat-mcp`，可用 `WECHAT_MCP_DIR` 覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 主产品的构建脚本：2026-10 合并三档后改名，旧名保留兼容 */
const BUILD_SCRIPTS = ['build-wechat-chat-mcp.mjs', 'build-wechat-mcp.mjs']

export function wechatMcpRepo() {
  const want = process.env.WECHAT_MCP_DIR
  const dir = want
    ? path.resolve(want)
    : path.resolve(WINDOWS_ROOT, '../../..', 'wechat-mcp')
  if (!BUILD_SCRIPTS.some((s) => fs.existsSync(path.join(dir, 'scripts', s)))) {
    throw new Error(
      `找不到 wechat-mcp 仓库：${dir}\n` +
      '请把源码仓库放在 Lumii 旁边（<open-source>/wechat-mcp），或设 WECHAT_MCP_DIR。')
  }
  return dir
}

/** 仓库里实际使用的构建脚本绝对路径 */
export function wechatMcpBuildScript(dir = wechatMcpRepo()) {
  const name = BUILD_SCRIPTS.find((s) => fs.existsSync(path.join(dir, 'scripts', s)))
  if (!name) throw new Error(`wechat-mcp 仓库里找不到构建脚本：${dir}`)
  return path.join(dir, 'scripts', name)
}
