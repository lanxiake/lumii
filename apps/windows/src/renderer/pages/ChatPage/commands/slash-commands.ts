/**
 * 客户端斜杠命令注册表
 *
 * 基础命令（help/status/clear/new/resume/compact/memory/think）由主进程 IPC 提供
 * （命令类型 'commands:list'），客户端本地追加 backend-switching 等客户端专属命令。
 *
 * 这样命令元数据只在一处（主进程 ipc/agent-runtime/misc-commands.ts 的
 * BASE_SLASH_COMMANDS）维护，跨渠道变更只需改那一处。
 */

import type { CommandListEntry } from '../../../../shared/agent-runtime-commands'

export type CommandCategory = 'session' | 'memory' | 'backend' | 'info' | 'settings' | 'skill'

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
  /** 技能命令：本地技能 ID（用于区分普通命令） */
  skillId?: string
  /** 技能命令：传给 skill_invoke 的技能名称（展示名，可能不同于命令名） */
  skillName?: string
  /** 使用次数（技能取自 executionCount，内置命令取自本地计数），用于导航列表排序 */
  usageCount?: number
}

/** 命令分类中文标签 */
export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  session: '会话管理',
  memory: '记忆管理',
  backend: '后端切换',
  info: '信息查询',
  settings: '设置选项',
  skill: '技能',
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
  {
    name: '/project',
    description: '查看 / 切换当前会话的开发项目（ACP 工作目录）',
    usage: '/project [项目名|off]',
    category: 'backend',
  },
  // ── 设置选项 ──────────────────────────────────────────────────
  {
    name: '/models',
    aliases: ['/model'],
    description: '查看已配置模型，并将当前会话切换到指定模型',
    usage: '/models [编号或模型 ID]',
    category: 'settings',
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
function invalidateSlashCommandsCache(): void {
  cachedCommands = null
}

// ── 使用次数 ──────────────────────────────────────────────────────

/** 本地命令使用计数（内置命令没有服务端统计，按机器记录） */
const USAGE_STORAGE_KEY = 'mtbot:slash-command-usage'

function readUsageCounts(): Record<string, number> {
  if (typeof window === 'undefined' || !window.localStorage) return {}
  try {
    const raw = window.localStorage.getItem(USAGE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const counts: Record<string, number> = {}
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) counts[name] = value
    }
    return counts
  } catch {
    return {}
  }
}

/** 记录一次命令使用，并同步更新内存缓存（下次打开面板即按新次数排序） */
export function recordCommandUsage(name: string): void {
  const counts = readUsageCounts()
  counts[name] = (counts[name] ?? 0) + 1
  try {
    window.localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(counts))
  } catch {
    // 写入失败只影响排序，不影响命令执行
  }

  if (cachedCommands) {
    cachedCommands = sortCommandsByUsage(
      cachedCommands.map((cmd) =>
        cmd.name === name ? { ...cmd, usageCount: (cmd.usageCount ?? 0) + 1 } : cmd,
      ),
    )
  }
}

/** 把本地计数叠加到命令上（技能次数来自索引 executionCount） */
function applyLocalUsage(commands: SlashCommand[]): SlashCommand[] {
  const counts = readUsageCounts()
  return commands.map((cmd) => ({
    ...cmd,
    usageCount: (cmd.usageCount ?? 0) + (counts[cmd.name] ?? 0),
  }))
}

/**
 * 按使用次数降序排序；次数相同（含都未使用）时按名称字母序。
 * 导出供单测直接验证排序口径。
 */
export function sortCommandsByUsage(commands: SlashCommand[]): SlashCommand[] {
  return [...commands].sort((a, b) => {
    const diff = (b.usageCount ?? 0) - (a.usageCount ?? 0)
    if (diff !== 0) return diff
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

/**
 * 获取当前命令列表（同步）
 *
 * 优先从缓存返回；若未缓存则返回内置默认列表。
 * 异步加载完成后通过 invalidateSlashCommandsCache() 触发刷新。
 */
export function getSlashCommands(): SlashCommand[] {
  if (cachedCommands) return cachedCommands

  // 返回内置默认（与 IPC 基础命令保持一致），同样带上本地使用次数
  return sortCommandsByUsage(applyLocalUsage(getBuiltinCommands()))
}

/** 内置默认命令列表（与主进程 misc-commands.ts 中 BASE_SLASH_COMMANDS 保持一致） */
function getBuiltinBaseCommands(): SlashCommand[] {
  return [
    // ── 信息查询 ──────────────────────────────────────────────────
    { name: '/help', description: '显示所有可用命令', usage: '/help', category: 'info' },
    { name: '/status', description: '查看当前 Agent 状态（上下文用量、模型等）', usage: '/status', category: 'info' },
    // ── 会话管理 ──────────────────────────────────────────────────
    { name: '/clear', description: '清空当前会话的所有消息（保留会话）', usage: '/clear', category: 'session' },
    { name: '/new', aliases: ['/n'], description: '新建一个空白会话', usage: '/new', category: 'session' },
    { name: '/resume', aliases: ['/r'], description: '查看最近会话，可恢复对话', usage: '/resume [编号]', category: 'session' },
    { name: '/compact', aliases: ['/compress'], description: 'AI 总结历史消息并重构上下文，释放 token 空间', usage: '/compact [自定义压缩指令]', category: 'session' },
    // ── 记忆管理 ──────────────────────────────────────────────────
    { name: '/memory', description: '查看当前 Agent 的记忆列表，支持 clear 子命令', usage: '/memory [clear]', category: 'memory' },
    // ── 设置选项 ──────────────────────────────────────────────────
    { name: '/think', aliases: ['/thinking', '/t'], description: '设置思考级别（off/low/medium/high）', usage: '/think <off|low|medium|high>', category: 'settings' },
  ]
}

function getBuiltinCommands(): SlashCommand[] {
  return [...getBuiltinBaseCommands(), ...CLIENT_ONLY_COMMANDS]
}

/** 本地技能索引条目（skills:listLocalInstalled 的返回结构） */
interface LocalSkillEntry {
  id: string
  dirName?: string
  name?: string
  description?: string
  enabled?: boolean
  /** 技能累计执行次数（skill_invoke 成功加载后由主进程累加） */
  executionCount?: number
}

/** 把技能目录名转成可输入的斜杠命令名（保留中文，去掉空格与非法字符） */
function toSkillSlug(entry: LocalSkillEntry): string {
  const raw = entry.dirName || entry.id.split('/').pop() || entry.id
  return raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_\-.一-龥]/g, '')
    .toLowerCase()
}

/**
 * 把「用户开启的技能」转换成斜杠命令。
 *
 * 命令名优先取目录名（ASCII 友好），展示名走 skillName（skill_invoke 按展示名匹配）。
 * 与内置命令重名时依次尝试 `-skill`、`-skill-2`，避免覆盖内置语义。
 */
export function buildSkillCommands(entries: LocalSkillEntry[], reserved: Set<string>): SlashCommand[] {
  const used = new Set(reserved)
  const commands: SlashCommand[] = []

  for (const entry of entries) {
    if (entry.enabled === false) continue
    const base = toSkillSlug(entry)
    if (!base) continue

    let name = `/${base}`
    if (used.has(name)) {
      name = `/${base}-skill`
      let suffix = 2
      while (used.has(name)) name = `/${base}-skill-${suffix++}`
    }
    used.add(name)

    const displayName = entry.name?.trim() || entry.dirName || entry.id
    const description = entry.description?.trim() || '本地技能'
    commands.push({
      name,
      description: description.length > 80 ? `${description.slice(0, 79)}…` : description,
      usage: `${name} [需求]`,
      category: 'skill',
      skillId: entry.id,
      skillName: displayName,
      usageCount: entry.executionCount ?? 0,
    })
  }

  return commands
}

/** 读取已启用技能并转为斜杠命令（失败时静默返回空列表） */
async function loadEnabledSkillCommands(reserved: Set<string>): Promise<SlashCommand[]> {
  const skillsApi = window.electronAPI?.skills
  if (!skillsApi?.listLocalInstalled) return []

  try {
    const raw = await skillsApi.listLocalInstalled()
    const entries: LocalSkillEntry[] = Array.isArray(raw)
      ? raw as LocalSkillEntry[]
      : ((raw as { data?: LocalSkillEntry[] } | null)?.data ?? [])
    return buildSkillCommands(entries, reserved)
  } catch {
    return []
  }
}

/** 内置命令（base + 客户端专属）的名称与别名，用于避免技能命令重名 */
function reservedCommandNames(commands: SlashCommand[]): Set<string> {
  const names = new Set<string>()
  for (const cmd of commands) {
    names.add(cmd.name)
    for (const alias of cmd.aliases ?? []) names.add(alias)
  }
  return names
}

/**
 * 从 IPC 异步加载基础命令与已启用技能，并更新缓存
 *
 * 在应用初始化阶段与 `skills:updated` 事件后调用；
 * 加载完成后缓存更新，下次 getSlashCommands() 返回最新列表。
 */
export async function loadSlashCommandsFromIpc(): Promise<void> {
  let baseCommands: SlashCommand[] | null = null
  const api = window.electronAPI?.agentRuntime

  if (api?.sendCommand) {
    try {
      const entries = await api.sendCommand({ type: 'commands:list' }) as CommandListEntry[]
      if (Array.isArray(entries) && entries.length > 0) {
        baseCommands = entries.map(fromCommandListEntry)
      }
    } catch {
      // 静默失败，保持内置默认
    }
  }

  const base = baseCommands ?? getBuiltinBaseCommands()
  const reserved = reservedCommandNames([...base, ...CLIENT_ONLY_COMMANDS])
  const skillCommands = await loadEnabledSkillCommands(reserved)

  cachedCommands = sortCommandsByUsage(
    applyLocalUsage([...base, ...CLIENT_ONLY_COMMANDS, ...skillCommands]),
  )
}

/**
 * 保持向后兼容 — 导出 SLASH_COMMANDS 常量（实际使用 getSlashCommands()）
 * @deprecated 请使用 getSlashCommands()
 */
const SLASH_COMMANDS: SlashCommand[] = getBuiltinCommands()

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
    return sortCommandsByUsage(commands)
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

  // 同一匹配优先级内：按使用次数降序，未使用时按名称字母序
  return [
    ...sortCommandsByUsage(prefix),
    ...sortCommandsByUsage(contains),
    ...sortCommandsByUsage(descContains),
  ]
}
