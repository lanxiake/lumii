// @vitest-environment node
/**
 * 版本合并：turn + local、可用性推断、删除版取前一版、VCS 停用降级。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { setVcsAccessor } from './agent-runtime/vcs-accessor'
import { listEdits, recordManualSave } from './artifact-edit'
import {
  buildMergedVersions,
  localVersionId,
  resolveVersionContent,
  turnVersionId,
  type TurnChangeRow,
} from './artifact-versions'

let base = ''
let root = ''
const FILE = 'outputs/x/doc.md'

const TURNS: TurnChangeRow[] = [
  {
    messageId: 'm1',
    timestamp: '2026-10-27T10:00:00.000Z',
    changes: [{ path: FILE, status: 'added' }],
  },
  {
    messageId: 'm2',
    timestamp: '2026-10-27T10:01:00.000Z',
    changes: [{ path: FILE, status: 'modified' }],
  },
  {
    messageId: 'm3',
    timestamp: '2026-10-27T10:02:00.000Z',
    changes: [{ path: FILE, status: 'deleted' }],
  },
]

function fakeVcs(contentByOid: Record<string, string | null>) {
  return {
    captureTurnSnapshot: async () => new Map<string, string>(),
    maybeSnapshot: async () => null,
    readFileAt: async (_workspaceDir: string, oid: string, filepath: string) => {
      if (filepath !== FILE) return null
      return contentByOid[oid] ?? null
    },
  }
}

async function writeIndex(lines: unknown[]): Promise<void> {
  const dir = path.join(root, '.mtbot-vcs')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'turn-index.jsonl'),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  )
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-versions-'))
  root = path.join(base, 'ws')
  await mkdir(path.join(root, 'outputs', 'x'), { recursive: true })
  await writeFile(path.join(root, ...FILE.split('/')), '# doc\n', 'utf8')
})

afterEach(async () => {
  setVcsAccessor(null)
  await rm(base, { recursive: true, force: true })
})

describe('buildMergedVersions', () => {
  it('合并 turn / local，按时间排序；turn 内容从索引推断', async () => {
    await writeIndex([
      { messageId: 'm1', oid: 'aaa', at: 1000 },
      { messageId: 'm2', oid: null, at: 2000 },
      { messageId: 'm3', oid: 'bbb', at: 3000, coalesced: 2 },
    ])
    const manual = await recordManualSave({
      workspaceDir: root,
      path: FILE,
      beforeContent: '# doc\n',
      afterContent: '# doc\n\nlocal\n',
      sessionKey: 'conv-1',
      now: Date.parse('2026-10-27T10:00:30.000Z'),
    })
    expect(manual).toBeTruthy()
    const local = await listEdits({ workspaceDir: root, sessionKey: 'conv-1' })
    expect(local.ok).toBe(true)
    if (!local.ok) return

    const versions = await buildMergedVersions({
      workspaceDir: root,
      path: FILE,
      turns: TURNS,
      localEdits: local.edits,
    })

    expect(versions.map((version) => version.versionId)).toEqual([
      turnVersionId('m1'),
      localVersionId(manual!.editId),
      turnVersionId('m2'),
      turnVersionId('m3'),
    ])
    expect(versions[0]?.content).toMatchObject({ available: true, kind: 'git' })
    expect(versions[1]?.content).toMatchObject({ available: true, kind: 'store' })
    // m3 是删除版：内容取前一版并标近似
    expect(versions[3]?.content).toMatchObject({ available: true, approximate: true })
  })

  it('媒体 turn 版本无内容；local 内容被清理后标不可用', async () => {
    await writeIndex([{ messageId: 'm1', oid: 'aaa', at: 1000 }])
    const versions = await buildMergedVersions({
      workspaceDir: root,
      path: 'outputs/x/pic.png',
      turns: [
        {
          messageId: 'm1',
          timestamp: '2026-10-27T10:00:00.000Z',
          changes: [{ path: 'outputs/x/pic.png', status: 'added' }],
        },
      ],
      localEdits: [],
    })
    expect(versions[0]?.content.available).toBe(false)
    expect(versions[0]?.content.reason).toContain('二进制')
  })
})

describe('resolveVersionContent', () => {
  it('turn 读索引 oid；删除版取前一版；local 读候选', async () => {
    await writeIndex([
      { messageId: 'm1', oid: 'aaa', at: 1000 },
      { messageId: 'm2', oid: null, at: 2000 },
      { messageId: 'm3', oid: 'bbb', at: 3000 },
    ])
    setVcsAccessor(() => fakeVcs({ aaa: 'v1\n', bbb: 'v3\n' }))
    const manual = await recordManualSave({
      workspaceDir: root,
      path: FILE,
      beforeContent: 'v1\n',
      afterContent: 'local\n',
      sessionKey: 'conv-1',
      now: Date.parse('2026-10-27T10:00:30.000Z'),
    })
    const local = await listEdits({ workspaceDir: root, sessionKey: 'conv-1' })
    if (!local.ok || !manual) return

    const versions = await buildMergedVersions({
      workspaceDir: root,
      path: FILE,
      turns: TURNS,
      localEdits: local.edits,
    })
    const byId = new Map(versions.map((version) => [version.versionId, version]))

    const m1 = await resolveVersionContent({
      workspaceDir: root,
      path: FILE,
      version: byId.get(turnVersionId('m1'))!,
      allVersions: versions,
    })
    expect(m1).toMatchObject({ ok: true, content: { text: 'v1\n', kind: 'git' } })

    const m2 = await resolveVersionContent({
      workspaceDir: root,
      path: FILE,
      version: byId.get(turnVersionId('m2'))!,
      allVersions: versions,
    })
    expect(m2).toMatchObject({ ok: true, content: { text: 'v1\n' } })

    const m3 = await resolveVersionContent({
      workspaceDir: root,
      path: FILE,
      version: byId.get(turnVersionId('m3'))!,
      allVersions: versions,
    })
    expect(m3).toMatchObject({ ok: true, content: { text: 'v1\n', approximate: true } })

    const localResolved = await resolveVersionContent({
      workspaceDir: root,
      path: FILE,
      version: byId.get(localVersionId(manual.editId))!,
      allVersions: versions,
    })
    expect(localResolved).toMatchObject({ ok: true, content: { text: 'local\n', kind: 'store' } })
  })

  it('VCS 停用时给出可读原因', async () => {
    await writeIndex([{ messageId: 'm1', oid: 'aaa', at: 1000 }])
    setVcsAccessor(null)
    const versions = await buildMergedVersions({
      workspaceDir: root,
      path: FILE,
      turns: [TURNS[0]!],
      localEdits: [],
    })
    const result = await resolveVersionContent({
      workspaceDir: root,
      path: FILE,
      version: versions[0]!,
      allVersions: versions,
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('VCS')
  })
})
