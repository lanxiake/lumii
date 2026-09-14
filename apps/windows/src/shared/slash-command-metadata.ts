/**
 * 基础斜杠命令元数据（主进程与渲染层共用的单一事实来源）
 *
 * 客户端 `/` 补全面板、`/help` 输出、命令解析都读这份列表：
 * 渲染层 `loadSlashCommandsFromIpc()` 只要从 IPC 拿到非空数组就会**整体覆盖**内置兜底表，
 * 因此这里**必须列全** —— 漏一条就等于该命令在客户端既不进补全面板、输入后也会被放行给 LLM。
 *
 * 客户端专属命令（后端切换 /models 等）由渲染层自行追加（CLIENT_ONLY_COMMANDS）。
 * 渠道侧（微信/飞书/企微/QQ）另有各自的注册表，见 main/channel/adapters/*。
 */

import type { CommandListEntry } from './agent-runtime-commands'

export const BASE_SLASH_COMMANDS: readonly CommandListEntry[] = [
  // ── 信息查询 ──────────────────────────────────────────────────
  {
    key: 'help',
    name: '/help',
    aliases: [],
    description: '显示所有可用命令',
    usage: '/help',
    category: 'info',
    acceptsArgs: false,
  },
  {
    key: 'status',
    name: '/status',
    aliases: [],
    description: '查看当前 Agent 状态（上下文用量、模型等）',
    usage: '/status',
    category: 'info',
    acceptsArgs: false,
  },
  // ── 会话管理 ──────────────────────────────────────────────────
  {
    key: 'clear',
    name: '/clear',
    aliases: [],
    description: '清空当前会话的所有消息（保留会话）',
    usage: '/clear',
    category: 'session',
    acceptsArgs: false,
  },
  {
    key: 'new',
    name: '/new',
    aliases: ['/n'],
    description: '新建一个空白会话',
    usage: '/new',
    category: 'session',
    acceptsArgs: false,
  },
  {
    key: 'resume',
    name: '/resume',
    aliases: ['/r'],
    description: '查看最近会话，可恢复对话',
    usage: '/resume [编号]',
    category: 'session',
    acceptsArgs: true,
  },
  {
    key: 'compact',
    name: '/compact',
    aliases: ['/compress'],
    description: '压缩对话上下文，删除较早的消息以释放 token',
    usage: '/compact [自定义压缩指令]',
    category: 'session',
    acceptsArgs: true,
  },
  // ── 记忆管理 ──────────────────────────────────────────────────
  {
    key: 'memory',
    name: '/memory',
    aliases: [],
    description: '查看当前 Agent 的记忆列表，支持 clear 子命令',
    usage: '/memory [clear]',
    category: 'memory',
    acceptsArgs: true,
  },
  // ── 设置选项 ──────────────────────────────────────────────────
  {
    key: 'think',
    name: '/think',
    aliases: ['/thinking', '/t'],
    description: '设置思考级别（off/low/medium/high）',
    usage: '/think <off|low|medium|high>',
    category: 'settings',
    acceptsArgs: true,
  },
]
