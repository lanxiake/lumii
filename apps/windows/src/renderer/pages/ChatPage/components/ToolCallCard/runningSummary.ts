/**
 * 同步工具运行中摘要文案。
 *
 * 优先 MCP/工具上报的 progressText；否则用 input 目标（命令/路径等），
 * 让长耗时工具在未展开时也能看到「在干什么」。
 */

import type { AgentWorkflowItem } from '../../../../hooks/business/useChat'

/** 从 input 提取短目标名（与 ToolCallCard 标签同源逻辑的精简版） */
export function extractRunningTarget(
  input: Record<string, unknown> | undefined,
  toolName: string,
): string {
  if (!input) return ''
  const lname = toolName.toLowerCase()

  const filePath = (input.file_path || input.path || input.notebook_path || input.filePath) as
    | string
    | undefined
  if (filePath && typeof filePath === 'string') {
    const parts = filePath.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || filePath
  }

  if (lname.includes('grep') || lname.includes('search')) {
    const pattern = (input.pattern || input.query || input.q) as string | undefined
    if (pattern) return String(pattern).slice(0, 48)
  }

  const cmd = (input.command || input.cmd) as string | undefined
  if (cmd) return String(cmd).split('\n')[0].slice(0, 48)

  const url = (input.url || input.href) as string | undefined
  if (url) return String(url).slice(0, 48)

  const task = input.task as string | undefined
  if (task) return String(task).slice(0, 48)

  return ''
}

/**
 * 运行中首屏摘要：progressText > 目标名；非 running 返回 undefined。
 */
export function resolveRunningSummary(item: {
  status: AgentWorkflowItem['status']
  name?: string
  progressText?: string
  input?: Record<string, unknown>
}): string | undefined {
  if (item.status !== 'running') return undefined
  const progress = item.progressText?.trim()
  if (progress) return progress
  const target = extractRunningTarget(item.input, item.name || '')
  return target || undefined
}

/** 运行中耗时展示前缀，与后台任务卡「已用」对齐 */
export function formatRunningElapsedLabel(durationText: string): string {
  return `已用 ${durationText}`
}
