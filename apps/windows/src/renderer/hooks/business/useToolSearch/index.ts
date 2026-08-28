/**
 * useToolSearch — 工具列表管理 + 实时搜索过滤
 *
 * 通过 IPC 从主进程获取工具列表，支持搜索过滤和启用/禁用切换。
 */

import { useState, useEffect, useMemo, useCallback } from 'react'

export interface ToolInfo {
  name: string
  label: string
  description: string
  category: string
  isReadOnly: boolean
  needsPermission: boolean
  enabled: boolean
  /** 累计调用次数，从未调用过为 0 */
  usageCount?: number
  /** 最后一次调用时刻（epoch ms） */
  lastUsedAt?: number
}

export interface McpServerStatus {
  name: string
  connected: boolean
  connecting?: boolean
  enabled?: boolean
  lastError?: string
  /** 该 server 工具定义的估算 token（与上下文用量条同一口径） */
  estimatedTokens?: number
}

const BUILTIN_TOOL_I18N: Record<string, { label: string; description: string }> = {
  file_read: { label: '读取文件', description: '读取本地文件内容。' },
  file_write: { label: '写入文件', description: '创建或覆盖本地文件。' },
  file_edit: { label: '编辑文件', description: '对现有文件做精确修改。' },
  list_dir: { label: '列出目录', description: '列出某一层文件和文件夹。' },
  file_mkdir: { label: '创建目录', description: '创建文件夹，已存在则跳过。' },
  file_move: { label: '移动文件', description: '移动或重命名文件、文件夹。' },
  file_copy: { label: '复制文件', description: '复制文件或文件夹。' },
  glob: { label: '文件匹配', description: '按 glob 模式查找文件。' },
  grep: { label: '内容搜索', description: '按模式搜索文件内容。' },
  bash: { label: '命令执行', description: '执行本地 shell 命令。' },
  web_fetch: { label: '网页抓取', description: '抓取并提取网页正文内容。' },
  web_search: { label: '网页搜索', description: '联网搜索实时信息。' },
  todo_write: { label: '任务清单', description: '管理当前会话中的任务清单。' },
  spawn_agent: { label: '派生子 Agent', description: '创建子 Agent 执行复杂任务。' },
  send_message: { label: '发送消息', description: '向其他 Agent 发送消息。' },
  cron_create: { label: '创建定时任务', description: '创建 cron、间隔或一次性定时任务。' },
  cron_list: { label: '查看定时任务', description: '查看当前定时任务列表和状态。' },
  cron_delete: { label: '删除定时任务', description: '按任务 ID 删除定时任务。' },
}

/** 调用次数的简短展示：0 次显示「未用过」，上千折成 k */
export function formatToolUsageCount(count?: number): string {
  if (!count) return '未用过'
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k 次`
  return `${count} 次`
}

/** 悬浮提示用的完整用量说明（含最后使用时间） */
export function formatToolUsageTitle(tool: ToolInfo): string {
  if (!tool.usageCount) return '从未调用过，可考虑关闭以节省上下文'
  const last = tool.lastUsedAt ? `，最后使用 ${new Date(tool.lastUsedAt).toLocaleString()}` : ''
  return `累计调用 ${tool.usageCount} 次${last}`
}

/**
 * 将工具列表中的名称与描述本地化为中文（内建工具优先）。
 */
function localizeTools(input: ToolInfo[]): ToolInfo[] {
  return input.map((tool) => {
    const localized = BUILTIN_TOOL_I18N[tool.name]
    if (!localized) {
      return tool
    }
    return {
      ...tool,
      label: localized.label,
      description: localized.description,
    }
  })
}

export function useToolSearch() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [togglingTool, setTogglingTool] = useState<string | null>(null)
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus[]>([])

  /** 从主进程加载工具列表 */
  const loadTools = useCallback(async () => {
    setIsLoading(true)
    try {
      const [toolsResult, mcpResult] = await Promise.all([
        window.electronAPI.agentRuntime.sendCommand({ type: 'tools:list' }) as Promise<ToolInfo[]>,
        window.electronAPI.agentRuntime.sendCommand({ type: 'mcp:status' }) as Promise<{
          servers?: McpServerStatus[]
        }>,
      ])
      setTools(localizeTools(toolsResult ?? []))
      // 兼容旧版直接返回数组的调用方（若有）
      const servers = Array.isArray(mcpResult)
        ? mcpResult
        : (mcpResult?.servers ?? [])
      setMcpStatus(servers)
    } catch {
      setTools([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTools()
  }, [loadTools])

  /** 搜索过滤（名称 + 描述） */
  const filtered = useMemo(() => {
    if (!query.trim()) return tools
    const q = query.toLowerCase()
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.label.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    )
  }, [tools, query])

  /** 按分类分组 */
  const grouped = useMemo(() => {
    const map = new Map<string, ToolInfo[]>()
    for (const tool of filtered) {
      const list = map.get(tool.category) ?? []
      list.push(tool)
      map.set(tool.category, list)
    }
    return map
  }, [filtered])

  /** 统计 */
  const stats = useMemo(
    () => ({
      total: tools.length,
      enabled: tools.filter((t) => t.enabled).length,
    }),
    [tools],
  )

  /** 切换工具启用/禁用 */
  const toggleTool = useCallback(async (toolName: string, enabled: boolean) => {
    setTogglingTool(toolName)
    try {
      await window.electronAPI.agentRuntime.sendCommand({
        type: 'tools:toggle',
        toolName,
        enabled,
      })
      // 乐观更新本地状态
      setTools((prev) =>
        prev.map((t) => (t.name === toolName ? { ...t, enabled } : t)),
      )
    } catch {
      // 失败时重新加载
      await loadTools()
    } finally {
      setTogglingTool(null)
    }
  }, [loadTools])

  return {
    tools,
    filtered,
    grouped,
    stats,
    query,
    setQuery,
    isLoading,
    togglingTool,
    toggleTool,
    mcpStatus,
    refresh: loadTools,
  }
}
