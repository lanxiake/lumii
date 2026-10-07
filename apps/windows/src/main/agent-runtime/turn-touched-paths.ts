/**
 * 回合内文件写入归属跟踪
 *
 * 文件变更卡片本可由「回合开始/结束的全工作区快照 diff」得出，但所有会话共用同一个
 * workspace cwd，diff 会把并发会话 / 后台任务写的文件也算进当前回合（串台）。
 * 因此卡片改为**严格按归属**：只保留本实例本轮真正写过的路径——写文件工具登记的，
 * 加会产出工作区文件的工具（生图 / 语音 / 截图等）从结果里登记的。
 *
 * 快照 diff 只用来定位「改成了什么状态」；无归属的变更（bash 脚本、外部进程写入）
 * 一律不进卡片——宁可漏报，也不把别的会话的改动混进来。
 */

import path from 'node:path'
import type { FileChangeEntry } from '@mtbot/agent-runtime'

/** instanceId → 本轮已写路径（相对 cwd 的 posix 路径） */
const touchedByInstance = new Map<string, Set<string>>()

/**
 * 自身不写文件、但结果里带产出工作区文件路径的工具。
 *
 * 严格归属下这些工具不会被写文件工具登记，逐个从结果里补登，避免把它们的产物漏掉。
 * 只收 `filePath` / `previewPath` 这类明确的产出字段，不碰 `path`（读类工具也会返回，
 * 误登记会让「别的会话改了同一路径」重新串进本会话）。
 */
const RESULT_FILE_PATH_TOOLS = new Set<string>([
  'image_generate',
  'speech_generate',
  'app_screenshot',
  'app_goto_and_screenshot',
  'browser_screenshot',
  'screen_screenshot',
  'screen_record_stop',
  'screen_record_annotate',
])

const RESULT_PATH_KEYS = ['filePath', 'previewPath'] as const

/** 绝对或相对路径统一为相对 cwd 的 posix 路径；越出 cwd 时返回 null */
function toWorkspaceRelative(filePath: string, cwd: string): string | null {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
  const rel = path.relative(cwd, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

/** 把若干绝对/相对路径归一后并入某实例的本轮路径集合 */
function addTouchedPaths(instanceId: string, paths: Iterable<string>, cwd: string): void {
  let set = touchedByInstance.get(instanceId)
  for (const filePath of paths) {
    const rel = toWorkspaceRelative(filePath, cwd)
    if (!rel) continue
    if (!set) {
      set = new Set()
      touchedByInstance.set(instanceId, set)
    }
    set.add(rel)
  }
}

/** 从工具参数里收集可能被改动的路径字段 */
function collectTouchedArgPaths(args: Record<string, unknown>): string[] {
  const keys = ['filePath', 'source', 'destination', 'path'] as const
  const out: string[] = []
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value) out.push(value)
  }
  return out
}

/** 从工具结果里收集产出文件路径；非产文件工具或无路径时返回空数组 */
export function collectResultTouchedPaths(toolName: string, result: unknown): string[] {
  if (!RESULT_FILE_PATH_TOOLS.has(toolName)) return []
  if (!result || typeof result !== 'object') return []
  const rec = result as Record<string, unknown>
  const details =
    rec['details'] && typeof rec['details'] === 'object'
      ? (rec['details'] as Record<string, unknown>)
      : undefined
  const out: string[] = []
  for (const key of RESULT_PATH_KEYS) {
    for (const src of [rec, details]) {
      const value = src?.[key]
      if (typeof value === 'string' && value) out.push(value)
    }
  }
  return out
}

/** 记录某实例本轮写过的文件；args 来自 file_write / file_edit / file_move / file_copy / file_mkdir */
export function recordTurnTouchedPath(
  instanceId: string,
  args: Record<string, unknown>,
  cwd: string,
): void {
  const paths = collectTouchedArgPaths(args)
  if (paths.length === 0) return
  addTouchedPaths(instanceId, paths, cwd)
}

/** 记录某实例本轮产出的单个文件路径（供工具结果 / 直连生图等非写文件工具调用） */
export function recordTurnTouchedFilePath(
  instanceId: string,
  filePath: string,
  cwd: string,
): void {
  if (!filePath) return
  addTouchedPaths(instanceId, [filePath], cwd)
}

/** 回合开始与实例销毁时清空归属记录 */
export function clearTurnTouchedPaths(instanceId: string): void {
  touchedByInstance.delete(instanceId)
}

/**
 * 严格按归属过滤 diff：只保留本实例本轮登记过的路径。
 *
 * 未登记任何路径（如纯 bash 写入、外部进程改动）时返回空——这类变更无法证伪是否
 * 属于本会话，共享工作区下宁可漏报也不串台。
 */
export function filterOwnFileChanges(
  instanceId: string,
  changes: readonly FileChangeEntry[],
): FileChangeEntry[] {
  const own = touchedByInstance.get(instanceId)
  if (!own || own.size === 0) return []
  return changes.filter((entry) => own.has(entry.path))
}
