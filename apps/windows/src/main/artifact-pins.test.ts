// @vitest-environment node
/**
 * 「以此为准」固化（P2 T6）：真文件系统——判据是副本字节与索引行为。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  clearPins,
  findPinEntry,
  listPins,
  pinFilePath,
  pinVersion,
  readPinIndex,
  unpinVersion,
} from './artifact-pins'

let base = ''
let root = ''

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-pins-'))
  root = path.join(base, 'ws')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

function pin(overrides: Partial<Parameters<typeof pinVersion>[0]> = {}) {
  return pinVersion({
    workspaceDir: root,
    sessionKey: 'conv-1',
    path: 'outputs/demo/doc.md',
    versionId: 'turn:m1',
    content: Buffer.from('v1'),
    ...overrides,
  })
}

describe('pinVersion', () => {
  it('把内容复制到 .lumii/pins/<pinId>/，索引记录字节与版本', async () => {
    const result = await pin({ content: Buffer.from('v1-content') })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bytes).toBe(Buffer.byteLength('v1-content'))

    const pins = await listPins({ workspaceDir: root, sessionKey: 'conv-1' })
    if (!pins.ok) throw new Error(pins.error)
    expect(pins.pins).toHaveLength(1)
    expect(pins.pins[0]).toMatchObject({
      pinId: result.pinId,
      sessionKey: 'conv-1',
      path: 'outputs/demo/doc.md',
      versionId: 'turn:m1',
      bytes: Buffer.byteLength('v1-content'),
    })
    expect(pins.totalBytes).toBe(Buffer.byteLength('v1-content'))
    expect(pins.limitBytes).toBe(2 * 1024 * 1024 * 1024)

    const entry = await findPinEntry({
      workspaceDir: root,
      path: 'outputs/demo/doc.md',
      versionId: 'turn:m1',
    })
    expect(entry?.pinId).toBe(result.pinId)
    expect(await readFile(pinFilePath(root, entry!), 'utf8')).toBe('v1-content')
  })

  it('同一路径只保留一个选定：替换索引项，旧副本留到清理', async () => {
    const first = await pin()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = await pin({ versionId: 'local:edit-1', content: Buffer.from('v2') })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.replaced).toBe(first.pinId)

    const pins = await listPins({ workspaceDir: root, sessionKey: 'conv-1' })
    if (!pins.ok) throw new Error(pins.error)
    expect(pins.pins.map((item) => item.versionId)).toEqual(['local:edit-1'])
    // 旧副本不删（可恢复式替换），交给清理
    expect(await exists(pinFilePath(root, { ...pins.pins[0]!, pinId: first.pinId }))).toBe(true)
  })

  it('不同会话/路径各自独立', async () => {
    await pin()
    await pin({ sessionKey: 'conv-2' })
    await pin({ path: 'outputs/demo/other.md' })
    const all = await listPins({ workspaceDir: root })
    if (!all.ok) throw new Error(all.error)
    expect(all.pins).toHaveLength(3)
    const onlyConv2 = await listPins({ workspaceDir: root, sessionKey: 'conv-2' })
    if (!onlyConv2.ok) throw new Error(onlyConv2.error)
    // 会话过滤：工作区级（null）对谁都可见；这里都是会话级
    expect(onlyConv2.pins).toHaveLength(1)
    expect(onlyConv2.pins[0]?.sessionKey).toBe('conv-2')
  })

  it('单文件/总量上限拒绝，且不留索引与副本', async () => {
    const tooBig = await pin({
      content: Buffer.from('12345'),
      limits: { maxFileBytes: 4 },
    })
    expect(tooBig).toMatchObject({ ok: false, code: 'unavailable' })

    const small = await pin({ content: Buffer.from('1234') })
    expect(small.ok).toBe(true)
    const overflow = await pin({
      path: 'outputs/demo/second.md',
      content: Buffer.from('abcd'),
      limits: { maxTotalBytes: 6 },
    })
    expect(overflow).toMatchObject({ ok: false })
    expect(overflow.ok === false && overflow.error).toContain('上限')

    const pins = await readPinIndex(root)
    expect(pins).toHaveLength(1)
  })

  it('空内容 / 非法路径 / 非法版本被拒绝', async () => {
    expect(await pin({ content: Buffer.alloc(0) })).toMatchObject({ ok: false })
    expect(await pin({ path: '../outside.md' })).toMatchObject({ ok: false, code: 'invalid-path' })
    expect(await pin({ versionId: '' })).toMatchObject({ ok: false, code: 'invalid-scope' })
    expect(await readPinIndex(root)).toEqual([])
  })
})

describe('unpin / clear', () => {
  it('取消只删索引项，副本保留；未知 pinId 报 not-found', async () => {
    const created = await pin()
    if (!created.ok) throw new Error(created.error)
    const entry = await findPinEntry({
      workspaceDir: root,
      path: 'outputs/demo/doc.md',
      versionId: 'turn:m1',
    })
    expect(await unpinVersion({ workspaceDir: root, pinId: created.pinId })).toEqual({ ok: true })
    expect(await readPinIndex(root)).toEqual([])
    expect(await exists(pinFilePath(root, entry!))).toBe(true)

    expect(await unpinVersion({ workspaceDir: root, pinId: created.pinId })).toMatchObject({
      ok: false,
      code: 'not-found',
    })
  })

  it('清空删除索引与全部副本并汇报占用', async () => {
    await pin({ content: Buffer.from('abc') })
    await pin({ path: 'outputs/demo/other.md', content: Buffer.from('de') })
    const cleared = await clearPins({ workspaceDir: root })
    expect(cleared).toEqual({ ok: true, removed: 2, freedBytes: 5 })
    expect(await exists(path.join(root, '.lumii', 'pins'))).toBe(false)
    const pins = await listPins({ workspaceDir: root })
    if (!pins.ok) throw new Error(pins.error)
    expect(pins.pins).toEqual([])
  })

  it('坏索引按空处理，不炸', async () => {
    const dir = path.join(root, '.lumii', 'pins')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.json'), '{not json')
    expect(await readPinIndex(root)).toEqual([])
    const created = await pin()
    expect(created.ok).toBe(true)
  })
})
