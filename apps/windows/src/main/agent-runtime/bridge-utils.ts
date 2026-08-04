/**
 * AgentRuntimeBridge 共享工具函数与常量（与主类解耦，便于单测与复用）
 */

import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import {
  BUILT_IN_AGENTS,
  findBuiltInAgent,
  WRITE_TOOL_NAMES,
  type AgentDefinition,
  type AgentInstance,
  type AgentTool,
  type TaskStatus,
} from '@mtbot/agent-runtime'

/** 子 Agent 强制禁用的工具列表（与 bridge 主类注释一致） */
export const CHILD_AGENT_DISALLOWED_TOOLS: readonly string[] = ['spawn_agent', 'send_message']

/** 主进程 Agent Runtime 日志前缀 */
export const agentRuntimeLog = {
  info: (...args: unknown[]) => console.log('[AgentRuntime]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime]', ...args),
  error: (...args: unknown[]) => console.error('[AgentRuntime]', ...args),
}

/**
 * 将任意 JSON 可序列化结果包装为 pi-agent 工具返回格式
 */
export function jsonToolResult(data: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    details: undefined,
  }
}

/**
 * 从 pi-agent 工具返回体中解析 JSON 载荷。
 * Windows bridge 的 jsonToolResult 将数据序列化在 content[0].text 中，
 * 分析埋点不得直接把 event.result 当作业务对象读取。
 */
export function parseJsonToolResultPayload(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null
  const r = result as { content?: Array<{ type?: string; text?: unknown }>; details?: unknown }
  const textBlock = r.content?.find((c) => c?.type === 'text' && typeof c.text === 'string')
  if (textBlock?.text) {
    try {
      const parsed = JSON.parse(textBlock.text) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  if (!Array.isArray(r.content)) {
    return r as Record<string, unknown>
  }
  return null
}

/**
 * 从 Markdown 文档中删除一个 `## ` 级别的章节（含其标题行直到下一个同级或更高级标题）。
 * heading 匹配忽略前后空白与 `## ` 前缀，大小写不敏感。返回新内容与是否命中。
 */
export function removeMarkdownSection(
  doc: string,
  heading: string,
): { content: string; removed: boolean } {
  const target = heading.replace(/^#+\s*/, '').trim().toLowerCase()
  if (!target) return { content: doc, removed: false }

  const lines = doc.split(/\r?\n/)
  const out: string[] = []
  let removed = false
  let skipping = false

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    if (h2) {
      const isTarget = h2[1].trim().toLowerCase() === target
      if (isTarget) {
        skipping = true
        removed = true
        continue
      }
      // 命中下一个 ## 标题（非目标）则停止跳过
      if (skipping) skipping = false
    } else if (skipping) {
      const higher = /^#\s+/.test(line) // 顶级 # 标题也终止跳过
      if (higher) {
        skipping = false
      } else {
        continue
      }
    }
    if (!skipping) out.push(line)
  }

  return { content: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', removed }
}

/**
 * 将字符串解析为严格的毫秒整数。
 */
export function parseStrictMs(raw: string | undefined): number | undefined {
  const value = raw?.trim()
  if (!value || !/^\d+$/.test(value)) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined
  }
  return Math.floor(parsed)
}

/**
 * 解析 one-shot 调度表达式，兼容常见 `${Date.now() + ...}` 写法。
 */
export function parseAtScheduleExpr(rawExpr: string): number | undefined {
  const direct = parseStrictMs(rawExpr)
  if (direct !== undefined) {
    if (direct > 0 && direct < 1_000_000_000_000) {
      return direct * 1000
    }
    return direct
  }
  const expr = rawExpr.trim()
  const now = Date.now()
  const plusOffsetPattern = /^\$\{\s*Date\.now\(\)\s*\+\s*(\d+)\s*\}$/
  const plusMinutesPattern = /^\$\{\s*Date\.now\(\)\s*\+\s*(\d+)\s*\*\s*60\s*\*\s*1000\s*\}$/
  const floorNowPattern = /^\$\{\s*Math\.floor\(Date\.now\(\)\s*\/\s*1000\)\s*\*\s*1000\s*\+\s*(\d+)\s*\}$/

  const plusOffset = plusOffsetPattern.exec(expr)
  if (plusOffset) {
    return now + Number(plusOffset[1])
  }
  const plusMinutes = plusMinutesPattern.exec(expr)
  if (plusMinutes) {
    return now + Number(plusMinutes[1]) * 60 * 1000
  }
  const floorNowOffset = floorNowPattern.exec(expr)
  if (floorNowOffset) {
    const alignedNow = Math.floor(now / 1000) * 1000
    return alignedNow + Number(floorNowOffset[1])
  }
  const parsedDateMs = Date.parse(expr)
  if (Number.isFinite(parsedDateMs)) {
    return parsedDateMs
  }
  return undefined
}

/**
 * 将模型传入的 status 字符串规范化为 TaskStatus，非法时返回 undefined（保留原状态）
 */
export function parseTaskStatus(raw: string | undefined): TaskStatus | undefined {
  if (!raw) return undefined
  const aliases: Record<string, TaskStatus> = {
    todo: 'pending',
    review: 'in_progress',
  }
  if (aliases[raw]) return aliases[raw]
  const allowed: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'cancelled']
  return allowed.includes(raw as TaskStatus) ? (raw as TaskStatus) : undefined
}

/**
 * 按实例 id、definitionId 或内建 Agent 名称解析目标实例
 */
export function findAgentInstanceByRecipient(instances: AgentInstance[], to: string): AgentInstance | undefined {
  const direct = instances.find((i) => i.id === to || i.definitionId === to)
  if (direct) return direct
  const byId = findBuiltInAgent(to)
  if (byId) {
    return instances.find((i) => i.definitionId === byId.id)
  }
  const byName = BUILT_IN_AGENTS.find((a) => a.name === to)
  if (byName) {
    return instances.find((i) => i.definitionId === byName.id)
  }
  return undefined
}

/**
 * 按 Agent 定义过滤工具列表
 *
 * 优先级: canSpawnSubAgents > disallowedTools 黑名单 > tools 白名单 > readOnly 模式过滤
 */
export function filterToolsByDefinition<T extends AgentTool>(
  allTools: readonly T[],
  def: AgentDefinition,
): T[] {
  let filtered: T[] = [...allTools]

  if (def.canSpawnSubAgents === false) {
    filtered = filtered.filter((t) => t.name !== 'spawn_agent' && t.name !== 'send_message')
  }

  if (def.tools && !def.tools.includes('*')) {
    const whiteset = new Set(def.tools)
    filtered = filtered.filter((t) => whiteset.has(t.name))
  }

  if (def.disallowedTools?.length) {
    const blackset = new Set(def.disallowedTools)
    filtered = filtered.filter((t) => !blackset.has(t.name))
  }

  if (def.permissionMode === 'readOnly') {
    filtered = filtered.filter((t) => !WRITE_TOOL_NAMES.has(t.name))
  }

  return filtered
}
