// @vitest-environment node
/**
 * 版本合并：turn + local、可用性推断、删除版取前一版、VCS 停用降级。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { setVcsAccessor } from './agent-runtime/vcs-accessor'
import { listEdits, recordManualSave, recordVariantEdit } from './artifact-edit'
import {
  attachPins,
  buildMergedVersions,
  localVersionId,
  readVersionBytes,
  resolveVersionContent,
  turnVersionId,
  type TurnChangeRow,
} from './artifact-versions'
import { pinVersion } from './artifact-pins'
import type { ArtifactVersionInfo } from '../shared/artifact-version-types'

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

describe('buildMergedVersions · 图片变体（T5）', () => {
  const VARIANT = 'outputs/x/cover-variant-153012.png'

  it('变体版本的内容就是工作区文件本身', async () => {
    const abs = path.join(root, ...VARIANT.split('/'))
    await writeFile(abs, 'PNG')
    const recorded = await recordVariantEdit({
      workspaceDir: root,
      sessionKey: 'conv-1',
      path: VARIANT,
      derivedFrom: 'outputs/x/cover.png',
      bytes: 3,
      now: Date.parse('2026-10-27T10:00:10.000Z'),
    })
    expect(recorded).toBeTruthy()
    const local = await listEdits({ workspaceDir: root, sessionKey: 'conv-1' })
    if (!local.ok) throw new Error(local.error)

    const versions = await buildMergedVersions({
      workspaceDir: root,
      path: VARIANT,
      turns: [],
      localEdits: local.edits,
    })
    expect(versions).toHaveLength(1)
    expect(versions[0]?.content).toEqual({ available: true, kind: 'store' })
  })

  it('变体文件被删后如实标不可取', async () => {
    const abs = path.join(root, ...VARIANT.split('/'))
    await writeFile(abs, 'PNG')
    await recordVariantEdit({
      workspaceDir: root,
      sessionKey: 'conv-1',
      path: VARIANT,
      derivedFrom: 'outputs/x/cover.png',
      bytes: 3,
    })
    await rm(abs)
    const local = await listEdits({ workspaceDir: root, sessionKey: 'conv-1' })
    if (!local.ok) throw new Error(local.error)
    const versions = await buildMergedVersions({
      workspaceDir: root,
      path: VARIANT,
      turns: [],
      localEdits: local.edits,
    })
    expect(versions[0]?.content).toMatchObject({
      available: false,
      reason: '变体文件已不在工作区',
    })
  })
})

describe('readVersionBytes / attachPins（T6）', () => {
  const PIC = 'outputs/x/pic.png'

  async function writeEditDir(
    editId: string,
    relPath: string,
    candidate: Buffer,
  ): Promise<void> {
    const dir = path.join(root, '.lumii', 'edits', editId)
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        editId,
        sessionKey: 'conv-1',
        path: relPath,
        action: 'manual',
        scope: { type: 'file' },
        at: Date.now(),
        status: 'applied',
        baseHash: 'x',
        candidateFile: 'candidate.bin',
        beforeFile: 'before.bin',
        originalBytes: 0,
      }),
    )
    await writeFile(path.join(dir, 'candidate.bin'), candidate)
  }

  function version(overrides: Partial<ArtifactVersionInfo>): ArtifactVersionInfo {
    return {
      versionId: 'turn:m1',
      source: 'turn',
      turnId: 'm1',
      timestamp: 1000,
      status: 'modified',
      content: { available: true, kind: 'git' },
      ...overrides,
    }
  }

  it('本地编辑副本按字节读（二进制也可以）', async () => {
    await writeFile(path.join(root, ...PIC.split('/')), 'CURRENT')
    await writeEditDir('edit-bin', PIC, Buffer.from([1, 2, 3]))
    const item = version({
      versionId: 'local:edit-bin',
      source: 'local',
      turnId: undefined,
      status: 'edited',
    })
    const result = await readVersionBytes({
      workspaceDir: root,
      path: PIC,
      version: item,
      allVersions: [item],
      localEdits: [
        {
          editId: 'edit-bin',
          sessionKey: 'conv-1',
          path: PIC,
          action: 'manual',
          scope: { type: 'file' },
          at: 1,
          bytes: 3,
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect([...result.bytes]).toEqual([1, 2, 3])
  })

  it('变体版本读工作区里的新文件', async () => {
    await writeFile(path.join(root, ...PIC.split('/')), 'VARIANT-BYTES')
    const item = version({
      versionId: 'local:edit-v',
      source: 'local',
      turnId: undefined,
      status: 'edited',
    })
    const result = await readVersionBytes({
      workspaceDir: root,
      path: PIC,
      version: item,
      allVersions: [item],
      localEdits: [
        {
          editId: 'edit-v',
          sessionKey: 'conv-1',
          path: PIC,
          action: 'variant',
          scope: { type: 'image-variant' },
          at: 1,
          bytes: 13,
          derivedFrom: 'outputs/x/src.png',
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytes.toString('utf8')).toBe('VARIANT-BYTES')
  })

  it('二进制 turn 版：当前版读工作区文件，旧版如实不可取', async () => {
    await writeFile(path.join(root, ...PIC.split('/')), 'CURRENT')
    const older = version({ versionId: 'turn:m0', turnId: 'm0', timestamp: 900 })
    const current = version({ versionId: 'turn:m1', turnId: 'm1', timestamp: 1000 })
    const versions = [older, current]

    const readCurrent = await readVersionBytes({
      workspaceDir: root,
      path: PIC,
      version: current,
      allVersions: versions,
    })
    expect(readCurrent.ok).toBe(true)
    if (readCurrent.ok) expect(readCurrent.bytes.toString('utf8')).toBe('CURRENT')

    const readOlder = await readVersionBytes({
      workspaceDir: root,
      path: PIC,
      version: older,
      allVersions: versions,
    })
    expect(readOlder).toMatchObject({ ok: false })
    if (!readOlder.ok) expect(readOlder.reason).toContain('二进制')
  })

  it('有固化副本时优先用固化内容（文件被覆盖后仍是选定版）', async () => {
    await writeFile(path.join(root, ...PIC.split('/')), 'LATER-OVERWRITE')
    const item = version({ versionId: 'turn:m1' })
    const pinned = await pinVersion({
      workspaceDir: root,
      sessionKey: 'conv-1',
      path: PIC,
      versionId: 'turn:m1',
      content: Buffer.from('PINNED-BYTES'),
    })
    expect(pinned.ok).toBe(true)

    const result = await readVersionBytes({
      workspaceDir: root,
      path: PIC,
      version: item,
      allVersions: [item],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.kind).toBe('pin')
      expect(result.bytes.toString('utf8')).toBe('PINNED-BYTES')
    }
  })

  it('attachPins 标出选定并让「原本不可取」的内容变为可取', () => {
    const versionItem = version({
      versionId: 'turn:m1',
      content: { available: false, reason: '该版本的原始文件未被保留（VCS 不含二进制）' },
    })
    const [withPin] = attachPins([versionItem], [
      {
        pinId: 'pin-1',
        sessionKey: 'conv-1',
        path: PIC,
        versionId: 'turn:m1',
        bytes: 42,
        at: 2000,
      },
    ])
    expect(withPin?.pinned).toEqual({ pinId: 'pin-1', at: 2000, bytes: 42 })
    expect(withPin?.content).toEqual({ available: true, kind: 'store' })
    expect(attachPins([versionItem], [])[0]?.pinned).toBeUndefined()
  })
})

describe('buildMergedVersions · 媒体最新版（T6）', () => {
  it('最新一版内容就是当前文件（可固化）；历史二进制仍如实不可取', async () => {
    const PIC = 'outputs/x/latest.png'
    await writeFile(path.join(root, ...PIC.split('/')), 'LATEST')
    const versions = await buildMergedVersions({
      workspaceDir: root,
      path: PIC,
      turns: [
        {
          messageId: 'm0',
          timestamp: '2026-10-27T10:00:00.000Z',
          changes: [{ path: PIC, status: 'added' }],
        },
        {
          messageId: 'm1',
          timestamp: '2026-10-27T10:01:00.000Z',
          changes: [{ path: PIC, status: 'modified' }],
        },
      ],
      localEdits: [],
    })
    expect(versions).toHaveLength(2)
    expect(versions[0]?.content.available).toBe(false)
    expect(versions[1]?.content).toEqual({ available: true, kind: 'store' })
  })
})
