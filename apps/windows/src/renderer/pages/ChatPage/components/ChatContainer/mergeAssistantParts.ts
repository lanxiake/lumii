import type { AssistantPart, FileChangeEntry } from '@mtbot/agent-runtime'

/**
 * 将子 Agent parts 插到父消息末尾连续 text 段之前，避免工具全部落到终稿之后
 */
export function mergeAssistantParts(
  parentParts: readonly AssistantPart[] | undefined,
  childParts: readonly AssistantPart[] | undefined,
): AssistantPart[] {
  const parent = [...(parentParts ?? [])]
  const child = [...(childParts ?? [])]
  if (child.length === 0) return parent
  let insertAt = parent.length
  while (insertAt > 0 && parent[insertAt - 1]?.type === 'text') insertAt--
  return [...parent.slice(0, insertAt), ...child, ...parent.slice(insertAt)]
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
