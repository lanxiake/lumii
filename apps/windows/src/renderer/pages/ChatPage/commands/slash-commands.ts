/**
 * 客户端斜杠命令注册表
 *
 * 基础命令（help/status/clear/new/resume/compact/memory/think）由主进程 IPC 提供
 * （命令类型 'commands:list'），客户端本地追加 backend-switching 等客户端专属命令。
 *
 * 这样命令元数据只在一处（agent-runtime-ipc.ts 的 BASE_SLASH_COMMANDS）维护，
 * 跨渠道变更只需改那一处。
 */

import type { CommandListEntry } from '../../../../shared/agent-runtime-commands'

export type CommandCategory = 'session' | 'memory' | 'backend' | 'info' | 'settings'

export interface SlashCommand {
  /** 主命令名（含斜杠），如 "/compact" */
  name: string
  /** 别名列表 */
  aliases?: string[]
  /** 简短描述 */
  description: string
  /** 用法示例 */
  usage?: string
  /** 命令分类 */
  category: CommandCategory
}

/** 命令分类中文标签 */
export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  session: '会话管理',
  memory: '记忆管理',
  backend: '后端切换',
  info: '信息查询',
  settings: '设置选项',
}

/**
 * 客户端专属命令（不在基础命令列表中，由渲染层追加）
 * 这些命令在服务端渠道（WeChat 等）有各自的实现，不共用此列表
 */
const CLIENT_ONLY_COMMANDS: SlashCommand[] = [
  // ── 后端切换 ──────────────────────────────────────────────────
  {
    name: '/claude',
    aliases: ['/claude-code'],
    description: '切换到 Claude Code 后端（编程辅助模式）',
    usage: '/claude',
    category: 'backend',
  },
  {
    name: '/codex',
    description: '切换到 Codex 后端',
    usage: '/codex',
    category: 'backend',
  },
  {
    name: '/opencode',
    description: '切换到 OpenCode 后端',
    usage: '/opencode',
    category: 'backend',
  },
  {
    name: '/cursor',
    description: '切换到 Cursor 后端',
    usage: '/cursor',
    category: 'backend',
  },
  {
    name: '/lumii',
    description: '切换回灵栖主 Agent（默认）',
    usage: '/lumii',
    category: 'backend',
  },
]

/** 将 IPC 返回的基础命令条目转换为本地 SlashCommand 格式 */
function fromCommandListEntry(entry: CommandListEntry): SlashCommand {
  return {
    name: entry.name,
    aliases: entry.aliases.length > 0 ? [...entry.aliases] : undefined,
    description: entry.description,
    usage: entry.usage,
    category: (entry.category as CommandCategory) ?? 'info',
  }
}

/**
 * 运行时命令缓存
 * 首次调用 getSlashCommands() 后缓存，通过 invalidateSlashCommandsCache() 重置
 */
let cachedCommands: SlashCommand[] | null = null

/** 使缓存失效（用于 IPC 加载完成后刷新） */
export function invalidateSlashCommandsCache(): void {
  cachedCommands = null
}

/**
 * 获取当前命令列表（同步）
 *
 * 优先从缓存返回；若未缓存则返回内置默认列表。
 * 异步加载完成后通过 invalidateSlashCommandsCache() 触发刷新。
 */
export function getSlashCommands(): SlashCommand[] {
  if (cachedCommands) return cachedCommands

  // 返回内置默认（与 IPC 基础命令保持一致）
  return getBuiltinCommands()
}

/** 内置默认命令列表（与 agent-runtime-ipc.ts 中 BASE_SLASH_COMMANDS 保持一致） */
function getBuiltinCommands(): SlashCommand[] {
  return [
    // ── 信息查询 ──────────────────────────────────────────────────
    { name: '/help', description: '显示所有可用命令', usage: '/help', category: 'info' },
    { name: '/status', description: '查看当前 Agent 状态（上下文用量、模型等）', usage: '/status', category: 'info' },
    // ── 会话管理 ──────────────────────────────────────────────────
    { name: '/clear', description: '清空当前会话的所有消息（保留会话）', usage: '/clear', category: 'session' },
    { name: '/new', aliases: ['/n'], description: '新建一个空白会话', usage: '/new', category: 'session' },
    { name: '/resume', aliases: ['/r'], description: '查看最近 10 个会话，可恢复对话', usage: '/resume [编号]', category: 'session' },
    { name: '/compact', aliases: ['/compress'], description: 'AI 总结历史消息并重构上下文，释放 token 空间', usage: '/compact [自定义压缩指令]', category: 'session' },
    // ── 记忆管理 ──────────────────────────────────────────────────
    { name: '/memory', description: '查看当前 Agent 的记忆列表，支持 clear 子命令', usage: '/memory [clear]', category: 'memory' },
    // ── 设置选项 ──────────────────────────────────────────────────
    { name: '/think', aliases: ['/thinking', '/t'], description: '设置思考级别（off/low/medium/high）', usage: '/think <off|low|medium|high>', category: 'settings' },
    // ── 后端切换（客户端专属） ──────────────────────────────────
    ...CLIENT_ONLY_COMMANDS,
  ]
}

/**
 * 从 IPC 异步加载基础命令并更新缓存
 *
 * 在应用初始化阶段调用一次；加载完成后缓存更新，下次 getSlashCommands() 返回最新列表。
 */
export async function loadSlashCommandsFromIpc(): Promise<void> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) return

  try {
    const entries = await api.sendCommand({ type: 'commands:list' }) as CommandListEntry[]
    if (!Array.isArray(entries) || entries.length === 0) return

    const baseCommands = entries.map(fromCommandListEntry)
    cachedCommands = [...baseCommands, ...CLIENT_ONLY_COMMANDS]
  } catch {
    // 静默失败，保持内置默认
  }
}

/**
 * 保持向后兼容 — 导出 SLASH_COMMANDS 常量（实际使用 getSlashCommands()）
 * @deprecated 请使用 getSlashCommands()
 */
export const SLASH_COMMANDS: SlashCommand[] = getBuiltinCommands()

/** 按名称和别名查找命令（精确匹配） */
export function findCommand(input: string): SlashCommand | null {
  const lower = input.toLowerCase().trim()
  return getSlashCommands().find(
    (cmd) =>
      cmd.name === lower ||
      cmd.aliases?.includes(lower),
  ) ?? null
}

/**
 * 模糊搜索命令列表
 *
 * 当输入以 "/" 开头时，过滤出名称或描述中含有查询词的命令。
 * 优先级：名称前缀匹配 > 名称包含 > 描述包含
 *
 * @param query - 用户输入（如 "/com"、"/mem"、""）
 */
export function searchCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase().replace(/^\//, '')
  const commands = getSlashCommands()

  if (!q) {
    return commands
  }

  const prefix: SlashCommand[] = []
  const contains: SlashCommand[] = []
  const descContains: SlashCommand[] = []

  for (const cmd of commands) {
    const nameBody = cmd.name.slice(1) // 去掉前缀 /
    const aliasMatch = cmd.aliases?.some((a) => a.slice(1).startsWith(q))

    if (nameBody.startsWith(q) || aliasMatch) {
      prefix.push(cmd)
    } else if (nameBody.includes(q)) {
      contains.push(cmd)
    } else if (cmd.description.toLowerCase().includes(q)) {
      descContains.push(cmd)
    }
  }

  return [...prefix, ...contains, ...descContains]
}
