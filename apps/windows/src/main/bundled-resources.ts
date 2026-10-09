/**
 * 随包资源目录解析（开发 / 打包一致）
 *
 * 打包：`process.resourcesPath`（electron-builder `extraResources` 的落点）
 * 开发：`apps/windows/resources`
 *
 * 供 MCP 配置里的 `{{LUMII_RESOURCES}}` 占位符展开——用户配置里存占位符，
 * 避免把绝对路径写死（换机器 / 打包后路径不同）。
 */

import { join, resolve } from 'node:path'
import { app } from 'electron'
import { getBundledMcpExeRelativePath } from './bundled-mcp-exe'

/** MCP 配置中代表「随包资源目录」的占位符（明文存盘，连接前展开） */
export const LUMII_RESOURCES_TOKEN = '{{LUMII_RESOURCES}}'

/** 随包资源目录绝对路径 */
export function resolveBundledResourcesDir(): string {
  if (app.isPackaged) return process.resourcesPath
  return resolve(__dirname, '../../resources')
}

/**
 * 随包独立 MCP 可执行文件的绝对路径（部署的来源，不直接写进配置）
 *
 * @param name 可执行文件名（不含 .exe）
 */
export function resolveBundledMcpExe(name: string): string {
  return join(resolveBundledResourcesDir(), getBundledMcpExeRelativePath(name, app.isPackaged))
}

/** 展开字符串里的随包资源占位符 */
export function expandBundledResources(value: string): string {
  if (!value.includes(LUMII_RESOURCES_TOKEN)) return value
  return value.split(LUMII_RESOURCES_TOKEN).join(resolveBundledResourcesDir())
}
