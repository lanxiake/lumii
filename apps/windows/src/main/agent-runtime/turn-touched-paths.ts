/**
 * 回合内文件写入归属跟踪
 *
 * 文件变更卡片由「回合开始/结束的全工作区快照 diff」得出，而所有会话共用同一个
 * workspace cwd。因此 A 会话回合窗口内 B 会话写的文件会被算进 A 的 diff（串台）。
 * 这里记录每个实例本轮通过写文件工具真正碰过的路径，用于把 diff 归属回各自会话。
 */

import path from 'node:path'
import type { FileChangeEntry } from '@mtbot/agent-runtime'

/** instanceId → 本轮已写路径（相对 cwd 的 posix 路径） */
const touchedByInstance = new Map<string, Set<string>>()

/** 绝对或相对路径统一为相对 cwd 的 posix 路径；越出 cwd 时返回 null */
function toWorkspaceRelative(filePath: string, cwd: string): string | null {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
  const rel = path.relative(cwd, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

/** 记录某实例本轮写过的文件；args 来自 file_write / file_edit / writeLocalFile */
export function recordTurnTouchedPath(
  instanceId: string,
  args: Record<string, unknown>,
  cwd: string,
): void {
  const filePath = args['filePath']
  if (typeof filePath !== 'string' || !filePath) return
  const rel = toWorkspaceRelative(filePath, cwd)
  if (!rel) return
  let set = touchedByInstance.get(instanceId)
  if (!set) {
    set = new Set()
    touchedByInstance.set(instanceId, set)
  }
  set.add(rel)
}

/** 回合开始与实例销毁时清空归属记录 */
export function clearTurnTouchedPaths(instanceId: string): void {
  touchedByInstance.delete(instanceId)
}

/**
 * 过滤 diff，剔除明确属于其他实例的变更。
 *
 * 保留条件：本实例写过，或没有任何实例声明过（bash / 图片服务等未走写文件工具的路径，
 * 无归属信息时归给当前回合，避免漏报真实变更）。
 */
export function filterOwnFileChanges(
  instanceId: string,
  changes: readonly FileChangeEntry[],
): FileChangeEntry[] {
  const own = touchedByInstance.get(instanceId)
  const claimedByOthers = new Set<string>()
  for (const [id, paths] of touchedByInstance) {
    if (id === instanceId) continue
    for (const p of paths) claimedByOthers.add(p)
  }
  if (claimedByOthers.size === 0) return [...changes]
  return changes.filter((entry) => own?.has(entry.path) || !claimedByOthers.has(entry.path))
}
