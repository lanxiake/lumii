/**
 * McpManager — MCP Server 连接与工具注册管理
 *
 * 职责：加载 MCP Server 配置、建立连接、注册工具、自动重连
 * 从 bridge.ts 提取，保持与 AgentRuntimeBridge 的零耦合（通过构造注入）
 */

import { McpStdioClient, loadMcpTools, type ToolRegistry } from '@mtbot/agent-runtime'
import { loadMcpServerConfigs, type McpServerEntry } from '../config/mcp-config'

const log = {
  info: (...args: unknown[]) => console.log('[McpManager]', ...args),
  warn: (...args: unknown[]) => console.warn('[McpManager]', ...args),
  error: (...args: unknown[]) => console.error('[McpManager]', ...args),
}

export class McpManager {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly mcpClients: Map<string, McpStdioClient>,
  ) {}

  /**
   * 加载并连接配置的 MCP Server，将工具注册到 toolRegistry
   */
  async load(): Promise<void> {
    const configs = loadMcpServerConfigs()
    if (configs.length === 0) return

    for (const config of configs) {
      if (config.enabled === false) {
        log.info(`[load] 跳过已禁用的 MCP Server: ${config.name}`)
        continue
      }
      await this.connect(config)
    }
  }

  /**
   * 连接单个 MCP Server，失败时最多重试 3 次
   */
  private async connect(config: McpServerEntry, retryCount = 0): Promise<void> {
    const { name, command, args, env, cwd } = config
    log.info(`[connect] 连接 MCP Server: ${name} (${command} ${(args ?? []).join(' ')})`)

    const client = new McpStdioClient({ command, args, env, cwd })

    try {
      await client.start()
      const tools = await loadMcpTools(client, name)

      for (const tool of tools) {
        this.toolRegistry.register(tool)
      }

      this.mcpClients.set(name, client)
      log.info(`[connect] MCP Server [${name}] 已连接，加载 ${tools.length} 个工具`)

      // 监听进程退出，尝试自动重连（最多 3 次）
      client.once('exit', () => {
        log.warn(`[connect] MCP Server [${name}] 已断开`)
        this.mcpClients.delete(name)
        if (retryCount < 3) {
          const delay = (retryCount + 1) * 2000
          log.info(`[connect] ${delay}ms 后尝试重连 [${name}]（第 ${retryCount + 1} 次）`)
          setTimeout(() => void this.connect(config, retryCount + 1), delay)
        } else {
          log.error(`[connect] MCP Server [${name}] 重连次数已达上限，放弃`)
        }
      })
    } catch (err) {
      log.error(`[connect] MCP Server [${name}] 连接失败: ${(err as Error).message}`)
    }
  }

  /**
   * 返回所有 MCP Server 的连接状态
   */
  getStatus(): Array<{ name: string; connected: boolean }> {
    return Array.from(this.mcpClients.entries()).map(([name, client]) => ({
      name,
      connected: client.initialized,
    }))
  }
}
