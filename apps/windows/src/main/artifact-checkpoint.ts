/**
 * 「恢复到这一轮」checkpoint（P2 T7）
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4.6
 *
 * 只恢复**本会话记录的工作区文件**：
 * - 锚点后新增的文件 → 移入回收站（可恢复）；
 * - 锚点后改/删的文本 → `git revertFile` 回锚点快照；
 * - 锚点后改的二进制 → 只有本地编辑副本或固化副本才覆盖，否则 skip；
 * - 其它会话在锚点之后改过的文件 → skip（共用工作区保护）；
 * - 对话用 fork 分支，原会话保留；不恢复配置/依赖/环境/数据库。
 *
 * 审计 `<ws>/.lumii/checkpoints/<id>.json`：动手前写 `applying`，完成后 `done`；
 * 撤销按备份 oid + 回收站批次还原。
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileChangeEntry } from '@mtbot/agent-runtime'
import type { LocalArtifactEdit } from '../shared/artifact-edit-types'
import type { PinEntryInfo } from '../shared/artifact-pin-types'
import type {
  CheckpointApplyResult,
  CheckpointAuditEntry,
  CheckpointFilePlan,
  CheckpointPlan,
  CheckpointPlanResult,
  CheckpointUndoResult,
} from '../shared/artifact-checkpoint-types'
import type { ArtifactEditFailure } from '../shared/artifact-edit-types'
import { isTextArtifactPath } from '../shared/artifact-rules'
import { resolveTurnOid } from '../shared/turn-index'
import { readTurnIndex } from './artifact-versions'
import { hasTurnTextVersion } from './turn-version-store'

const CHECKPOINT_DIR = '.lumii/checkpoints'

export interface CheckpointTurn {
  messageId: string
  timestamp: string
  changes: readonly FileChangeEntry[]
}

export interface LastCommitInfo {
  oid: string
  conversationId: string | null
}

export interface CheckpointPlanFacts {
  turns: readonly CheckpointTurn[]
  localEdits: readonly LocalArtifactEdit[]
  turnId: string
  sessionKey: string
  textCommitOid: string | null
  approximate?: boolean
  pins: readonly PinEntryInfo[]
  canRestoreConversation: boolean
  /** 文本：该路径最近一次改动的提交（VCS 停用时为空） */
  lastCommitByPath?: ReadonlyMap<string, LastCommitInfo | null>
  /** 二进制：该路径最近归属会话（client_files） */
  ownerByPath?: ReadonlyMap<string, string | null>
  /** 文本：锚点轮是否留了精确文本副本（messageId；没有为 null） */
  anchorStoreByPath?: ReadonlyMap<string, string | null>
  /** 文本：锚点快照里是否有这个文件（false 时 revertFile 会删文件，不能当恢复用） */
  gitHasPathByPath?: ReadonlyMap<string, boolean>
}

function anchorOf(
  turns: readonly CheckpointTurn[],
  turnId: string,
): { anchor: CheckpointTurn; index: number; sorted: CheckpointTurn[] } | null {
  const sorted = [...turns]
    .filter((turn) => Number.isFinite(Date.parse(turn.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const index = sorted.findIndex((turn) => turn.messageId === turnId)
  if (index < 0) return null
  return { anchor: sorted[index]!, index, sorted }
}

/** 纯函数：从「已查好的事实」构建恢复计划（真机/单测共用） */
export function buildCheckpointPlan(facts: CheckpointPlanFacts): CheckpointPlanResult {
  const found = anchorOf(facts.turns, facts.turnId)
  if (!found) return { ok: false, error: '找不到这一轮（可能已被清理）', code: 'not-found' }
  const anchorTs = Date.parse(found.anchor.timestamp)
  const after = found.sorted.slice(found.index + 1)

  interface Agg {
    firstStatus: CheckpointFilePlan['firstStatus']
    lastStatus: CheckpointFilePlan['lastStatus']
    firstAt: number
  }
  const changed = new Map<string, Agg>()
  for (const turn of after) {
    const at = Date.parse(turn.timestamp)
    for (const change of turn.changes) {
      if (change.confidence === 'unattributed') continue
      const existing = changed.get(change.path)
      if (!existing) {
        changed.set(change.path, { firstStatus: change.status, lastStatus: change.status, firstAt: at })
      } else {
        existing.lastStatus = change.status
      }
    }
  }

  // 锚点之后的本地编辑（工作台改动不一定出现在 fileChanges 里）
  const firstLocalAfterAnchor = new Map<string, LocalArtifactEdit>()
  for (const edit of facts.localEdits) {
    if (edit.at <= anchorTs) continue
    const existing = firstLocalAfterAnchor.get(edit.path)
    if (!existing || edit.at < existing.at) firstLocalAfterAnchor.set(edit.path, edit)
  }

  const pinByVersion = new Map(facts.pins.map((pin) => [pin.versionId, pin]))
  // 锚点版本的 turn 版本 id（二进制备份查找用）：锚点及之前最后一次记录该路径的轮次
  const anchorVersionOf = (filePath: string): string | null => {
    let foundTurnId: string | null = null
    for (const turn of found.sorted.slice(0, found.index + 1)) {
      if (turn.changes.some((change) => change.path === filePath)) foundTurnId = turn.messageId
    }
    return foundTurnId ? `turn:${foundTurnId}` : null
  }

  const files: CheckpointFilePlan[] = []

  for (const [filePath, agg] of changed) {
    const binary = !isTextArtifactPath(filePath)
    const localEdit = firstLocalAfterAnchor.get(filePath)

    if (agg.firstStatus === 'added') {
      files.push({ path: filePath, action: 'trash', firstStatus: 'added', lastStatus: agg.lastStatus, binary })
      continue
    }

    if (binary) {
      const anchorVersion = anchorVersionOf(filePath)
      const pin = anchorVersion ? pinByVersion.get(anchorVersion) : undefined
      if (localEdit && localEdit.action !== 'variant') {
        files.push({
          path: filePath,
          action: 'restore',
          content: 'store',
          editId: localEdit.editId,
          firstStatus: agg.firstStatus,
          lastStatus: agg.lastStatus,
          binary: true,
        })
        continue
      }
      if (pin) {
        files.push({
          path: filePath,
          action: 'restore',
          content: 'pin',
          pinId: pin.pinId,
          firstStatus: agg.firstStatus,
          lastStatus: agg.lastStatus,
          binary: true,
        })
        continue
      }
      const owner = facts.ownerByPath?.get(filePath)
      if (owner && owner !== facts.sessionKey) {
        files.push({
          path: filePath,
          action: 'skip',
          reason: '其它会话在之后修改过该文件',
          firstStatus: agg.firstStatus,
          lastStatus: agg.lastStatus,
          binary: true,
        })
        continue
      }
      files.push({
        path: filePath,
        action: 'skip',
        reason: '二进制旧版没有副本，无法恢复',
        firstStatus: agg.firstStatus,
        lastStatus: agg.lastStatus,
        binary: true,
      })
      continue
    }

    const lastCommit = facts.lastCommitByPath?.get(filePath)
    if (
      lastCommit &&
      lastCommit.oid !== facts.textCommitOid &&
      lastCommit.conversationId &&
      lastCommit.conversationId !== facts.sessionKey &&
      !localEdit
    ) {
      files.push({
        path: filePath,
        action: 'skip',
        reason: '其它会话在之后修改过该文件',
        firstStatus: agg.firstStatus,
        lastStatus: agg.lastStatus,
      })
      continue
    }
    // 优先 agent:end 的精确文本副本：VCS 快照可能早于本轮最后一次写入
    const storeMessageId = facts.anchorStoreByPath?.get(filePath)
    if (storeMessageId) {
      files.push({
        path: filePath,
        action: 'restore',
        content: 'store',
        storeMessageId,
        firstStatus: agg.firstStatus,
        lastStatus: agg.lastStatus,
      })
      continue
    }
    if (!facts.textCommitOid) {
      files.push({
        path: filePath,
        action: 'skip',
        reason: '没有可用的文本快照',
        firstStatus: agg.firstStatus,
        lastStatus: agg.lastStatus,
      })
      continue
    }
    // 快照里没有这个文件时 revertFile 会把它删掉——那不是「恢复」
    if (facts.gitHasPathByPath?.get(filePath) === false) {
      files.push({
        path: filePath,
        action: 'skip',
        reason: '这一轮的快照里没有这个文件（快照可能早于写入），无法恢复',
        firstStatus: agg.firstStatus,
        lastStatus: agg.lastStatus,
      })
      continue
    }
    files.push({
      path: filePath,
      action: 'restore',
      content: 'git',
      firstStatus: agg.firstStatus,
      lastStatus: agg.lastStatus,
    })
  }

  // 只有本地编辑、没有 fileChanges 的路径
  for (const [filePath, edit] of firstLocalAfterAnchor) {
    if (changed.has(filePath)) continue
    if (edit.action === 'variant') {
      files.push({ path: filePath, action: 'trash', firstStatus: 'added', lastStatus: 'edited' })
      continue
    }
    files.push({
      path: filePath,
      action: 'restore',
      content: 'store',
      editId: edit.editId,
      firstStatus: 'edited',
      lastStatus: 'edited',
      binary: !isTextArtifactPath(filePath),
    })
  }

  const order: Record<CheckpointFilePlan['action'], number> = { restore: 0, trash: 1, skip: 2 }
  files.sort((a, b) => order[a.action] - order[b.action] || a.path.localeCompare(b.path))

  const warnings: string[] = []
  if (!facts.textCommitOid) {
    warnings.push('没有可用的文本快照（VCS 未启用，或这一轮之前没有提交）；文本文件不会回退。')
  }
  if (facts.approximate) {
    warnings.push('这一轮没有精确快照：回退到的提交可能更早或包含后续改动，请核对恢复结果。')
  }

  return {
    ok: true,
    plan: {
      anchor: { turnId: found.anchor.messageId, timestamp: anchorTs },
      files,
      textCommitOid: facts.textCommitOid,
      ...(facts.approximate ? { approximate: true } : {}),
      canRestoreConversation: facts.canRestoreConversation,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  }
}

/** 异步包装：查快照 oid / 跨会话归属后构建计划（IPC 与命令层共用） */
export async function planCheckpoint(opts: {
  workspaceDir: string
  sessionKey: string
  turnId: string
  turns: readonly CheckpointTurn[]
  localEdits: readonly LocalArtifactEdit[]
  pins: readonly PinEntryInfo[]
  vcs: {
    lastCommitForPath(path: string): Promise<LastCommitInfo | null>
    readFileAt(oid: string, path: string): Promise<string | null>
  } | null
  /** 某路径最近归属会话（client_files）；查不到返回 null */
  ownerOf: (path: string) => string | null
  canRestoreConversation: boolean
}): Promise<CheckpointPlanResult> {
  const found = anchorOf(opts.turns, opts.turnId)
  if (!found) return { ok: false, error: '找不到这一轮（可能已被清理）', code: 'not-found' }
  const anchorTs = Date.parse(found.anchor.timestamp)

  let textCommitOid: string | null = null
  let approximate = false
  if (opts.vcs) {
    const entries = await readTurnIndex(opts.workspaceDir)
    const resolved = resolveTurnOid(entries, opts.turnId, anchorTs)
    textCommitOid = resolved?.oid ?? null
    // 锚点自己的索引是 null（该轮没产生快照：VCS 跳过/排队失败）时，回退到更早的提交
    // 不等于「状态未变」——恢复时必须标近似，否则会静默给出旧内容。
    const anchorEntry = [...entries].reverse().find((entry) => entry.messageId === opts.turnId)
    approximate = resolved?.approximate === true || (anchorEntry?.oid ?? null) === null
  }

  // 只对「锚点后有改动」的路径查归属：省掉整表扫描
  const changed = new Set<string>()
  for (const turn of found.sorted.slice(found.index + 1)) {
    for (const change of turn.changes) {
      if (change.confidence !== 'unattributed') changed.add(change.path)
    }
  }

  const lastCommitByPath = new Map<string, LastCommitInfo | null>()
  const ownerByPath = new Map<string, string | null>()
  for (const filePath of changed) {
    if (isTextArtifactPath(filePath)) {
      if (opts.vcs) {
        try {
          lastCommitByPath.set(filePath, await opts.vcs.lastCommitForPath(filePath))
        } catch {
          lastCommitByPath.set(filePath, null)
        }
      }
    } else {
      ownerByPath.set(filePath, opts.ownerOf(filePath))
    }
  }

  // 文本：锚点轮的精确副本与快照可用性（快照可能早于最后一次写入）
  const anchorStoreByPath = new Map<string, string | null>()
  const gitHasPathByPath = new Map<string, boolean>()
  for (const filePath of changed) {
    if (!isTextArtifactPath(filePath)) continue
    let anchorMessageId: string | null = null
    for (const turn of found.sorted.slice(0, found.index + 1)) {
      if (turn.changes.some((change) => change.path === filePath)) {
        anchorMessageId = turn.messageId
      }
    }
    let hasStore = false
    if (anchorMessageId) {
      hasStore = await hasTurnTextVersion({
        workspaceDir: opts.workspaceDir,
        messageId: anchorMessageId,
        path: filePath,
      })
    }
    anchorStoreByPath.set(filePath, hasStore ? anchorMessageId : null)

    let gitHas = false
    if (opts.vcs && textCommitOid) {
      try {
        gitHas = (await opts.vcs.readFileAt(textCommitOid, filePath)) !== null
      } catch {
        gitHas = false
      }
    }
    gitHasPathByPath.set(filePath, gitHas)
  }

  return buildCheckpointPlan({
    turns: opts.turns,
    localEdits: opts.localEdits,
    turnId: opts.turnId,
    sessionKey: opts.sessionKey,
    textCommitOid,
    ...(approximate ? { approximate: true } : {}),
    pins: opts.pins,
    canRestoreConversation: opts.canRestoreConversation,
    lastCommitByPath,
    ownerByPath,
    anchorStoreByPath,
    gitHasPathByPath,
  })
}

// ---------------------------------------------------------------------------
// 应用 / 撤销
// ---------------------------------------------------------------------------

export interface CheckpointApplyDeps {
  vcs: {
    commit(message: string, author?: 'user' | 'agent'): Promise<{ oid: string } | null>
    revertFile(oid: string, filepath: string): Promise<{ reverted: boolean }>
  } | null
  /** 读本地编辑 before 字节 */
  readEditBytes(editId: string): Promise<Buffer | null>
  /** 读该轮 agent:end 的精确文本副本 */
  readTurnStoreBytes(messageId: string, filePath: string): Promise<Buffer | null>
  /** 读固化副本字节 */
  readPinBytes(pinId: string, filePath: string): Promise<Buffer | null>
  /** 覆盖写工作区文件（同目录临时文件 + rename） */
  writeFile(filePath: string, bytes: Buffer): Promise<void>
  trash(paths: readonly string[]): Promise<{ ok: boolean; removed: number; trashId?: string; error?: string }>
  forkConversation?: (uptoMessageId: string) => Promise<{
    ok: boolean
    sessionKey?: string
    error?: string
  }>
  now?: () => number
}

function auditFile(workspaceDir: string, id: string): string {
  return path.join(workspaceDir, ...CHECKPOINT_DIR.split('/'), `${id}.json`)
}

async function writeAudit(workspaceDir: string, entry: CheckpointAuditEntry): Promise<void> {
  const file = auditFile(workspaceDir, entry.checkpointId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(entry), 'utf8')
  await fs.rename(tmp, file)
}

export async function readCheckpointAudit(
  workspaceDir: string,
  checkpointId: string,
): Promise<CheckpointAuditEntry | null> {
  try {
    const raw = await fs.readFile(auditFile(workspaceDir, checkpointId), 'utf8')
    const parsed = JSON.parse(raw) as CheckpointAuditEntry
    return parsed && typeof parsed.checkpointId === 'string' ? parsed : null
  } catch {
    return null
  }
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 覆盖写工作区文件（同目录临时文件 + rename）；路径必须在工作区内 */
export async function writeWorkspaceFileAtomic(
  workspaceDir: string,
  relPath: string,
  bytes: Buffer,
): Promise<void> {
  const root = await fs.realpath(path.resolve(workspaceDir))
  const rel = relPath.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) {
    throw new Error(`路径非法：${relPath}`)
  }
  const abs = path.join(root, ...rel.split('/'))
  if (!inside(root, abs)) throw new Error(`路径越界：${relPath}`)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.lumii-checkpoint-${randomBytes(4).toString('hex')}.tmp`,
  )
  await fs.writeFile(tmp, bytes)
  try {
    await fs.rename(tmp, abs)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

export async function applyCheckpoint(opts: {
  workspaceDir: string
  sessionKey: string
  turnId: string
  plan: CheckpointPlan
  restoreConversation: boolean
  deps: CheckpointApplyDeps
}): Promise<CheckpointApplyResult | ArtifactEditFailure> {
  const { plan, deps } = opts
  const now = deps.now ?? Date.now
  const checkpointId = `cp-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  const audit: CheckpointAuditEntry = {
    checkpointId,
    sessionKey: opts.sessionKey,
    turnId: opts.turnId,
    at: now(),
    status: 'applying',
    backupOid: null,
  }
  await writeAudit(opts.workspaceDir, audit)

  const warnings: string[] = []
  const restoredPaths: string[] = []
  const trashedPaths: string[] = []
  const skipped = plan.files
    .filter((file) => file.action === 'skip')
    .map((file) => ({ path: file.path, reason: file.reason ?? '无法恢复' }))
  const trashBatchIds: string[] = []

  try {
    // 1. 备份：只要会覆盖文件就提交一次（store 恢复也是覆盖，撤销要靠它）；
    //    无变更时 commit 返回 null
    if (deps.vcs && plan.files.some((file) => file.action === 'restore')) {
      try {
        const backup = await deps.vcs.commit('恢复前自动备份', 'user')
        audit.backupOid = backup?.oid ?? null
      } catch (err) {
        warnings.push(`备份提交失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 2. 新增文件 → 回收站（可整批撤销）
    const trashTargets = plan.files.filter((file) => file.action === 'trash').map((file) => file.path)
    if (trashTargets.length > 0) {
      let trashError: string | undefined
      try {
        const result = await deps.trash(trashTargets)
        if (result.trashId) trashBatchIds.push(result.trashId)
        if (!result.ok) {
          trashError = result.error ?? '回收站拒绝'
          warnings.push(`移入回收站失败：${trashError}`)
        }
      } catch (err) {
        trashError = err instanceof Error ? err.message : String(err)
        warnings.push(`移入回收站失败：${trashError}`)
      }
      for (const relPath of trashTargets) {
        const stillThere = await exists(path.join(opts.workspaceDir, ...relPath.split('/')))
        if (stillThere) {
          skipped.push({
            path: relPath,
            reason: trashError
              ? `未移入回收站：${trashError}`
              : '仍在工作区（可能被成品引用），未移入回收站',
          })
        } else {
          trashedPaths.push(relPath)
        }
      }
    }

    // 3. 文本/副本恢复
    for (const file of plan.files) {
      if (file.action !== 'restore') continue
      try {
        if (file.content === 'git') {
          if (!deps.vcs || !plan.textCommitOid) {
            skipped.push({ path: file.path, reason: '没有可用的文本快照' })
            continue
          }
          await deps.vcs.revertFile(plan.textCommitOid, file.path)
          restoredPaths.push(file.path)
          continue
        }
        const bytes =
          file.content === 'store'
            ? file.editId
              ? await deps.readEditBytes(file.editId)
              : file.storeMessageId
                ? await deps.readTurnStoreBytes(file.storeMessageId, file.path)
                : null
            : file.content === 'pin' && file.pinId
              ? await deps.readPinBytes(file.pinId, file.path)
              : null
        if (!bytes) {
          skipped.push({ path: file.path, reason: '副本已不在，无法恢复' })
          continue
        }
        await deps.writeFile(file.path, bytes)
        restoredPaths.push(file.path)
      } catch (err) {
        skipped.push({
          path: file.path,
          reason: err instanceof Error ? err.message : '恢复失败',
        })
      }
    }

    // 4. 可选：从此轮分支对话（原会话保留）
    let newSessionKey: string | undefined
    if (opts.restoreConversation && deps.forkConversation) {
      const fork = await deps.forkConversation(opts.turnId)
      if (fork.ok && fork.sessionKey) newSessionKey = fork.sessionKey
      else warnings.push(`分支对话失败：${fork.error ?? '未知原因'}`)
    }

    // 5. 收尾提交（把恢复结果记进历史）
    if (deps.vcs && (restoredPaths.length > 0 || trashedPaths.length > 0)) {
      try {
        await deps.vcs.commit(`已恢复到 ${opts.turnId}`, 'user')
      } catch {
        // 收尾提交失败不影响文件已恢复的事实
      }
    }

    await writeAudit(opts.workspaceDir, {
      ...audit,
      status: 'done',
      trashBatchIds,
      restoredPaths,
      trashedPaths,
      skipped,
      ...(newSessionKey ? { newSessionKey } : {}),
    })

    return {
      ok: true,
      checkpointId,
      restored: restoredPaths.length,
      trashed: trashedPaths.length,
      skipped: skipped.length,
      backupOid: audit.backupOid,
      ...(newSessionKey ? { newSessionKey } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (err) {
    await writeAudit(opts.workspaceDir, {
      ...audit,
      status: 'failed',
      trashBatchIds,
      restoredPaths,
      trashedPaths,
      skipped,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined)
    return { ok: false, error: err instanceof Error ? err.message : '恢复失败' }
  }
}

export async function undoCheckpoint(opts: {
  workspaceDir: string
  checkpointId: string
  deps: {
    vcs: { revertFile(oid: string, filepath: string): Promise<{ reverted: boolean }> } | null
    restoreTrash(batchId: string): Promise<{ ok: boolean; restored: number; conflicts: number; error?: string }>
    now?: () => number
  }
}): Promise<CheckpointUndoResult | ArtifactEditFailure> {
  if (typeof opts.checkpointId !== 'string' || !opts.checkpointId) {
    return { ok: false, error: '恢复记录 id 非法', code: 'invalid-scope' }
  }
  const audit = await readCheckpointAudit(opts.workspaceDir, opts.checkpointId)
  if (!audit) return { ok: false, error: '找不到这次恢复的记录', code: 'not-found' }
  if (audit.status === 'undone') return { ok: false, error: '这次恢复已经撤销过了', code: 'invalid-scope' }

  const warnings: string[] = []
  let restored = 0
  let restoredFromTrash = 0

  const textPaths = audit.restoredPaths ?? []
  if (textPaths.length > 0) {
    if (!opts.deps.vcs || !audit.backupOid) {
      warnings.push('没有备份点，无法把已恢复的文件改回去')
    } else {
      for (const filePath of textPaths) {
        try {
          await opts.deps.vcs.revertFile(audit.backupOid, filePath)
          restored += 1
        } catch (err) {
          warnings.push(`${filePath}：${err instanceof Error ? err.message : '回退失败'}`)
        }
      }
    }
  }

  for (const batchId of audit.trashBatchIds ?? []) {
    try {
      const result = await opts.deps.restoreTrash(batchId)
      if (!result.ok) warnings.push(`回收站批次 ${batchId}：${result.error ?? '恢复失败'}`)
      else {
        restoredFromTrash += result.restored
        if (result.conflicts > 0) {
          warnings.push(`回收站批次 ${batchId}：${result.conflicts} 个冲突已跳过`)
        }
      }
    } catch (err) {
      warnings.push(`回收站批次 ${batchId}：${err instanceof Error ? err.message : '恢复失败'}`)
    }
  }

  await writeAudit(opts.workspaceDir, {
    ...audit,
    status: 'undone',
    ...(warnings.length > 0 ? { error: warnings.join('；') } : {}),
  })

  return {
    ok: true,
    restored,
    restoredFromTrash,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
