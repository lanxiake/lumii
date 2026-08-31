/**
 * McpManager — MCP Server 连接与工具注册管理
 *
 * 职责：加载 MCP Server 配置、建立连接、注册工具、自动重连
 * 从 bridge.ts 提取，保持与 AgentRuntimeBridge 的零耦合（通过构造注入）
 */

import { McpStdioClient, loadMcpTools, type ToolRegistry } from '@mtbot/agent-runtime'
import { refreshCommonCliPathsInProcessEnv } from '../cli-user-path'
import {
  expandEntry,
  loadMcpServerConfigs,
  readMcpConfigRaw,
  saveMcpServerConfigs,
  validateMcpServerEntry,
  writeMcpConfigRaw,
  type McpServerEntry,
} from '../config/mcp-config'

/** 单个 MCP Server 的运行时状态（含配置本身，供设置页直接渲染） */
export interface McpServerRuntimeStatus extends McpServerEntry {
  /** 是否已建立连接 */
  readonly connected: boolean
  /** 是否正在连接中 */
  readonly connecting: boolean
  /** 该 Server 已注册的工具名 */
  readonly tools: readonly string[]
  /** 最近一次连接失败的原因 */
  readonly lastError?: string
}

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

  /** 配置快照，以 name 为键 */
  private configs = new Map<string, McpServerEntry>()
  /** 每个 Server 注册的工具名，断开时用于注销 */
  private readonly serverTools = new Map<string, string[]>()
  private readonly connecting = new Set<string>()
  private readonly lastErrors = new Map<string, string>()
  /** 主动断开的 Server，用于抑制 exit 事件里的自动重连 */
  private readonly intentionalStops = new Set<string>()

  /** 配置文件级错误（JSON 损坏等），展示在面板顶部 */
  private configError: string | null = null

  /**
   * 加载并连接配置的 MCP Server，将工具注册到 toolRegistry
   */
  async load(): Promise<void> {
    this.configError = null
    let configs: McpServerEntry[]
    try {
      configs = loadMcpServerConfigs()
    } catch (err) {
      this.configError = (err as Error).message
      log.error(`[load] ${this.configError}`)
      this.configs = new Map()
      return
    }
    this.configs = new Map(configs.map((c) => [c.name, c]))

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
    // 会话中新装的 uv 会创建 ~/.local/bin，每次连接前刷新，避免仍 ENOENT
    refreshCommonCliPathsInProcessEnv()
    const { name, command, args, env, cwd } = expandEntry(config)
    log.info(`[connect] 连接 MCP Server: ${name} (${command} ${(args ?? []).join(' ')})`)

    const client = new McpStdioClient({ command, args, env, cwd })
    this.connecting.add(name)
    this.intentionalStops.delete(name)

    try {
      await client.start()
      const tools = await loadMcpTools(client, name)

      for (const tool of tools) {
        this.toolRegistry.register(tool)
      }

      this.mcpClients.set(name, client)
      this.serverTools.set(name, tools.map((t) => t.name))
      this.lastErrors.delete(name)
      log.info(`[connect] MCP Server [${name}] 已连接，加载 ${tools.length} 个工具`)

      // 监听进程退出，尝试自动重连（最多 3 次）
      client.once('exit', () => {
        log.warn(`[connect] MCP Server [${name}] 已断开`)
        this.mcpClients.delete(name)
        this.unregisterTools(name)
        if (this.intentionalStops.has(name)) return
        if (retryCount < 3) {
          const delay = (retryCount + 1) * 2000
          log.info(`[connect] ${delay}ms 后尝试重连 [${name}]（第 ${retryCount + 1} 次）`)
          setTimeout(() => void this.connect(config, retryCount + 1), delay)
        } else {
          const message = '进程退出后重连次数已达上限'
          log.error(`[connect] MCP Server [${name}] ${message}`)
          this.lastErrors.set(name, message)
        }
      })
    } catch (err) {
      const message = (err as Error).message
      log.error(`[connect] MCP Server [${name}] 连接失败: ${message}`)
      this.lastErrors.set(name, message)
      await client.stop().catch(() => {})
    } finally {
      this.connecting.delete(name)
    }
  }

  /** 注销某个 Server 注册过的所有工具 */
  private unregisterTools(name: string): void {
    for (const toolName of this.serverTools.get(name) ?? []) {
      this.toolRegistry.unregister(toolName)
    }
    this.serverTools.delete(name)
  }

  /** 断开某个 Server 并注销其工具（不改配置） */
  async disconnect(name: string): Promise<void> {
    this.intentionalStops.add(name)
    const client = this.mcpClients.get(name)
    if (client) {
      await client.stop().catch((err) => log.warn(`[disconnect] 停止 [${name}] 失败: ${err}`))
      this.mcpClients.delete(name)
    }
    this.unregisterTools(name)
    this.lastErrors.delete(name)
  }

  /** 重连某个 Server（配置改动后调用），Server 已禁用则只断开 */
  async reconnect(name: string): Promise<void> {
    await this.disconnect(name)
    const config = this.configs.get(name)
    if (!config || config.enabled === false) {
      this.notifyToolsChanged()
      return
    }
    await this.connect(config)
    // 通知 Bridge 刷新运行中实例的工具列表(避免对话窗口看不到新工具)
    this.notifyToolsChanged()
  }

  /** 工具列表变更回调(由 Bridge 注入) */
  private onToolsChanged: (() => void) | null = null

  /** Bridge 注入工具变更监听器 */
  setToolsChangedListener(listener: (() => void) | null): void {
    this.onToolsChanged = listener
  }

  /** 触发工具变更通知 */
  private notifyToolsChanged(): void {
    if (this.onToolsChanged) {
      try {
        this.onToolsChanged()
      } catch (err) {
        log.error('[notifyToolsChanged] 回调执行失败:', err)
      }
    }
  }

  /**
   * 返回所有已配置 MCP Server 的状态（含未连接的）
   *
   * 兼容旧签名：调用方原本只读 name / connected 两个字段。
   */
  getStatus(): McpServerRuntimeStatus[] {
    return [...this.configs.values()].map((config) => ({
      ...config,
      // 成功 connect 后才会写入 mcpClients，以此判定在线
      connected: this.mcpClients.has(config.name),
      connecting: this.connecting.has(config.name),
      tools: this.serverTools.get(config.name) ?? [],
      lastError: this.lastErrors.get(config.name),
    }))
  }

  /** 配置文件级错误（解析失败等），无则 null */
  getConfigError(): string | null {
    return this.configError
  }

  /** 读取 mcp-servers.json 原文供客户端内编辑 */
  readConfigFile(): { path: string; content: string } {
    return readMcpConfigRaw()
  }

  /**
   * 写入 mcp-servers.json 原文并全量重载连接
   *
   * 先断开全部，再按新配置连接；写失败不改运行时状态。
   */
  async writeConfigFile(content: string): Promise<void> {
    writeMcpConfigRaw(content)
    await this.reloadFromDisk()
  }

  /** 从磁盘重新加载配置并重连全部 Server */
  async reloadFromDisk(): Promise<void> {
    const names = [...this.configs.keys()]
    for (const name of names) {
      await this.disconnect(name)
    }
    this.configs.clear()
    this.lastErrors.clear()
    this.configError = null
    await this.load()
    this.notifyToolsChanged()
  }

  /** 新增或更新一条配置并立即生效 */
  async upsert(entry: McpServerEntry, originalName?: string): Promise<void> {
    const error = validateMcpServerEntry(entry)
    if (error) throw new Error(error)

    // 改名时先断开旧连接，再删旧键
    if (originalName && originalName !== entry.name) {
      await this.disconnect(originalName)
      this.configs.delete(originalName)
    } else if (this.configs.has(entry.name) && !originalName) {
      throw new Error(`MCP Server 名称已存在：${entry.name}`)
    }

    this.configs.set(entry.name, entry)
    this.persist()
    await this.reconnect(entry.name)
  }

  /** 批量导入（标准 mcpServers 格式），同名覆盖 */
  async importEntries(entries: readonly McpServerEntry[]): Promise<void> {
    for (const entry of entries) {
      const error = validateMcpServerEntry(entry)
      if (error) throw new Error(`「${entry.name || '未命名'}」：${error}`)
    }

    for (const entry of entries) {
      this.configs.set(entry.name, entry)
    }
    this.persist()

    for (const entry of entries) {
      await this.reconnect(entry.name)
    }
  }

  /** 删除一条配置 */
  async remove(name: string): Promise<void> {
    await this.disconnect(name)
    this.configs.delete(name)
    this.persist()
    this.notifyToolsChanged()
  }

  /** 启用/禁用一条配置 */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const config = this.configs.get(name)
    if (!config) throw new Error(`MCP Server 不存在：${name}`)
    this.configs.set(name, { ...config, enabled })
    this.persist()
    await this.reconnect(name)
  }

  private persist(): void {
    saveMcpServerConfigs([...this.configs.values()])
  }
}
