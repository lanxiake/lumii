// @vitest-environment node
/**
 * 回合文本版本副本：只存成品文本、可读回、按年龄清理、路径越界拒绝。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import {
  captureTurnTextVersions,
  hasTurnTextVersion,
  pruneTurnVersions,
  readTurnTextVersion,
} from './turn-version-store'

let base = ''
let root = ''
const MSG = 'abcdef1234567890'

async function writeAt(rel: string, content: string | Buffer): Promise<string> {
  const abs = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content)
  return abs
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-turnver-'))
  root = path.join(base, 'ws')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('captureTurnTextVersions', () => {
  it('复制成品文本；可读回且覆盖旧副本', async () => {
    await writeAt('outputs/a/doc.md', '# v1\n')
    const first = await captureTurnTextVersions({
      workspaceDir: root,
      messageId: MSG,
      changes: [{ path: 'outputs/a/doc.md', status: 'added' }],
    })
    expect(first.saved).toBe(1)
    expect(await hasTurnTextVersion({ workspaceDir: root, messageId: MSG, path: 'outputs/a/doc.md' })).toBe(true)
    expect(
      await readTurnTextVersion({ workspaceDir: root, messageId: MSG, path: 'outputs/a/doc.md' }),
    ).toBe('# v1\n')

    await writeAt('outputs/a/doc.md', '# v2\n')
    await captureTurnTextVersions({
      workspaceDir: root,
      messageId: MSG,
      changes: [{ path: 'outputs/a/doc.md', status: 'modified' }],
    })
    expect(
      await readTurnTextVersion({ workspaceDir: root, messageId: MSG, path: 'outputs/a/doc.md' }),
    ).toBe('# v2\n')
  })

  it('跳过中间产物/临时/二进制/删除/越界/坏 messageId', async () => {
    await writeAt('outputs/a/parts/p1.md', 'mid')
    await writeAt('temp/x.md', 'tmp')
    await writeAt('outputs/a/pic.png', 'png')
    await writeAt('outputs/a/doc.md', 'doc')
    const result = await captureTurnTextVersions({
      workspaceDir: root,
      messageId: MSG,
      changes: [
        { path: 'outputs/a/parts/p1.md', status: 'added' },
        { path: 'temp/x.md', status: 'added' },
        { path: 'outputs/a/pic.png', status: 'added' },
        { path: 'outputs/a/doc.md', status: 'deleted' },
        { path: '../outside.md', status: 'added' },
      ],
    })
    expect(result.saved).toBe(0)

    expect(
      await captureTurnTextVersions({
        workspaceDir: root,
        messageId: 'bad id!',
        changes: [{ path: 'outputs/a/doc.md', status: 'added' }],
      }),
    ).toEqual({ saved: 0 })
  })
})

describe('pruneTurnVersions', () => {
  it('超过年龄的回合目录被删，新目录保留', async () => {
    await writeAt('outputs/a/doc.md', 'doc')
    await captureTurnTextVersions({
      workspaceDir: root,
      messageId: MSG,
      changes: [{ path: 'outputs/a/doc.md', status: 'added' }],
    })
    const dir = path.join(root, '.lumii', 'versions', `turn-${MSG}`)
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await utimes(dir, old, old)

    const result = await pruneTurnVersions({ workspaceDir: root, maxAgeDays: 30 })
    expect(result.removedDirs).toBe(1)
    expect(await hasTurnTextVersion({ workspaceDir: root, messageId: MSG, path: 'outputs/a/doc.md' })).toBe(false)
  })
})
