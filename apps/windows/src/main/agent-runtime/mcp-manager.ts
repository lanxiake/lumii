/**
 * McpManager — MCP Server 连接与工具注册管理
 *
 * 职责：加载 MCP Server 配置、建立连接、注册工具、自动重连
 * 从 bridge.ts 提取，保持与 AgentRuntimeBridge 的零耦合（通过构造注入）
 */

import { McpStdioClient, loadMcpTools, type ToolRegistry } from '@mtbot/agent-runtime'
import { refreshCommonCliPathsInProcessEnv } from '../cli-user-path'
import { ensureUvxInstalled } from '../uv-installer'
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
  /**
   * 已 spawn、但**握手尚未完成**的 client。
   *
   * 为什么单开一张表：`connect()` 只在 `await client.start()` 返回后才把 client
   * 写进 `mcpClients`，而 `disconnect()` 只从 `mcpClients` 取 client。若应用恰好在
   * 握手窗口内退出，那个 client 谁都够不到，带着子进程活过清理。
   *
   * 2026-09-20 冒烟实测的时序（桩子进程）：
   *   205 `[connect] 连接 MCP Server: smoke-stub`
   *   234 `应用即将退出`
   *   246 `[disconnectAll] 正在停止 0 个 MCP Server`   ← 数不到
   *   394 `[connect] MCP Server [smoke-stub] 已连接`     ← 清理之后才落地
   *   406 `清理完成，调用 app.exit(0)`
   */
  private readonly inFlightClients = new Map<string, McpStdioClient>()
  private readonly lastErrors = new Map<string, string>()
  /**
   * 应用正在退出——`disconnectAll()` 置位后不再接受任何新连接。
   *
   * 为什么必须有：`load()` 是 `void this.mcpManager.load()` 发出去的（bridge.ts），
   * 它逐个 `await` 连接配置里的 Server。若退出发生在中途，光把「当前那个」停掉不够——
   * 循环会继续连下一个。2026-09-20 冒烟实测到了这一步：
   *   `[connect] MCP Server [smoke-stub] 已连接`（清理之后）→
   *   `[connect] 连接 MCP Server: excel-mcp`（还要接着连）
   * 真实配置有 6 个启用的 Server，等于退出后仍会陆续 spawn 5 个子进程。
   */
  private shuttingDown = false
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
      // 退出途中不再开新连接（见 shuttingDown 注释）：否则循环会接着 spawn 下一个子进程
      if (this.shuttingDown) {
        log.info(`[load] 应用正在退出，跳过连接 MCP Server: ${config.name}`)
        continue
      }
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
    // 退出途中绝不再 spawn（重连定时器也走这里，见 shuttingDown 注释）
    if (this.shuttingDown) return
    // 会话中新装的 uv 会创建 ~/.local/bin，每次连接前刷新，避免仍 ENOENT
    refreshCommonCliPathsInProcessEnv()
    const { name, command, args, env, cwd } = expandEntry(config)
    log.info(`[connect] 连接 MCP Server: ${name} (${command} ${(args ?? []).join(' ')})`)

    if (command === 'uvx' || command === 'uv') {
      const uv = await ensureUvxInstalled()
      if (!uv.ok) {
        log.error(`[connect] MCP Server [${name}] 缺少 uv: ${uv.message}`)
        this.lastErrors.set(name, uv.message)
        return
      }
      if (uv.installed) {
        log.info(`[connect] MCP Server [${name}] 已自动安装 uv`)
      }
      refreshCommonCliPathsInProcessEnv()
    }

    const client = new McpStdioClient({ command, args, env, cwd })
    this.connecting.add(name)
    this.intentionalStops.delete(name)
    // 先登记再握手：退出清理要能停掉「已 spawn 但还没握手完」的 client（见字段注释）
    this.inFlightClients.set(name, client)

    try {
      await client.start()
      // 握手期间应用可能已开始退出：此时不能再注册工具（toolRegistry 正在被拆），
      // 把刚 spawn 的子进程停掉收尾。inFlightClients 里的登记由 finally 清理。
      if (this.shuttingDown) {
        log.info(`[connect] 应用正在退出，放弃已握手的 MCP Server [${name}]`)
        await client.stop().catch(() => {})
        return
      }
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
      this.inFlightClients.delete(name)
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

  /**
   * 停止**所有** MCP Server，用于应用退出。
   *
   * 为什么必须有：MCP Server 是独立子进程，不终止就会拖住 Electron 的退出——
   * 2026-09-20 实测（Linux，`--appimage-extract-and-run`）日志显示
   * `清理完成，调用 app.exit(0)` 之后 `McpManager` 仍在重连、子进程仍在跑，
   * GPU watchdog 在这段窗口里判定失败并 `FATAL: GPU process isn't usable`。
   *
   * `disconnect()` 已经做了三件事：标记 `intentionalStops`（抑制自动重连）、
   * 停 client、从 `mcpClients` 删除。这里只需**遍历一遍**，并额外清掉
   * `connecting`——卡在连接中的 Server 不在 `mcpClients` 里，`disconnect()`
   * 覆盖不到，留下的话退出后设置页仍显示「连接中」。
   *
   * **但「清掉 connecting 标记」不等于「停掉那个 client」**：握手期的 client 不在
   * `mcpClients` 里，得靠 `inFlightClients` 单独收（2026-09-20 冒烟实测的竞态，
   * 见该字段注释）。两边都停才算真停干净。
   *
   * 并发停止而非串行：退出路径上要快，且各 Server 互不依赖。
   */
  async disconnectAll(): Promise<void> {
    // 先置位再停：置位前正在 await 的 connect() 会在恢复后看到它并放弃，
    // 否则它会照常把 client 发起来、还登记进 inFlightClients（就没完没了了）
    this.shuttingDown = true
    const names = [...this.mcpClients.keys()]
    // 连接中的 Server：可能既不在 mcpClients（握手未完成），也不在 serverTools
    const inFlight = [...this.inFlightClients.entries()]
    if (names.length === 0 && this.connecting.size === 0 && inFlight.length === 0) return
    log.info(
      `[disconnectAll] 正在停止 ${names.length} 个 MCP Server、${inFlight.length} 个连接中的（应用退出）`,
    )
    await Promise.all(names.map((name) => this.disconnect(name)))
    // 连接中的 client 不走 disconnect()：disconnect 会去动 mcpClients / serverTools，
    // 而那些此刻本就不该有它们的条目；这里只负责把子进程停掉。
    await Promise.all(
      inFlight.map(async ([name, client]) => {
        this.intentionalStops.add(name)
        await client.stop().catch((err) => log.warn(`[disconnectAll] 停止连接中的 [${name}] 失败: ${err}`))
      }),
    )
    this.inFlightClients.clear()
    this.connecting.clear()
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
