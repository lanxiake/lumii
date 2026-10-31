/**
 * 回合内文件写入归属跟踪
 *
 * 文件变更卡片本可由「回合开始/结束的全工作区快照 diff」得出，但所有会话共用同一个
 * workspace cwd，diff 会把并发会话 / 后台任务写的文件也算进当前回合（串台）。
 * 因此卡片只保留**本会话能佐证**的路径：
 *
 * - exact：本实例本轮真正写过的路径——写文件工具登记的，加会产出工作区文件的工具
 *   （生图 / 语音 / 截图等）从结果里登记的；
 * - 命令型工具（bash / 技能）：命令文本或输出里出现过路径（或所在目录）时同样标 exact，
 *   并记下来源工具；
 * - diff 里没有任何「本会话证据」的路径直接丢弃——其他会话、后台进程的改动不再进入卡片。
 *
 * 存在性判定不再只依赖 diff：被快照忽略的路径（uploads/ 下的图片、projects/ 等）
 * 用本实例登记 + 文件系统 stat / 写入前存在性 合成，避免「工具明明写成功了但卡片没有」。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { FileChangeEntry } from '@mtbot/agent-runtime'

/** 单路径的本轮登记信息 */
interface TouchRecord {
  /** 产出该路径的工具名（诊断用） */
  sourceTool?: string
  /** 工具执行前该路径是否已存在（区分 added / modified / deleted） */
  preExists?: boolean
}

/** instanceId → 本轮已写路径（相对 cwd 的 posix 路径） */
const touchedByInstance = new Map<string, Map<string, TouchRecord>>()

/** instanceId → 写目标在工具执行前的存在性（tool:start 抓取，保留最早值） */
const preExistsByInstance = new Map<string, Map<string, boolean>>()

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

/**
 * 命令型工具：入参/输出里的路径可以作为本会话产物的证据。
 *
 * 只收这类工具，避免「本会话只是 file_read / list_dir 看了某个文件」被误判成写过它。
 * 技能可能内部跑脚本并写盘，所以一并收。
 */
const EVIDENCE_TOOL_NAMES = new Set(['bash', 'execute_skill', 'skill_invoke'])

/** 工具调用留下的归属证据（命令文本 + 输出） */
export interface TurnToolEvidence {
  toolName: string
  text: string
}

function stringifyEvidence(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** 从命令型工具调用里收集证据；其他工具返回 undefined */
export function collectToolEvidence(
  toolName: string,
  args: unknown,
  result: unknown,
): TurnToolEvidence | undefined {
  if (!EVIDENCE_TOOL_NAMES.has(toolName)) return undefined
  const text = [stringifyEvidence(args), stringifyEvidence(result)].filter(Boolean).join('\n')
  return text ? { toolName, text } : undefined
}

/** 证据文本归一化：统一分隔符、折叠重复斜杠、忽略大小写 */
function normalizeEvidenceText(text: string): string {
  return text.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
}

/** 路径 token 的右边界：字母/数字/点/横线继续算同一段，其他字符视为分隔 */
function isPathChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9._\-一-鿿]/i.test(ch)
}

/**
 * 证据文本里是否作为一个完整路径 token 出现。
 *
 * 两侧边界都校验：避免 `outputs/a.txt` 命中 `outputs/a.txt.bak` /
 * `backupoutputs/a.txt`，`uploads/ep01` 命中 `uploads/ep01-extra`；
 * `/` 不是路径字符，所以绝对路径里的目录前缀仍能命中。
 */
function containsPathToken(text: string, token: string): boolean {
  let index = text.indexOf(token)
  while (index >= 0) {
    const before = index === 0 ? undefined : text[index - 1]
    const after = text[index + token.length]
    if (!isPathChar(before) && !isPathChar(after)) return true
    index = text.indexOf(token, index + 1)
  }
  return false
}

/**
 * 在证据里找某个 diff 路径的出处。
 *
 * 先匹配完整路径，再匹配所在目录（命令点名 `outputs/ep01` 时，目录下整批产物都算）；
 * 目录至少要有一个分隔符，避免 `a/` 这种短前缀把无关文件全吸进来。
 */
function findEvidenceTool(
  relPath: string,
  evidence: readonly { toolName: string; text: string }[],
): string | undefined {
  const normalizedPath = normalizeEvidenceText(relPath)
  const slash = relPath.lastIndexOf('/')
  const normalizedDir = slash > 0 ? normalizeEvidenceText(relPath.slice(0, slash)) : ''
  const dirMatchable = normalizedDir.length >= 3 && normalizedDir.includes('/')
  for (const entry of evidence) {
    if (containsPathToken(entry.text, normalizedPath)) return entry.toolName
    if (dirMatchable && containsPathToken(entry.text, normalizedDir)) return entry.toolName
  }
  return undefined
}

/** 与 workspace-turn-snapshot.ts 保持一致（超过此大小用 size+mtime 伪 hash） */
const MAX_HASH_BYTES = 2 * 1024 * 1024

/** 绝对或相对路径统一为相对 cwd 的 posix 路径；越出 cwd 时返回 null */
function toWorkspaceRelative(filePath: string, cwd: string): string | null {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
  const rel = path.relative(cwd, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

/** 读一个字符串入参；空串视为未提供 */
function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value ? value : undefined
}

/**
 * 按工具语义收集**真正会变动的路径**。
 *
 * 不能笼统收 `source`：file_copy 的 source 只读不写，收进来会在 stat 合成阶段
 * 变成一条假的「修改」。file_move 的 source 会消失，必须保留（用于 deleted）。
 * file_mkdir 产出的目录不进文件变更（目录内文件由后续写工具各自登记）。
 */
function collectWritePaths(toolName: string, args: Record<string, unknown>): string[] {
  const one = (key: string): string[] => {
    const value = stringArg(args, key)
    return value ? [value] : []
  }

  switch (toolName) {
    case 'file_write':
    case 'file_edit':
    case 'writeLocalFile':
      // filePath 是现行参数名；path 兼容旧命名
      return [...one('filePath'), ...one('path')]
    case 'file_move':
      return [...one('source'), ...one('destination')]
    case 'file_copy':
      return one('destination')
    default:
      return []
  }
}

/** 从工具结果里收集产出文件路径；非产文件工具或无路径时返回空数组 */
export function collectResultTouchedPaths(toolName: string, result: unknown): string[] {
  if (!result || typeof result !== 'object') return []
  const rec = result as Record<string, unknown>
  const details =
    rec['details'] && typeof rec['details'] === 'object'
      ? (rec['details'] as Record<string, unknown>)
      : undefined
  const out = new Set<string>()

  // 产物声明优先：任何工具都可以通过 details.artifacts 声明自己写了哪些工作区文件
  const declared = details?.['artifacts']
  if (Array.isArray(declared)) {
    for (const item of declared) {
      if (!item || typeof item !== 'object') continue
      const path = (item as Record<string, unknown>).path
      if (typeof path === 'string' && path) out.add(path)
    }
  }

  if (RESULT_FILE_PATH_TOOLS.has(toolName)) {
    for (const key of RESULT_PATH_KEYS) {
      for (const src of [rec, details]) {
        const value = src?.[key]
        if (typeof value === 'string' && value) out.add(value)
      }
    }
  }
  return [...out]
}

/**
 * 工具开始执行前抓取写目标的存在性。
 *
 * 必须在 tool:start 调用（此时文件还没被写）。同一路径一轮内多次写入时保留最早值，
 * 这样后续 tool:end 登记时能正确区分「新增」与「修改」。
 */
export function recordTurnPreState(
  instanceId: string,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): void {
  const paths = collectWritePaths(toolName, args)
  if (paths.length === 0) return

  let map = preExistsByInstance.get(instanceId)
  for (const filePath of paths) {
    const rel = toWorkspaceRelative(filePath, cwd)
    if (!rel) continue
    if (!map) {
      map = new Map()
      preExistsByInstance.set(instanceId, map)
    }
    if (map.has(rel)) continue
    let exists = false
    try {
      exists = fs.statSync(path.resolve(cwd, rel)).isFile()
    } catch {
      exists = false
    }
    map.set(rel, exists)
  }
}

/** 记录某实例本轮写过的文件；args 来自 file_write / file_edit / file_move / file_copy 等 */
export function recordTurnTouchedPath(
  instanceId: string,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): void {
  const paths = collectWritePaths(toolName, args)
  if (paths.length === 0) return

  const pre = preExistsByInstance.get(instanceId)
  let map = touchedByInstance.get(instanceId)
  for (const filePath of paths) {
    const rel = toWorkspaceRelative(filePath, cwd)
    if (!rel) continue
    if (!map) {
      map = new Map()
      touchedByInstance.set(instanceId, map)
    }
    const existing = map.get(rel)
    if (existing) {
      // 同一路径多次写入：保留最早的 preExists / sourceTool
      if (existing.preExists === undefined && pre?.has(rel)) {
        existing.preExists = pre.get(rel)
      }
      continue
    }
    map.set(rel, {
      ...(toolName ? { sourceTool: toolName } : {}),
      ...(pre?.has(rel) ? { preExists: pre.get(rel) } : {}),
    })
  }
}

/** 记录某实例产出的单个文件路径（供工具结果 / 直连生图等非写文件工具调用） */
export function recordTurnTouchedFilePath(
  instanceId: string,
  filePath: string,
  cwd: string,
  sourceTool?: string,
): void {
  const rel = toWorkspaceRelative(filePath, cwd)
  if (!rel) return

  let map = touchedByInstance.get(instanceId)
  if (!map) {
    map = new Map()
    touchedByInstance.set(instanceId, map)
  }
  if (map.has(rel)) return
  map.set(rel, sourceTool ? { sourceTool } : {})
}

/**
 * 仅登记「写入前不存在、现在已落盘」的写目标。
 *
 * 失败 / 中断路径用这个，避免把未改动的旧文件记成 `modified`
 * （尤其是快照忽略的 uploads/ 等目录，resolve 无法靠 hash 否定）。
 */
export function recordNewlyCreatedWriteTargets(
  instanceId: string,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): void {
  const paths = collectWritePaths(toolName, args)
  if (paths.length === 0) return
  const pre = preExistsByInstance.get(instanceId)
  for (const filePath of paths) {
    const rel = toWorkspaceRelative(filePath, cwd)
    if (!rel) continue
    if (pre?.get(rel) === true) continue
    try {
      if (!fs.statSync(path.resolve(cwd, rel)).isFile()) continue
    } catch {
      continue
    }
    recordTurnTouchedFilePath(instanceId, rel, cwd, toolName)
  }
}

/**
 * 从本轮工具 part 补登写入路径（abort 收尾用）。
 *
 * 用户中断时工具常来不及发成功的 `tool:end`，但入参写目标 / 结果里的 artifacts
 * 可能已经落盘。不补登则 `resolveTurnFileChanges` 会丢掉这些路径，
 * 「只看产出」台账表现为空。
 *
 * - `done`：完整登记（与成功 tool:end 幂等）
 * - `running` / `interrupted` / `error`：只收新落盘文件 + 结果声明，避免假 modified
 */
export function harvestTurnTouchedFromParts(
  instanceId: string,
  parts: readonly {
    type: string
    name?: string
    args?: unknown
    result?: unknown
    status?: string
  }[],
  cwd: string,
): void {
  for (const part of parts) {
    if (part.type !== 'tool' || !part.name) continue
    const args =
      part.args && typeof part.args === 'object' && !Array.isArray(part.args)
        ? (part.args as Record<string, unknown>)
        : {}
    if (part.status === 'done') {
      recordTurnTouchedPath(instanceId, part.name, args, cwd)
    } else {
      recordNewlyCreatedWriteTargets(instanceId, part.name, args, cwd)
    }
    for (const outputPath of collectResultTouchedPaths(part.name, part.result)) {
      recordTurnTouchedFilePath(instanceId, outputPath, cwd, part.name)
    }
  }
}

/** 回合开始与实例销毁时清空归属记录 */
export function clearTurnTouchedPaths(instanceId: string): void {
  touchedByInstance.delete(instanceId)
  preExistsByInstance.delete(instanceId)
}

/**
 * 为**不经过用户消息入口**的独立回合建立归属起点。
 *
 * 后台任务完成唤醒、子 Agent 完成投递都会在实例 idle 时直接
 * `AgentInstance.prompt(..., 'internal')`，绕过 BridgePromptDispatcher 的开轮逻辑。
 * 不补这两步会出两类错：
 * - 上一轮登记的路径仍在表里 → 本回合被 stat 合成成「新增/修改」，变更卡片重复；
 * - 没有起点快照 → 跳过 diff，命令型工具的文本证据无从匹配，异步产物继续漏。
 *
 * `capture` 由宿主注入（生产用 captureWorkspaceTurnSnapshot，测试可给桩）。
 */
export async function beginStandaloneTurn(
  instanceId: string,
  state: { turnSnapshotStart?: Map<string, string> } | undefined,
  capture: () => Promise<Map<string, string>>,
): Promise<void> {
  if (!state) return
  clearTurnTouchedPaths(instanceId)
  try {
    state.turnSnapshotStart = await capture()
  } catch {
    state.turnSnapshotStart = undefined
  }
}

/** 与 workspace-turn-snapshot.ts 的 hashFile/pseudoHash 保持同一算法 */
async function hashLikeSnapshot(absPath: string, stat: fs.Stats): Promise<string> {
  if (stat.size > MAX_HASH_BYTES) {
    return createHash('sha256')
      .update(`size:${stat.size}:mtime:${stat.mtimeMs}`)
      .digest('hex')
  }
  return createHash('sha256').update(await fs.promises.readFile(absPath)).digest('hex')
}

const STATUS_ORDER: Record<FileChangeEntry['status'], number> = {
  added: 0,
  modified: 1,
  deleted: 2,
}

function sortChanges(entries: FileChangeEntry[]): FileChangeEntry[] {
  return entries.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.path.localeCompare(b.path),
  )
}

interface ResolveTurnFileChangesOptions {
  /**
   * 回合开始快照。用于判断「路径本来就在跟踪范围内」：
   * 在起点里、diff 又没报 → 内容没变，跳过。
   */
  snapshotStart?: ReadonlyMap<string, string>
  /**
   * 回合结束快照是否成功。成功时 diff 是权威的（没报就是没变）；
   * 失败时 diff 为空，需要读文件与起点 hash 比对，避免把未变化的路径误报成修改。
   */
  diffAuthoritative?: boolean
  /** 命令型工具（bash / 技能）的入参与输出，用于佐证 diff 里的路径属于本会话 */
  evidence?: readonly TurnToolEvidence[]
}

/**
 * 合并「本实例登记」与「工作区 diff」，只返回本会话能佐证的净变更。
 *
 * - 登记路径在 diff 里 → 直接用 diff 的状态（exact）；
 * - 登记路径不在 diff、但起点快照里没有它（被快照忽略：uploads/、projects/ 等）
 *   → stat 合成 added / modified / deleted（exact）；
 * - 起点快照里有、diff 没报 → 未变化，跳过；
 * - diff 里存在但没人登记：命令型工具的命令/输出里点名了该路径或目录 → exact；
 *   否则直接丢弃（并发会话 / 后台进程的改动不属于本会话）。
 */
export async function resolveTurnFileChanges(
  instanceId: string,
  diff: readonly FileChangeEntry[],
  cwd: string,
  options: ResolveTurnFileChangesOptions = {},
): Promise<FileChangeEntry[]> {
  const touched = touchedByInstance.get(instanceId)
  const snapshotStart = options.snapshotStart
  const diffAuthoritative = options.diffAuthoritative === true

  const diffByPath = new Map<string, FileChangeEntry>()
  for (const entry of diff) diffByPath.set(entry.path, entry)

  const owned: FileChangeEntry[] = []
  const ownedPaths = new Set<string>()

  if (touched) {
    for (const [relPath, record] of touched) {
      ownedPaths.add(relPath)
      const inDiff = diffByPath.get(relPath)
      if (inDiff) {
        owned.push({
          ...inDiff,
          confidence: 'exact',
          ...(record.sourceTool ? { sourceTool: record.sourceTool } : {}),
        })
        continue
      }

      const inStartSnapshot = snapshotStart?.has(relPath) === true
      const abs = path.resolve(cwd, relPath)
      let stat: fs.Stats | undefined
      try {
        stat = fs.statSync(abs)
      } catch {
        stat = undefined
      }

      if (inStartSnapshot) {
        // 跟踪范围内的路径：结束快照成功时 diff 没报 = 没变；失败时才需要自己比对。
        if (diffAuthoritative) continue
        if (!stat?.isFile()) {
          // 只在「写入前确实存在」时判删除：cwd 失效等异常也会让 stat 落空，
          // 那种情况下报 deleted 是假变更。
          if (record.preExists === true) {
            owned.push({ path: relPath, status: 'deleted', confidence: 'exact', ...(record.sourceTool ? { sourceTool: record.sourceTool } : {}) })
          }
          continue
        }
        const startHash = snapshotStart?.get(relPath)
        const currentHash = await hashLikeSnapshot(abs, stat)
        if (startHash !== currentHash) {
          owned.push({ path: relPath, status: 'modified', confidence: 'exact', ...(record.sourceTool ? { sourceTool: record.sourceTool } : {}) })
        }
        continue
      }

      // 被快照忽略的路径：diff 看不到，只能靠 stat + 写入前存在性判断状态。
      if (stat?.isFile()) {
        owned.push({
          path: relPath,
          status: record.preExists === true ? 'modified' : 'added',
          confidence: 'exact',
          ...(record.sourceTool ? { sourceTool: record.sourceTool } : {}),
        })
      } else if (record.preExists === true) {
        owned.push({ path: relPath, status: 'deleted', confidence: 'exact', ...(record.sourceTool ? { sourceTool: record.sourceTool } : {}) })
      }
    }
  }

  const evidence = (options.evidence ?? []).map((entry) => ({
    toolName: entry.toolName,
    text: normalizeEvidenceText(entry.text),
  }))
  for (const entry of diff) {
    if (ownedPaths.has(entry.path)) continue
    const sourceTool = findEvidenceTool(entry.path, evidence)
    if (!sourceTool) continue
    owned.push({ ...entry, confidence: 'exact', sourceTool })
  }

  return sortChanges(owned)
}
