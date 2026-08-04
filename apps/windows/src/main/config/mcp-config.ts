/**
 * MCP Server 配置管理
 *
 * 从 ~/.lumii/config/mcp-servers.json 加载 MCP Server 配置。
 * 支持 ${VAR_NAME} 语法展开环境变量。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const log = {
  info: (...args: unknown[]) => console.log('[MCP-Config]', ...args),
  warn: (...args: unknown[]) => console.warn('[MCP-Config]', ...args),
  error: (...args: unknown[]) => console.error('[MCP-Config]', ...args),
}

/** 单个 MCP Server 配置条目 */
export interface McpServerEntry {
  /** Server 名称（唯一标识，用于工具名前缀 mcp__<name>__<tool>） */
  readonly name: string
  /** 启动命令 */
  readonly command: string
  /** 命令参数 */
  readonly args?: readonly string[]
  /** 环境变量（支持 ${VAR_NAME} 展开） */
  readonly env?: Record<string, string>
  /** 工作目录 */
  readonly cwd?: string
  /** 是否启用（默认 true） */
  readonly enabled?: boolean
}

/** mcp-servers.json 文件结构 */
interface McpServersFile {
  readonly servers: McpServerEntry[]
}

/** MCP 配置文件路径 */
function getMcpConfigPath(): string {
  return path.join(os.homedir(), '.lumii', 'config', 'mcp-servers.json')
}

/** 展开环境变量 ${VAR_NAME} */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? ''
  })
}

/** 展开一个配置条目中的所有环境变量 */
function expandEntry(entry: McpServerEntry): McpServerEntry {
  if (!entry.env) return entry

  const expandedEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(entry.env)) {
    expandedEnv[key] = expandEnvVars(value)
  }

  return {
    ...entry,
    env: expandedEnv,
  }
}

/**
 * 加载 MCP Server 配置列表
 *
 * 若配置文件不存在，返回空数组（静默跳过）。
 * 若文件解析失败，记录错误并返回空数组。
 */
export function loadMcpServerConfigs(): McpServerEntry[] {
  const configPath = getMcpConfigPath()

  if (!fs.existsSync(configPath)) {
    log.info(`[loadMcpServerConfigs] 配置文件不存在，跳过 MCP 加载: ${configPath}`)
    return []
  }

  log.info(`[loadMcpServerConfigs] 正在加载 MCP 配置: ${configPath}`)

  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf-8')
  } catch (err) {
    log.error(`[loadMcpServerConfigs] 读取配置文件失败: ${(err as Error).message}`)
    return []
  }

  let parsed: McpServersFile
  try {
    parsed = JSON.parse(raw) as McpServersFile
  } catch (err) {
    log.error(`[loadMcpServerConfigs] 配置文件 JSON 解析失败: ${(err as Error).message}`)
    return []
  }

  if (!Array.isArray(parsed.servers)) {
    log.warn('[loadMcpServerConfigs] 配置文件格式错误：缺少 servers 数组')
    return []
  }

  const entries = parsed.servers
    .filter((entry): entry is McpServerEntry => {
      if (!entry.name || !entry.command) {
        log.warn(`[loadMcpServerConfigs] 跳过无效条目（缺少 name 或 command）: ${JSON.stringify(entry)}`)
        return false
      }
      return true
    })
    .map(expandEntry)

  const enabledCount = entries.filter((e) => e.enabled !== false).length
  log.info(`[loadMcpServerConfigs] 加载完成，共 ${entries.length} 个 Server，${enabledCount} 个已启用`)

  return entries
}
