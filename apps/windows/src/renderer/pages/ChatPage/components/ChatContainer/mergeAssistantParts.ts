import type { AssistantPart, FileChangeEntry } from '@mtbot/agent-runtime/browser'

/**
 * 将子 Agent parts 追加到父消息末尾，保持时间顺序
 *
 * 修复问题：之前的实现会将子 Agent parts 插入到"末尾连续 text 之前"，
 * 导致当主 Agent 在调用子 Agent 后继续输出时，子 Agent 内容显示在主 Agent 后续输出之后，
 * 造成消息乱序（先回复的内容显示在后面，后回复的内容显示在前面）。
 *
 * 现在改为直接追加，保持消息按真实回复顺序显示。
 */
export function mergeAssistantParts(
  parentParts: readonly AssistantPart[] | undefined,
  childParts: readonly AssistantPart[] | undefined,
): AssistantPart[] {
  const parent = [...(parentParts ?? [])]
  const child = [...(childParts ?? [])]
  if (child.length === 0) return parent
  // 直接追加到末尾，保持时间顺序
  return [...parent, ...child]
}

/**
 * 合并父子回合 fileChanges：按 path 去重，子 Agent 条目覆盖同路径父条目
 */
export function mergeFileChanges(
  parentChanges: readonly FileChangeEntry[] | undefined,
  childChanges: readonly FileChangeEntry[] | undefined,
): FileChangeEntry[] {
  const seen = new Map<string, FileChangeEntry>()
  for (const entry of [...(parentChanges ?? []), ...(childChanges ?? [])]) {
    seen.set(entry.path, entry)
  }
  return [...seen.values()]
}
