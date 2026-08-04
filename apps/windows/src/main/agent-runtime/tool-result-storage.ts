/**
 * 工具结果落盘预览替换 + 聚合预算
 *
 * 参考 Claude Code toolResultStorage.ts 设计：
 * 1. 单条工具结果超过 DEFAULT_MAX_RESULT_SIZE_CHARS 时，完整内容落盘到工作空间文件，
 *    上下文中替换为摘要预览（前 N 行 + 文件引用），避免单次工具调用撑爆上下文。
 * 2. 同一轮所有 toolResult 总量超过 MAX_TOOL_RESULTS_PER_TURN_CHARS 时，
 *    选择最大的若干块落盘替换，直到回到预算内。
 *
 * 落盘路径：workspace/.tool-results/{conversationId}/{toolCallId}.txt
 * Agent 可通过 file_read 按需读取完整内容。
 *
 * 设计依据: .qoder/design/agent-tools-skills/tool-layer-compaction-bridge-comparison.md §2.2-2.3
 */

import fs from 'node:fs'
import path from 'node:path'
import { agentRuntimeLog as log } from './bridge-utils'

/** 单条工具结果的落盘阈值（字符数）。超过此值时落盘并替换为预览。 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 30_000

/** 同一轮所有 toolResult 的总预算（字符数）。超过时选择最大的落盘。 */
export const MAX_TOOL_RESULTS_PER_TURN_CHARS = 120_000

/** 预览中保留的前 N 行（让 Agent 看到结构/开头） */
const PREVIEW_HEAD_LINES = 30

/** 预览中保留的尾部行数 */
const PREVIEW_TAIL_LINES = 10

/** file_read 工具不走落盘预览替换（避免"落盘→再 Read 回来"循环） */
const EXEMPT_TOOL_NAMES = new Set(['file_read'])

export interface ToolResultEntry {
  toolCallId: string
  toolName: string
  content: string
  charCount: number
}

/**
 * 对单条工具结果做落盘预览替换（如果超过阈值）
 *
 * @param cwd 工作空间根目录（落盘文件写入 cwd/.tool-results/...）
 * @returns 替换后的内容（可能是原文或预览摘要）
 */
export function maybePersistLargeToolResult(
  entry: ToolResultEntry,
  cwd: string,
  conversationId: string | undefined,
  maxChars: number = DEFAULT_MAX_RESULT_SIZE_CHARS,
): string {
  if (EXEMPT_TOOL_NAMES.has(entry.toolName)) {
    return entry.content
  }
  if (entry.charCount <= maxChars) {
    return entry.content
  }
  if (!conversationId || !cwd) {
    return truncateWithPreview(entry.content, entry.toolName, entry.toolCallId)
  }

  // 落盘到工作空间文件系统
  const relPath = `.tool-results/${conversationId}/${entry.toolCallId}.txt`
  const absPath = path.join(cwd, relPath)
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, entry.content, 'utf-8')
    log.info(
      `[toolResultStorage] 落盘: toolName=${entry.toolName} toolCallId=${entry.toolCallId} ` +
      `chars=${entry.charCount} → ${relPath}`,
    )
  } catch (err) {
    log.warn(`[toolResultStorage] 落盘失败，降级为截断预览: ${err instanceof Error ? err.message : String(err)}`)
    return truncateWithPreview(entry.content, entry.toolName, entry.toolCallId)
  }

  return buildPreviewWithReference(entry.content, entry.toolName, absPath)
}

/**
 * 对同一轮的所有 toolResult 做聚合预算检查
 *
 * 如果总量超过 MAX_TOOL_RESULTS_PER_TURN_CHARS，按大小降序选择最大的落盘替换，
 * 直到总量回到预算内。
 *
 * @returns 替换后的 entries（content 可能已被替换为预览）
 */
export function enforceToolResultBudget(
  entries: ToolResultEntry[],
  cwd: string,
  conversationId: string | undefined,
  budgetChars: number = MAX_TOOL_RESULTS_PER_TURN_CHARS,
): ToolResultEntry[] {
  const totalChars = entries.reduce((sum, e) => sum + e.charCount, 0)
  if (totalChars <= budgetChars) {
    return entries
  }

  log.info(
    `[toolResultBudget] 总量 ${totalChars} 超过预算 ${budgetChars}，开始选择性落盘`,
  )

  // 按大小降序排列索引
  const indexed = entries.map((e, i) => ({ entry: e, index: i }))
  indexed.sort((a, b) => b.entry.charCount - a.entry.charCount)

  let currentTotal = totalChars
  const replacedIndices = new Set<number>()

  for (const { entry, index } of indexed) {
    if (currentTotal <= budgetChars) break
    if (EXEMPT_TOOL_NAMES.has(entry.toolName)) continue
    if (entry.charCount <= 1000) continue

    const replaced = maybePersistLargeToolResult(entry, cwd, conversationId, 0)
    const saved = entry.charCount - replaced.length
    currentTotal -= saved
    replacedIndices.add(index)
    entries[index] = { ...entry, content: replaced, charCount: replaced.length }
  }

  log.info(
    `[toolResultBudget] 落盘 ${replacedIndices.size} 条，总量 ${totalChars} → ${currentTotal}`,
  )

  return entries
}

/**
 * 构建带文件引用的预览摘要
 */
function buildPreviewWithReference(
  content: string,
  toolName: string,
  storedPath: string,
): string {
  const lines = content.split('\n')
  const headLines = lines.slice(0, PREVIEW_HEAD_LINES).join('\n')
  const tailLines = lines.length > PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES
    ? '\n...\n' + lines.slice(-PREVIEW_TAIL_LINES).join('\n')
    : ''

  return (
    `[工具结果已落盘（原始 ${content.length} 字符，${lines.length} 行）]\n` +
    `[完整内容存储于: ${storedPath}，可通过 file_read 按需读取]\n` +
    `[工具: ${toolName}]\n\n` +
    `--- 预览（前 ${PREVIEW_HEAD_LINES} 行）---\n` +
    headLines +
    tailLines +
    `\n--- 预览结束 ---\n\n` +
    `[如需查看完整内容，请使用 file_read 工具读取 "${storedPath}"，支持 offset+limit 分页。]`
  )
}

/**
 * 无法落盘时的降级截断预览
 */
function truncateWithPreview(
  content: string,
  toolName: string,
  toolCallId: string,
): string {
  const lines = content.split('\n')
  const headLines = lines.slice(0, PREVIEW_HEAD_LINES).join('\n')
  const tailLines = lines.length > PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES
    ? '\n...\n' + lines.slice(-PREVIEW_TAIL_LINES).join('\n')
    : ''

  return (
    `[工具结果过大已截断（原始 ${content.length} 字符，${lines.length} 行）]\n` +
    `[工具: ${toolName}, toolCallId: ${toolCallId}]\n\n` +
    `--- 预览（前 ${PREVIEW_HEAD_LINES} 行）---\n` +
    headLines +
    tailLines +
    `\n--- 预览结束 ---\n\n` +
    `[如需完整内容，请使用更精确的参数重新调用工具（如 file_read 的 offset+limit 分页）。]`
  )
}
