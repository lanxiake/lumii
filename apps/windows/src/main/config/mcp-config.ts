/**
 * MCP Server 配置管理
 *
 * 读写 ~/.lumii/config/mcp-servers.json。
 * 落盘用标准 MCP 格式 `{ "mcpServers": { "<name>": { ... } } }`，
 * 同时兼容读取旧的 `{ "servers": [...] }` 数组格式。
 *
 * 首次启动（配置文件不存在）会播种 @shared/mcp-presets 的内置清单。
 *
 * 注意：加载返回的是**未展开**的原始配置（供设置页编辑），
 * `${VAR_NAME}` 的展开由调用方在连接前用 expandEntry() 处理，
 * 否则编辑保存会把展开后的密钥明文写回磁盘。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MCP_PRESETS, isReadyToUse } from '../../shared/mcp-presets'

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

/** 标准 MCP 格式的单条 server（name 由对象 key 提供） */
type McpServerRecord = Omit<McpServerEntry, 'name'>

/** mcp-servers.json 文件结构：标准 mcpServers 对象，或旧的 servers 数组 */
interface McpServersFile {
  readonly mcpServers?: Record<string, McpServerRecord>
  readonly servers?: McpServerEntry[]
}

/** MCP 配置文件路径 */
export function getMcpConfigPath(): string {
  return path.join(os.homedir(), '.lumii', 'config', 'mcp-servers.json')
}

/** 展开环境变量 ${VAR_NAME} */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? ''
  })
}

/** 展开一个配置条目中的所有环境变量（连接前调用，不要在保存路径上用） */
export function expandEntry(entry: McpServerEntry): McpServerEntry {
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
 * 名称只保留字母数字下划线短横线
 *
 * Cursor 配置里常见 github.com/org/repo，本客户端校验不允许 `/` `.`。
 */
function sanitizeMcpName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || 'mcp-server'
}

/**
 * 规范化单条原始记录：补 name、把 url-only 转成 mcp-remote、disabled→enabled
 */
function normalizeRawEntry(name: string, rec: McpServerRecord & { url?: string; disabled?: boolean }): McpServerEntry | null {
  const safeName = sanitizeMcpName(name)
  let command = rec.command
  let args = rec.args

  // HTTP/SSE MCP（只有 url）：用 mcp-remote 桥成 stdio
  if ((!command || !String(command).trim()) && typeof rec.url === 'string' && rec.url.trim()) {
    command = 'npx'
    args = ['-y', 'mcp-remote@latest', rec.url.trim()]
  }

  if (!safeName || !command || !String(command).trim()) {
    log.warn(`[normalizeRawEntry] 跳过无效条目（缺少 name 或 command/url）: ${JSON.stringify({ name, ...rec })}`)
    return null
  }

  let enabled = rec.enabled
  if (enabled === undefined && typeof rec.disabled === 'boolean') {
    enabled = !rec.disabled
  }

  return {
    name: safeName,
    command: String(command).trim(),
    ...(args ? { args } : {}),
    ...(rec.env ? { env: rec.env } : {}),
    ...(rec.cwd ? { cwd: rec.cwd } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  }
}

/** 解析配置文本为条目列表；失败时抛出带原因的 Error */
export function parseMcpServerConfigs(raw: string): McpServerEntry[] {
  let parsed: McpServersFile & {
    mcpServers?: Record<string, McpServerRecord & { url?: string; disabled?: boolean }>
  }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch (err) {
    throw new Error(`配置文件 JSON 解析失败：${(err as Error).message}`)
  }

  if (!parsed.mcpServers && !Array.isArray(parsed.servers)) {
    throw new Error('配置文件格式错误：缺少 mcpServers 对象或 servers 数组')
  }

  // 标准格式优先，旧数组格式兼容；url-only / disabled / 非法名称一并规范化
  const rawPairs: Array<{ name: string; rec: McpServerRecord & { url?: string; disabled?: boolean } }> =
    parsed.mcpServers
      ? Object.entries(parsed.mcpServers).map(([name, rec]) => ({ name, rec }))
      : (parsed.servers ?? []).map((entry) => {
          const { name, ...rec } = entry as McpServerEntry & { url?: string; disabled?: boolean }
          return { name, rec }
        })

  const entries: McpServerEntry[] = []
  for (const { name, rec } of rawPairs) {
    const entry = normalizeRawEntry(name, rec)
    if (entry) entries.push(entry)
  }

  return entries
}

/**
 * 加载 MCP Server 配置列表（原始值，未展开环境变量）
 *
 * 若配置文件不存在，先播种默认清单。
 * 若文件解析失败，抛错（由调用方写入 lastError / UI）。
 */
export function loadMcpServerConfigs(): McpServerEntry[] {
  const configPath = getMcpConfigPath()

  if (!fs.existsSync(configPath)) {
    seedDefaultMcpServers()
    if (!fs.existsSync(configPath)) return []
  }

  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf-8')
  } catch (err) {
    const message = `读取配置文件失败: ${(err as Error).message}`
    log.error(`[loadMcpServerConfigs] ${message}`)
    throw new Error(message)
  }

  const entries = parseMcpServerConfigs(raw)
  const enabledCount = entries.filter((e) => e.enabled !== false).length
  log.info(`[loadMcpServerConfigs] 加载完成，共 ${entries.length} 个 Server，${enabledCount} 个已启用`)
  return entries
}

/** 读取 mcp-servers.json 原文（不存在则先播种） */
export function readMcpConfigRaw(): { path: string; content: string } {
  const configPath = getMcpConfigPath()
  if (!fs.existsSync(configPath)) {
    seedDefaultMcpServers()
  }
  if (!fs.existsSync(configPath)) {
    const empty = '{\n  "mcpServers": {}\n}\n'
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, empty, 'utf-8')
    return { path: configPath, content: empty }
  }
  return { path: configPath, content: fs.readFileSync(configPath, 'utf-8') }
}

/**
 * 校验并写入 mcp-servers.json 原文
 *
 * 先 parse + validate，再落盘，避免写坏文件后连不上。
 */
export function writeMcpConfigRaw(content: string): McpServerEntry[] {
  const entries = parseMcpServerConfigs(content)
  for (const entry of entries) {
    const error = validateMcpServerEntry(entry)
    if (error) throw new Error(`MCP Server「${entry.name}」配置无效：${error}`)
  }
  const names = new Set<string>()
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`MCP Server 名称重复：${entry.name}`)
    names.add(entry.name)
  }

  // 规范化为标准 mcpServers 格式再写回，避免用户粘贴旧数组格式后下次编辑不一致
  saveMcpServerConfigs(entries)
  log.info(`[writeMcpConfigRaw] 已写入 ${entries.length} 个 Server 到 ${getMcpConfigPath()}`)
  return entries
}

/**
 * 首次启动播种内置清单
 *
 * 只在配置文件不存在时写，之后用户怎么删怎么改都不再覆盖。
 * 零配置的默认启用，需要填路径或 Key 的先停用，避免首启一堆连接失败。
 */
function seedDefaultMcpServers(): void {
  const entries = MCP_PRESETS.map((preset) => ({
    name: preset.name,
    command: preset.command,
    args: preset.args,
    ...(preset.env ? { env: preset.env } : {}),
    enabled: isReadyToUse(preset),
  }))

  try {
    saveMcpServerConfigs(entries)
    log.info(`[seedDefaultMcpServers] 已播种 ${entries.length} 个内置 Server`)
  } catch (err) {
    log.error(`[seedDefaultMcpServers] 播种失败: ${(err as Error).message}`)
  }
}

/** 校验单条配置，返回错误信息；通过则返回 null */
export function validateMcpServerEntry(entry: McpServerEntry): string | null {
  if (!entry.name?.trim()) return '名称不能为空'
  if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) return '名称只能包含字母、数字、下划线和短横线'
  if (!entry.command?.trim()) return '启动命令不能为空'
  return null
}

/**
 * 保存 MCP Server 配置列表（标准 mcpServers 格式）
 *
 * 全量覆盖写入。名称重复或校验不通过会抛错，避免写坏配置。
 */
export function saveMcpServerConfigs(entries: readonly McpServerEntry[]): void {
  const mcpServers: Record<string, McpServerRecord> = {}

  for (const entry of entries) {
    const error = validateMcpServerEntry(entry)
    if (error) throw new Error(`MCP Server「${entry.name || '未命名'}」配置无效：${error}`)
    if (mcpServers[entry.name]) throw new Error(`MCP Server 名称重复：${entry.name}`)

    const { name, ...rest } = entry
    mcpServers[name] = rest
  }

  const configPath = getMcpConfigPath()
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), 'utf-8')
  log.info(`[saveMcpServerConfigs] 已保存 ${entries.length} 个 Server 到 ${configPath}`)
}
