// @vitest-environment node
/**
 * 就地修改底座（P2 T1）：候选稿 / baseHash 冲突 / 原子应用 / 撤销 / 索引 / 保留上限。
 * 用真文件系统——这一层的价值全在 IO 行为上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import {
  applyEdit,
  discardEdit,
  getLocalEditContent,
  listEdits,
  proposeFileEdit,
  proposeTextEdit,
  pruneEditStore,
  pruneWorkspaceScratch,
  recordManualSave,
  recordVariantEdit,
  undoEdit,
} from './artifact-edit'

let base = ''
let root = ''

const ORIGINAL = '# Title\n\nHello world\n'
const START = ORIGINAL.indexOf('Hello world')
const END = START + 'Hello world'.length

async function writeAt(rel: string, content: string | Buffer): Promise<string> {
  const abs = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content)
  return abs
}

async function readAt(rel: string): Promise<string> {
  return readFile(path.join(root, ...rel.split('/')), 'utf8')
}

async function exists(rel: string): Promise<boolean> {
  try {
    await access(path.join(root, ...rel.split('/')))
    return true
  } catch {
    return false
  }
}

async function propose(replacement = 'Hello Lumii', sessionKey: string | null = 'conv-1') {
  return proposeTextEdit({
    workspaceDir: root,
    input: {
      path: 'outputs/demo/doc.md',
      start: START,
      end: END,
      replacement,
      sessionKey,
    },
  })
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-edit-'))
  root = path.join(base, 'ws')
  await mkdir(root, { recursive: true })
  await writeAt('outputs/demo/doc.md', ORIGINAL)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('proposeTextEdit', () => {
  it('只写候选稿，不改目标文件；返回可预览的候选路径', async () => {
    const result = await propose()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.changedScope).toEqual({ type: 'text-range', start: START, end: END })
    expect(await readAt('outputs/demo/doc.md')).toBe(ORIGINAL)
    expect(await readAt(result.candidatePath)).toBe('# Title\n\nHello Lumii\n')
    expect(result.beforeBytes).toBe(Buffer.byteLength(ORIGINAL))
    expect(result.afterBytes).toBe(Buffer.byteLength('# Title\n\nHello Lumii\n'))
  })

  it('baseHash 不符 / 区间越界 / 路径越界 / 二进制都拒绝', async () => {
    const mismatch = await proposeTextEdit({
      workspaceDir: root,
      input: {
        path: 'outputs/demo/doc.md',
        start: START,
        end: END,
        replacement: 'x',
        baseHash: 'deadbeef',
      },
    })
    expect(mismatch).toMatchObject({ ok: false, code: 'conflict' })

    const outOfRange = await proposeTextEdit({
      workspaceDir: root,
      input: { path: 'outputs/demo/doc.md', start: 0, end: ORIGINAL.length + 1, replacement: 'x' },
    })
    expect(outOfRange).toMatchObject({ ok: false, code: 'invalid-scope' })

    for (const badPath of ['../outside.md', 'C:/Windows/win.ini', '/etc/passwd']) {
      const result = await proposeTextEdit({
        workspaceDir: root,
        input: { path: badPath, start: 0, end: 1, replacement: 'x' },
      })
      expect(result.ok).toBe(false)
    }

    await writeAt('outputs/demo/bin.dat', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    const binary = await proposeTextEdit({
      workspaceDir: root,
      input: { path: 'outputs/demo/bin.dat', start: 0, end: 1, replacement: 'x' },
    })
    expect(binary).toMatchObject({ ok: false, code: 'invalid-path' })
  })

  it('复用同一个 editId 被拒绝（不覆盖已应用的 before/candidate）', async () => {
    const input = {
      path: 'outputs/demo/doc.md',
      start: START,
      end: END,
      replacement: 'x',
      editId: 'fixed-edit-id',
    }
    expect((await proposeTextEdit({ workspaceDir: root, input })).ok).toBe(true)
    const again = await proposeTextEdit({ workspaceDir: root, input })
    expect(again).toMatchObject({ ok: false, code: 'invalid-scope' })
  })

  it('内部目录（.lumii）不可作为编辑目标', async () => {
    await writeAt('.lumii/cache/note.md', 'hello')
    const result = await proposeTextEdit({
      workspaceDir: root,
      input: { path: '.lumii/cache/note.md', start: 0, end: 1, replacement: 'x' },
    })
    expect(result.ok).toBe(false)
  })
})

describe('applyEdit / discardEdit / undoEdit', () => {
  it('应用后目标被原子替换，before 保留，索引可查', async () => {
    const proposal = await propose()
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return

    const registered = vi.fn()
    const applied = await applyEdit({
      workspaceDir: root,
      editId: proposal.editId,
      registerFile: registered,
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return

    expect(await readAt('outputs/demo/doc.md')).toBe('# Title\n\nHello Lumii\n')
    expect(await readAt(applied.backupPath)).toBe(ORIGINAL)
    expect(applied.versionId).toBe(`local:${proposal.editId}`)
    expect(registered).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'outputs/demo/doc.md', editId: proposal.editId }),
    )

    const listed = await listEdits({ workspaceDir: root, sessionKey: 'conv-1' })
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.edits.map((edit) => edit.editId)).toContain(proposal.editId)
      expect(listed.edits[0]?.path).toBe('outputs/demo/doc.md')
    }
  })

  it('预览期间文件被改过：拒绝应用且不改目标', async () => {
    const proposal = await propose()
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return

    await writeAt('outputs/demo/doc.md', '# changed elsewhere\n')
    const applied = await applyEdit({ workspaceDir: root, editId: proposal.editId })
    expect(applied).toMatchObject({ ok: false, code: 'conflict' })
    expect(await readAt('outputs/demo/doc.md')).toBe('# changed elsewhere\n')
  })

  it('不能重复应用；放弃后候选被删且不能应用', async () => {
    const proposal = await propose()
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return

    expect((await applyEdit({ workspaceDir: root, editId: proposal.editId })).ok).toBe(true)
    expect((await applyEdit({ workspaceDir: root, editId: proposal.editId })).ok).toBe(false)

    const second = await propose('Second')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(await discardEdit({ workspaceDir: root, editId: second.editId })).toEqual({ ok: true })
    expect(await exists(second.candidatePath)).toBe(false)
    expect((await applyEdit({ workspaceDir: root, editId: second.editId })).ok).toBe(false)
  })

  it('撤销产生一次新的本地编辑；文件被再次修改后拒绝撤销', async () => {
    const proposal = await propose()
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    expect((await applyEdit({ workspaceDir: root, editId: proposal.editId })).ok).toBe(true)

    const undone = await undoEdit({ workspaceDir: root, editId: proposal.editId })
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(await readAt('outputs/demo/doc.md')).toBe(ORIGINAL)
    expect(undone.sourceEditId).toBe(proposal.editId)

    const listed = await listEdits({ workspaceDir: root })
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.edits.length).toBe(2)

    // 再改一次文件 → 对上一次的撤销要求会失败
    await writeAt('outputs/demo/doc.md', 'manual change\n')
    const again = await undoEdit({ workspaceDir: root, editId: undone.editId })
    expect(again).toMatchObject({ ok: false, code: 'conflict' })
  })

  it('改前副本被清理后不能撤销', async () => {
    const proposal = await propose()
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    const applied = await applyEdit({ workspaceDir: root, editId: proposal.editId })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return

    await rm(path.join(root, ...applied.backupPath.split('/')), { force: true })
    const undone = await undoEdit({ workspaceDir: root, editId: proposal.editId })
    expect(undone).toMatchObject({ ok: false, code: 'unavailable' })
  })
})

describe('listEdits', () => {
  it('只返回已应用的编辑；按会话过滤；工作区级（null）编辑对每个会话可见', async () => {
    const proposeChar = (replacement: string, sessionKey: string | null) =>
      proposeTextEdit({
        workspaceDir: root,
        input: {
          path: 'outputs/demo/doc.md',
          start: 0,
          end: 1,
          replacement,
          sessionKey,
        },
      })

    const first = await proposeChar('one', 'conv-a')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect((await applyEdit({ workspaceDir: root, editId: first.editId })).ok).toBe(true)

    // 只提议不应用：不出现在索引里
    expect((await proposeChar('never applied', 'conv-a')).ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await proposeChar('two', 'conv-b')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect((await applyEdit({ workspaceDir: root, editId: second.editId })).ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const workspaceWide = await proposeChar('all sessions', null)
    expect(workspaceWide.ok).toBe(true)
    if (!workspaceWide.ok) return
    expect((await applyEdit({ workspaceDir: root, editId: workspaceWide.editId })).ok).toBe(true)

    const a = await listEdits({ workspaceDir: root, sessionKey: 'conv-a' })
    expect(a.ok).toBe(true)
    if (a.ok) {
      expect(a.edits.map((edit) => edit.editId).sort()).toEqual(
        [first.editId, workspaceWide.editId].sort(),
      )
    }

    const all = await listEdits({ workspaceDir: root })
    expect(all.ok).toBe(true)
    if (all.ok) {
      expect(all.edits.length).toBe(3)
      expect(all.edits[0]?.editId).toBe(workspaceWide.editId) // 最近在前
    }
  })
})

describe('proposeFileEdit', () => {
  it('已有候选文件（PPT 等）可走同一底座；写候选失败不留下提案', async () => {
    await writeAt('outputs/demo/deck.pptx', Buffer.from('old-bytes'))
    const proposal = await proposeFileEdit({
      workspaceDir: root,
      input: {
        path: 'outputs/demo/deck.pptx',
        action: 'slide-bullets',
        scope: { type: 'slide', index: 2 },
        sessionKey: 'conv-1',
      },
      writeCandidate: async (candidateAbs) => {
        await writeFile(candidateAbs, Buffer.from('new-bytes'))
      },
    })
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    expect(await readAt('outputs/demo/deck.pptx')).toBe('old-bytes')

    expect((await applyEdit({ workspaceDir: root, editId: proposal.editId })).ok).toBe(true)
    expect(await readAt('outputs/demo/deck.pptx')).toBe('new-bytes')

    await writeAt('outputs/demo/deck2.pptx', Buffer.from('old2'))
    const failed = await proposeFileEdit({
      workspaceDir: root,
      input: {
        path: 'outputs/demo/deck2.pptx',
        action: 'slide-bullets',
        scope: { type: 'slide', index: 0 },
      },
      writeCandidate: async () => {
        throw new Error('script failed')
      },
    })
    expect(failed.ok).toBe(false)
    expect(await readAt('outputs/demo/deck2.pptx')).toBe('old2')
  })
})

describe('recordManualSave / getLocalEditContent', () => {
  it('手工保存落一条 local 版本，候选/改前内容可读', async () => {
    const result = await recordManualSave({
      workspaceDir: root,
      path: 'outputs/demo/doc.md',
      beforeContent: ORIGINAL,
      afterContent: '# Changed\n',
      sessionKey: 'conv-1',
    })
    expect(result).toMatchObject({ merged: false, path: 'outputs/demo/doc.md' })
    if (!result) return

    expect((await getLocalEditContent({ workspaceDir: root, editId: result.editId }))?.text).toBe(
      '# Changed\n',
    )
    expect(
      (await getLocalEditContent({ workspaceDir: root, editId: result.editId, which: 'before' }))
        ?.text,
    ).toBe(ORIGINAL)

    const listed = await listEdits({ workspaceDir: root, sessionKey: 'conv-1' })
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.edits).toHaveLength(1)
      expect(listed.edits[0]).toMatchObject({ action: 'manual', path: 'outputs/demo/doc.md' })
    }
  })

  it('60s 内连续保存合并为同一条：before 保留最早，candidate 取最新', async () => {
    const t0 = Date.now()
    const first = await recordManualSave({
      workspaceDir: root,
      path: 'outputs/demo/doc.md',
      beforeContent: 'A',
      afterContent: 'B',
      sessionKey: 'conv-1',
      now: t0,
    })
    expect(first?.merged).toBe(false)
    if (!first) return

    const second = await recordManualSave({
      workspaceDir: root,
      path: 'outputs/demo/doc.md',
      beforeContent: 'B',
      afterContent: 'C',
      sessionKey: 'conv-1',
      now: t0 + 10_000,
    })
    expect(second).toMatchObject({ editId: first.editId, merged: true })
    if (!second) return

    expect((await getLocalEditContent({ workspaceDir: root, editId: first.editId }))?.text).toBe('C')
    expect(
      (await getLocalEditContent({ workspaceDir: root, editId: first.editId, which: 'before' }))
        ?.text,
    ).toBe('A')
    const listed = await listEdits({ workspaceDir: root, sessionKey: 'conv-1' })
    if (listed.ok) expect(listed.edits).toHaveLength(1)
  })

  it('超过 60s 另起一条；二进制/内部目录/无变化/工作区外都不记录', async () => {
    const t0 = Date.now()
    const first = await recordManualSave({
      workspaceDir: root,
      path: 'outputs/demo/doc.md',
      beforeContent: 'A',
      afterContent: 'B',
      sessionKey: 'conv-1',
      now: t0,
    })
    expect(first?.merged).toBe(false)
    const second = await recordManualSave({
      workspaceDir: root,
      path: 'outputs/demo/doc.md',
      beforeContent: 'B',
      afterContent: 'C',
      sessionKey: 'conv-1',
      now: t0 + 120_000,
    })
    expect(second?.merged).toBe(false)
    expect(second?.editId).not.toBe(first?.editId)

    await writeAt('outputs/demo/pic.png', 'not really png')
    expect(
      await recordManualSave({
        workspaceDir: root,
        path: 'outputs/demo/pic.png',
        beforeContent: 'a',
        afterContent: 'b',
      }),
    ).toBeNull()
    expect(
      await recordManualSave({
        workspaceDir: root,
        path: '.lumii/cache/x.md',
        beforeContent: 'a',
        afterContent: 'b',
      }),
    ).toBeNull()
    expect(
      await recordManualSave({
        workspaceDir: root,
        path: 'outputs/demo/doc.md',
        beforeContent: 'same',
        afterContent: 'same',
      }),
    ).toBeNull()
    expect(
      await recordManualSave({
        workspaceDir: root,
        path: path.join(base, 'outside.md'),
        beforeContent: 'a',
        afterContent: 'b',
      }),
    ).toBeNull()
  })

  it('二进制候选没有文本内容（PPT 等版本走文件预览，不做文本 diff）', async () => {
    await writeAt('outputs/demo/deck.pptx', Buffer.from('old'))
    const proposal = await proposeFileEdit({
      workspaceDir: root,
      input: {
        path: 'outputs/demo/deck.pptx',
        action: 'slide-bullets',
        scope: { type: 'slide', index: 0 },
      },
      writeCandidate: async (candidateAbs) => {
        await writeFile(candidateAbs, Buffer.from('new'))
      },
    })
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    expect((await getLocalEditContent({ workspaceDir: root, editId: proposal.editId }))?.text).toBeNull()
  })
})

describe('pruneEditStore / pruneWorkspaceScratch', () => {
  it('未应用候选 24h 后清掉；已应用内容超过 30 天/上限时删内容但保留 meta', async () => {
    const proposal = await propose()
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    expect((await applyEdit({ workspaceDir: root, editId: proposal.editId })).ok).toBe(true)

    const metaPath = path.join(root, '.lumii', 'edits', proposal.editId, 'meta.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { beforeFile: string; candidateFile: string; editId: string }

    const future = Date.now() + 31 * 24 * 60 * 60 * 1000
    const pruned = await pruneEditStore({ workspaceDir: root, now: future })
    expect(pruned.prunedContents).toBe(1)
    expect(await exists(`.lumii/edits/${proposal.editId}/meta.json`)).toBe(true)
    expect(await exists(`.lumii/edits/${proposal.editId}/${meta.beforeFile}`)).toBe(false)
    expect(await exists(`.lumii/edits/${proposal.editId}/${meta.candidateFile}`)).toBe(false)

    // 内容被清掉后，撤销应报不可用
    const undone = await undoEdit({ workspaceDir: root, editId: proposal.editId })
    expect(undone).toMatchObject({ ok: false, code: 'unavailable' })

    // 未应用的新提案在 24h 后被整目录清掉
    const fresh = await propose('fresh')
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    const later = Date.now() + 25 * 60 * 60 * 1000
    const pruned2 = await pruneEditStore({ workspaceDir: root, now: later })
    expect(pruned2.removedDirs).toBeGreaterThanOrEqual(1)
    expect(await exists(`.lumii/edits/${fresh.editId}`)).toBe(false)
  })

  it('按最老优先压到字节上限', async () => {
    const first = await propose('a'.repeat(400))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect((await applyEdit({ workspaceDir: root, editId: first.editId })).ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await propose('b'.repeat(400))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect((await applyEdit({ workspaceDir: root, editId: second.editId })).ok).toBe(true)

    const pruned = await pruneEditStore({ workspaceDir: root, maxBytes: 10 })
    expect(pruned.prunedContents).toBeGreaterThanOrEqual(1)
  })

  it('清 .lumii/tmp 与 .lumii/exports 的旧临时目录，保留新的', async () => {
    await writeAt('.lumii/tmp/old/a.bin', 'x')
    await writeAt('.lumii/tmp/fresh/b.bin', 'y')
    await writeAt('.lumii/exports/old/c.zip', 'z')
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await utimes(path.join(root, '.lumii/tmp/old'), oldTime, oldTime)
    await utimes(path.join(root, '.lumii/exports/old'), oldTime, oldTime)

    const result = await pruneWorkspaceScratch({ workspaceDir: root })
    expect(result.removed).toBe(2)
    expect(await exists('.lumii/tmp/old')).toBe(false)
    expect(await exists('.lumii/tmp/fresh')).toBe(true)
    expect(await exists('.lumii/exports/old')).toBe(false)
  })

  it('编辑索引本身不会被当成临时目录清掉', async () => {
    const proposal = await propose()
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    await applyEdit({ workspaceDir: root, editId: proposal.editId })
    await pruneWorkspaceScratch({ workspaceDir: root })
    const listed = await listEdits({ workspaceDir: root })
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.edits.length).toBe(1)
  })
})

describe('recordVariantEdit（P2 T5）', () => {
  it('只追加一条 variant 索引：rail/版本列表能读到来源，且不建候选目录', async () => {
    await writeAt('outputs/demo/cover-variant-153012.png', 'VARIANT')
    const recorded = await recordVariantEdit({
      workspaceDir: root,
      sessionKey: 'conv-1',
      path: 'outputs/demo/cover-variant-153012.png',
      derivedFrom: 'outputs/demo/cover.png',
      bytes: 7,
    })
    expect(recorded?.editId).toMatch(/^edit-/)

    const listed = await listEdits({ workspaceDir: root, sessionKey: 'conv-1' })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.edits).toEqual([
      {
        editId: recorded!.editId,
        sessionKey: 'conv-1',
        path: 'outputs/demo/cover-variant-153012.png',
        action: 'variant',
        scope: { type: 'image-variant' },
        at: expect.any(Number),
        bytes: 7,
        derivedFrom: 'outputs/demo/cover.png',
      },
    ])
    // 没有 before/candidate：变体的内容就是工作区里的那个文件
    expect(await exists(`.lumii/edits/${recorded!.editId}`)).toBe(false)
  })

  it('路径非法 / 来源与目标相同 / internal 路径一律拒绝', async () => {
    expect(
      await recordVariantEdit({
        workspaceDir: root,
        path: '../a.png',
        derivedFrom: 'outputs/demo/cover.png',
        bytes: 1,
      }),
    ).toBeNull()
    expect(
      await recordVariantEdit({
        workspaceDir: root,
        path: 'outputs/demo/cover.png',
        derivedFrom: 'outputs/demo/cover.png',
        bytes: 1,
      }),
    ).toBeNull()
    expect(
      await recordVariantEdit({
        workspaceDir: root,
        path: '.lumii/edits/x.png',
        derivedFrom: 'outputs/demo/cover.png',
        bytes: 1,
      }),
    ).toBeNull()
  })
})
