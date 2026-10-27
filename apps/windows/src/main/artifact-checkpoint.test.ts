// @vitest-environment node
/**
 * 「恢复到这一轮」（P2 T7）：计划构建（纯函数）+ 应用/撤销（真文件系统 + 审计）。
 * 真 git 的 revertFile / lastCommitForPath 在 vcs-repo.test.ts 里单独验。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { FileChangeEntry } from '@mtbot/agent-runtime'
import type { LocalArtifactEdit } from '../shared/artifact-edit-types'
import type { PinEntryInfo } from '../shared/artifact-pin-types'
import {
  applyCheckpoint,
  buildCheckpointPlan,
  readCheckpointAudit,
  undoCheckpoint,
  type CheckpointTurn,
} from './artifact-checkpoint'

let base = ''
let root = ''

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-checkpoint-'))
  root = path.join(base, 'ws')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

function change(filePath: string, status: FileChangeEntry['status']): FileChangeEntry {
  return { path: filePath, status, confidence: 'exact' }
}

const TURNS: CheckpointTurn[] = [
  {
    messageId: 't1',
    timestamp: '2026-10-27T10:00:00.000Z',
    changes: [change('outputs/a/doc.md', 'added'), change('outputs/a/deck.pptx', 'added')],
  },
  {
    messageId: 't2',
    timestamp: '2026-10-27T10:01:00.000Z',
    changes: [
      change('outputs/a/doc.md', 'modified'),
      change('outputs/a/new.md', 'added'),
      change('outputs/a/deck.pptx', 'modified'),
    ],
  },
]

function localEdit(overrides: Partial<LocalArtifactEdit> = {}): LocalArtifactEdit {
  return {
    editId: 'edit-1',
    sessionKey: 'conv-1',
    path: 'outputs/a/doc.md',
    action: 'manual',
    scope: { type: 'file' },
    at: Date.parse('2026-10-27T10:00:30.000Z'),
    bytes: 10,
    ...overrides,
  }
}

function pin(overrides: Partial<PinEntryInfo> = {}): PinEntryInfo {
  return {
    pinId: 'pin-1',
    sessionKey: 'conv-1',
    path: 'outputs/a/deck.pptx',
    versionId: 'turn:t1',
    bytes: 10,
    at: Date.parse('2026-10-27T10:00:10.000Z'),
    ...overrides,
  }
}

function planOf(overrides: Partial<Parameters<typeof buildCheckpointPlan>[0]> = {}) {
  return buildCheckpointPlan({
    turns: TURNS,
    localEdits: [],
    turnId: 't1',
    sessionKey: 'conv-1',
    textCommitOid: 'oid-1',
    pins: [],
    canRestoreConversation: true,
    ...overrides,
  })
}

describe('buildCheckpointPlan', () => {
  it('锚点后新增 → 回收站；文本改/删 → 回退快照', () => {
    const result = planOf()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const byPath = new Map(result.plan.files.map((file) => [file.path, file]))
    expect(byPath.get('outputs/a/new.md')).toMatchObject({ action: 'trash', firstStatus: 'added' })
    expect(byPath.get('outputs/a/doc.md')).toMatchObject({ action: 'restore', content: 'git' })
    // 二进制只有 fileChanges、没有副本 → skip 并说明
    expect(byPath.get('outputs/a/deck.pptx')).toMatchObject({ action: 'skip' })
    expect(byPath.get('outputs/a/deck.pptx')?.reason).toContain('二进制')
    expect(result.plan.textCommitOid).toBe('oid-1')
  })

  it('没有文本快照：文本全部 skip，新增仍进回收站', () => {
    const result = planOf({ textCommitOid: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const doc = result.plan.files.find((file) => file.path === 'outputs/a/doc.md')
    expect(doc).toMatchObject({ action: 'skip', reason: '没有可用的文本快照' })
    expect(result.plan.warnings?.[0]).toContain('没有可用的文本快照')
  })

  it('其它会话在锚点后改过 → skip；本会话 local 编辑过则仍恢复', () => {
    const lastCommitByPath = new Map([
      ['outputs/a/doc.md', { oid: 'oid-later', conversationId: 'conv-other' }],
    ])
    const blocked = planOf({ lastCommitByPath })
    expect(blocked.ok).toBe(true)
    if (blocked.ok) {
      expect(blocked.plan.files.find((file) => file.path === 'outputs/a/doc.md')).toMatchObject({
        action: 'skip',
        reason: '其它会话在之后修改过该文件',
      })
    }
    const allowed = planOf({ lastCommitByPath, localEdits: [localEdit()] })
    expect(allowed.ok).toBe(true)
    if (allowed.ok) {
      expect(allowed.plan.files.find((file) => file.path === 'outputs/a/doc.md')).toMatchObject({
        action: 'restore',
        content: 'git',
      })
    }
  })

  it('二进制：锚点版本有固化副本 → 用副本恢复', () => {
    const result = planOf({ pins: [pin({ versionId: 'turn:t1' })] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.files.find((file) => file.path === 'outputs/a/deck.pptx')).toMatchObject({
      action: 'restore',
      content: 'pin',
      pinId: 'pin-1',
    })
  })

  it('二进制：锚点后有本地编辑 → 用该编辑的 before 恢复', () => {
    const result = planOf({
      localEdits: [localEdit({ path: 'outputs/a/deck.pptx', editId: 'edit-deck' })],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.files.find((file) => file.path === 'outputs/a/deck.pptx')).toMatchObject({
      action: 'restore',
      content: 'store',
      editId: 'edit-deck',
    })
  })

  it('二进制：归属其它会话 → skip', () => {
    const result = planOf({
      ownerByPath: new Map([['outputs/a/deck.pptx', 'conv-other']]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.files.find((file) => file.path === 'outputs/a/deck.pptx')).toMatchObject({
      action: 'skip',
      reason: '其它会话在之后修改过该文件',
    })
  })

  it('只有本地编辑、没有 fileChanges：文本用 before 恢复，变体进回收站', () => {
    const result = planOf({
      localEdits: [
        localEdit({ path: 'notes/local.md', editId: 'edit-text' }),
        localEdit({
          path: 'outputs/a/cover-variant-1.png',
          editId: 'edit-v',
          action: 'variant',
          scope: { type: 'image-variant' },
          derivedFrom: 'outputs/a/cover.png',
        }),
        // 锚点之前的编辑不算
        localEdit({ path: 'notes/old.md', editId: 'edit-old', at: Date.parse('2026-10-27T09:00:00.000Z') }),
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.files.find((file) => file.path === 'notes/local.md')).toMatchObject({
      action: 'restore',
      content: 'store',
      editId: 'edit-text',
    })
    expect(
      result.plan.files.find((file) => file.path === 'outputs/a/cover-variant-1.png'),
    ).toMatchObject({ action: 'trash' })
    expect(result.plan.files.some((file) => file.path === 'notes/old.md')).toBe(false)
  })

  it('快照合并时给近似警告；找不到锚点报 not-found', () => {
    const approx = planOf({ approximate: true })
    expect(approx.ok).toBe(true)
    if (approx.ok) expect(approx.plan.warnings?.join(' ')).toContain('没有精确快照')

    expect(planOf({ turnId: 'nope' })).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('applyCheckpoint / undoCheckpoint', () => {
  async function writeAt(rel: string, content: string | Buffer): Promise<void> {
    const abs = path.join(root, ...rel.split('/'))
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }

  async function readAt(rel: string): Promise<string> {
    return readFile(path.join(root, ...rel.split('/')), 'utf8')
  }

  function deps(overrides: Record<string, unknown> = {}) {
    const commits: string[] = []
    const reverted: string[] = []
    return {
      commits,
      reverted,
      vcs: {
        commit: vi.fn(async (message: string) => {
          commits.push(message)
          return { oid: message.startsWith('恢复前') ? 'backup-oid' : 'after-oid' }
        }),
        revertFile: vi.fn(async (_oid: string, filePath: string) => {
          reverted.push(filePath)
          await writeAt(filePath, 'RESTORED-FROM-GIT')
          return { reverted: true }
        }),
      },
      readEditBytes: vi.fn(async (editId: string) =>
        editId === 'edit-text'
          ? Buffer.from('LOCAL-BEFORE')
          : editId === 'edit-deck'
            ? Buffer.from('DECK-BEFORE')
            : null,
      ),
      readTurnStoreBytes: vi.fn(async (messageId: string, filePath: string) =>
        messageId === 't1' && filePath === 'outputs/a/doc.md'
          ? Buffer.from('STORE-BYTES')
          : null,
      ),
      readPinBytes: vi.fn(async (pinId: string) =>
        pinId === 'pin-1' ? Buffer.from('PIN-BYTES') : null,
      ),
      writeFile: vi.fn(async (filePath: string, bytes: Buffer) => writeAt(filePath, bytes)),
      trash: vi.fn(async (paths: readonly string[]) => {
        for (const rel of paths) await rm(path.join(root, ...rel.split('/')), { force: true })
        return { ok: true, removed: paths.length, trashId: 'batch-1' }
      }),
      forkConversation: vi.fn(async () => ({ ok: true, sessionKey: 'branch-1' })),
      ...overrides,
    } as never as {
      vcs: {
        commit: ReturnType<typeof vi.fn>
        revertFile: ReturnType<typeof vi.fn>
      }
      readEditBytes: ReturnType<typeof vi.fn>
      readTurnStoreBytes: ReturnType<typeof vi.fn>
      readPinBytes: ReturnType<typeof vi.fn>
      writeFile: ReturnType<typeof vi.fn>
      trash: ReturnType<typeof vi.fn>
      forkConversation: ReturnType<typeof vi.fn>
      commits: string[]
      reverted: string[]
    }
  }

  it('应用：文本回退/新增进回收站/本地副本覆盖/分支；审计 done', async () => {
    await writeAt('outputs/a/doc.md', 'CURRENT')
    await writeAt('outputs/a/new.md', 'NEW-FILE')
    await writeAt('outputs/a/deck.pptx', 'CURRENT-DECK')
    const planned = planOf({
      localEdits: [
        localEdit({ path: 'outputs/a/deck.pptx', editId: 'edit-deck' }),
        localEdit({ path: 'notes/local.md', editId: 'edit-text' }),
      ],
    })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    await writeAt('notes/local.md', 'CURRENT-LOCAL')

    const fake = deps()
    const result = await applyCheckpoint({
      workspaceDir: root,
      sessionKey: 'conv-1',
      turnId: 't1',
      plan: planned.plan,
      restoreConversation: true,
      deps: fake,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.restored).toBe(3) // doc + deck + notes/local
    expect(result.trashed).toBe(1) // new.md
    expect(result.newSessionKey).toBe('branch-1')
    expect(fake.commits[0]).toBe('恢复前自动备份')
    expect(fake.commits.at(-1)).toContain('已恢复到')
    expect(fake.forkConversation).toHaveBeenCalledWith('t1')
    expect(await readAt('outputs/a/doc.md')).toBe('RESTORED-FROM-GIT')
    expect(await readAt('outputs/a/deck.pptx')).toBe('DECK-BEFORE')
    expect(await readAt('notes/local.md')).toBe('LOCAL-BEFORE')

    const audit = await readCheckpointAudit(root, result.checkpointId)
    expect(audit?.status).toBe('done')
    expect(audit?.backupOid).toBe('backup-oid')
    expect(audit?.trashBatchIds).toEqual(['batch-1'])
    expect(audit?.trashedPaths).toEqual(['outputs/a/new.md'])
    expect(audit?.newSessionKey).toBe('branch-1')
  })

  it('不勾选分支时不调用 fork', async () => {
    const planned = planOf({ textCommitOid: null })
    if (!planned.ok) return
    const fake = deps()
    const result = await applyCheckpoint({
      workspaceDir: root,
      sessionKey: 'conv-1',
      turnId: 't1',
      plan: planned.plan,
      restoreConversation: false,
      deps: fake,
    })
    expect(result.ok).toBe(true)
    expect(fake.forkConversation).not.toHaveBeenCalled()
  })

  it('中途异常：审计记 failed，可读错误返回', async () => {
    const planned = planOf()
    if (!planned.ok) return
    const fake = deps({
      forkConversation: vi.fn(async () => {
        throw new Error('fork 炸了')
      }),
    })
    const result = await applyCheckpoint({
      workspaceDir: root,
      sessionKey: 'conv-1',
      turnId: 't1',
      plan: planned.plan,
      restoreConversation: true,
      deps: fake,
    })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    const audits = await import('node:fs/promises').then((fs) =>
      fs.readdir(path.join(root, '.lumii', 'checkpoints')),
    )
    expect(audits).toHaveLength(1)
    const audit = await readCheckpointAudit(root, path.basename(audits[0]!, '.json'))
    expect(audit?.status).toBe('failed')
    expect(audit?.error).toContain('fork')
  })

  it('撤销：按备份 oid 回退 + 回收站批次放回，审计变 undone', async () => {
    await writeAt('outputs/a/doc.md', 'CURRENT')
    await writeAt('outputs/a/new.md', 'NEW-FILE')
    const planned = planOf()
    if (!planned.ok) return
    const fake = deps()
    const applied = await applyCheckpoint({
      workspaceDir: root,
      sessionKey: 'conv-1',
      turnId: 't1',
      plan: planned.plan,
      restoreConversation: false,
      deps: fake,
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return

    const revertFile = vi.fn(async (_oid: string, filePath: string) => {
      await writeAt(filePath, 'BEFORE-CHECKPOINT')
      return { reverted: true }
    })
    const restoreTrash = vi.fn(async (batchId: string) => {
      expect(batchId).toBe('batch-1')
      await writeAt('outputs/a/new.md', 'NEW-FILE')
      return { ok: true, restored: 1, conflicts: 0 }
    })
    const undone = await undoCheckpoint({
      workspaceDir: root,
      checkpointId: applied.checkpointId,
      deps: { vcs: { revertFile }, restoreTrash },
    })
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(revertFile).toHaveBeenCalledWith('backup-oid', 'outputs/a/doc.md')
    expect(restoreTrash).toHaveBeenCalledWith('batch-1')
    expect(undone.restored).toBe(1)
    expect(undone.restoredFromTrash).toBe(1)
    expect(await readAt('outputs/a/new.md')).toBe('NEW-FILE')

    const audit = await readCheckpointAudit(root, applied.checkpointId)
    expect(audit?.status).toBe('undone')

    // 同一个恢复记录不能撤销两次
    expect(
      await undoCheckpoint({
        workspaceDir: root,
        checkpointId: applied.checkpointId,
        deps: { vcs: { revertFile }, restoreTrash },
      }),
    ).toMatchObject({ ok: false, code: 'invalid-scope' })
  })

  it('没有备份点时撤销文本给可读警告，但回收站照常放回', async () => {
    // 手工造一条 done 审计：backupOid=null
    await mkdir(path.join(root, '.lumii', 'checkpoints'), { recursive: true })
    const id = 'cp-manual'
    await writeFile(
      path.join(root, '.lumii', 'checkpoints', `${id}.json`),
      JSON.stringify({
        checkpointId: id,
        sessionKey: 'conv-1',
        turnId: 't1',
        at: Date.now(),
        status: 'done',
        backupOid: null,
        trashBatchIds: ['batch-9'],
        restoredPaths: ['outputs/a/doc.md'],
      }),
    )
    const restoreTrash = vi.fn(async () => ({ ok: true, restored: 2, conflicts: 0 }))
    const result = await undoCheckpoint({
      workspaceDir: root,
      checkpointId: id,
      deps: { vcs: null, restoreTrash },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings?.join(' ')).toContain('没有备份点')
    expect(result.restoredFromTrash).toBe(2)
  })
})

describe('buildCheckpointPlan · 精确文本副本优先（T7 真机教训）', () => {
  it('锚点轮留了精确副本 → 用 store 恢复（不看快照是否含该文件）', () => {
    const result = planOf({
      anchorStoreByPath: new Map([['outputs/a/doc.md', 't1']]),
      gitHasPathByPath: new Map([['outputs/a/doc.md', false]]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.files.find((file) => file.path === 'outputs/a/doc.md')).toMatchObject({
      action: 'restore',
      content: 'store',
      storeMessageId: 't1',
    })
  })

  it('没有精确副本且快照里没有该文件 → skip（revertFile 会删文件，不能当恢复）', () => {
    const result = planOf({
      anchorStoreByPath: new Map([['outputs/a/doc.md', null]]),
      gitHasPathByPath: new Map([['outputs/a/doc.md', false]]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.files.find((file) => file.path === 'outputs/a/doc.md')).toMatchObject({
      action: 'skip',
      reason: '这一轮的快照里没有这个文件（快照可能早于写入），无法恢复',
    })
  })
})

describe('applyCheckpoint · 文本用 agent:end 精确副本恢复', () => {
  it('storeMessageId 生效：写回的是该轮副本内容', async () => {
    const abs = path.join(root, 'outputs/a/doc.md')
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, 'CURRENT')
    const planned = buildCheckpointPlan({
      turns: TURNS,
      localEdits: [],
      turnId: 't1',
      sessionKey: 'conv-1',
      textCommitOid: 'oid-1',
      pins: [],
      canRestoreConversation: false,
      anchorStoreByPath: new Map([['outputs/a/doc.md', 't1']]),
      gitHasPathByPath: new Map([['outputs/a/doc.md', false]]),
    })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const readTurnStoreBytes = vi.fn(async () => Buffer.from('STORE-BYTES'))
    const result = await applyCheckpoint({
      workspaceDir: root,
      sessionKey: 'conv-1',
      turnId: 't1',
      plan: planned.plan,
      restoreConversation: false,
      deps: {
        vcs: {
          commit: vi.fn(async () => ({ oid: 'backup-store' })),
          revertFile: vi.fn(async () => ({ reverted: true })),
        },
        readEditBytes: vi.fn(async () => null),
        readTurnStoreBytes,
        readPinBytes: vi.fn(async () => null),
        writeFile: async (filePath, bytes) => {
          const target = path.join(root, ...filePath.split('/'))
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, bytes)
        },
        trash: vi.fn(async () => ({ ok: true, removed: 0 })),
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.restored).toBe(1)
    expect(readTurnStoreBytes).toHaveBeenCalledWith('t1', 'outputs/a/doc.md')
    expect(await readFile(abs, 'utf8')).toBe('STORE-BYTES')
    // store 恢复也覆盖文件：必须先有备份点，撤销才有依据
    expect(result.backupOid).toBe('backup-store')
  })
})
