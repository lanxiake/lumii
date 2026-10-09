/**
 * 随包独立 MCP 可执行文件（如 wechat-mcp.exe）的部署
 *
 * 这类 MCP 要能**脱离灵栖独立使用**：配置里只写一个 exe 的绝对路径，不带任何占位符，
 * 复制到 Claude Desktop / Cursor 等客户端也能直接跑。所以 exe 不能留在安装目录里
 * （开发期在仓库、打包后随安装位置与版本变化），启动时同步到数据根下的固定位置：
 *
 *   <数据根>/mcp/<name>/<name>.exe
 *
 * 同步按内容哈希判定；目标正被别的客户端运行时，Windows 不允许覆盖但允许改名，
 * 因此先把旧文件改名让位，再把新文件换上，旧文件留到下次启动清理。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveClientStateDir } from './client-data-root'

/** 同步结果：成功给出部署路径；失败给出可展示给用户的原因 */
export type McpExeSyncResult =
  | { readonly ok: true; readonly path: string; readonly updated: boolean; readonly warning?: string }
  | { readonly ok: false; readonly path: string; readonly message: string }

/** 改名让位的旧文件后缀（下次同步时清理） */
const STALE_MARKER = '.old-'

/**
 * 独立 MCP 可执行文件的固定部署路径（写进 MCP 配置的就是它）
 *
 * @param name 可执行文件名（不含 .exe），同时也是目录名
 */
export function getDeployedMcpExePath(name: string): string {
  return path.join(resolveClientStateDir(), 'mcp', name, `${name}.exe`)
}

/**
 * 随包可执行文件相对资源目录的位置
 *
 * 打包后由 electron-builder 放在 `<resources>/<name>/<name>.exe`；
 * 开发期是构建脚本的产物 `resources/<name>/dist/<name>.exe`。
 *
 * @param name 可执行文件名（不含 .exe）
 * @param packaged 是否打包运行
 */
export function getBundledMcpExeRelativePath(name: string, packaged: boolean): string {
  return packaged ? path.join(name, `${name}.exe`) : path.join(name, 'dist', `${name}.exe`)
}

/**
 * 计算文件 sha256（流式，避免一次性读入十几 MB）
 *
 * @param file 文件绝对路径
 */
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * 判断路径是否存在
 *
 * @param file 文件绝对路径
 */
async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

/**
 * 清理上次改名让位留下的旧文件（仍在运行的删不掉，留给下一次）
 *
 * @param target 部署目标路径
 */
async function removeStaleCopies(target: string): Promise<void> {
  const dir = path.dirname(target)
  const prefix = `${path.basename(target)}${STALE_MARKER}`
  const names = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(
    names.filter((n) => n.startsWith(prefix)).map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => {})),
  )
}

/**
 * 把随包可执行文件同步到部署位置
 *
 * - 源缺失：已部署过就沿用旧版（带告警），从未部署则失败；
 * - 内容相同：不动；
 * - 内容不同：写临时文件 → 旧文件改名让位 → 临时文件就位。
 *
 * @param source 随包可执行文件绝对路径
 * @param target 部署目标绝对路径
 */
export async function syncMcpExecutable(source: string, target: string): Promise<McpExeSyncResult> {
  const deployed = await exists(target)
  if (!(await exists(source))) {
    const reason = `随包可执行文件不存在：${source}`
    return deployed
      ? { ok: true, path: target, updated: false, warning: `${reason}，沿用已部署版本` }
      : { ok: false, path: target, message: reason }
  }

  await fs.mkdir(path.dirname(target), { recursive: true })
  await removeStaleCopies(target)
  if (deployed && (await hashFile(source)) === (await hashFile(target))) {
    return { ok: true, path: target, updated: false }
  }

  const temp = `${target}.tmp`
  await fs.copyFile(source, temp)
  try {
    if (deployed) await fs.rename(target, `${target}${STALE_MARKER}${Date.now()}`)
    await fs.rename(temp, target)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {})
    const reason = err instanceof Error ? err.message : String(err)
    return deployed
      ? { ok: true, path: target, updated: false, warning: `更新失败（${reason}），沿用已部署版本` }
      : { ok: false, path: target, message: `部署失败：${reason}` }
  }
  return { ok: true, path: target, updated: true }
}
