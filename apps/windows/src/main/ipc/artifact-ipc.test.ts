// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

import { ipcMain } from 'electron'
import { registerArtifactIpcHandlers, setArtifactIpcDeps } from './artifact-ipc'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'lumii-artifact-ipc-'))
  vi.clearAllMocks()
  setArtifactIpcDeps({ getWorkspaceDir: () => root })
  registerArtifactIpcHandlers()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const handlerFor = (channel: string) =>
  (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === channel)![1]

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
}

describe('artifact:readMeta', () => {
  it('读侧车；坏 JSON / 缺失 / 越界静默跳过', async () => {
    await write(
      'outputs/deck.pptx.lumii-artifact.json',
      JSON.stringify({ kind: 'slides', title: '月报', meta: { pages: 12 } }),
    )
    await write('outputs/bad.pptx.lumii-artifact.json', '{oops')

    const handler = handlerFor('artifact:readMeta')
    const response = await handler({}, [
      'outputs/deck.pptx',
      'outputs/bad.pptx',
      'outputs/missing.pptx',
      '../escape.pptx',
      '/abs/path.pptx',
      42,
    ])

    expect(response.ok).toBe(true)
    expect(response.metas).toEqual({
      'outputs/deck.pptx': { kind: 'slides', title: '月报', meta: { pages: 12 } },
    })
  })

  it('非数组入参结构化报错', async () => {
    const handler = handlerFor('artifact:readMeta')
    await expect(handler({}, 'nope')).resolves.toMatchObject({ ok: false })
  })

  it('超过 64KB 的侧车不读', async () => {
    await write(
      'outputs/huge.pptx.lumii-artifact.json',
      JSON.stringify({ kind: 'slides', title: 'x'.repeat(70 * 1024) }),
    )
    const handler = handlerFor('artifact:readMeta')
    const response = await handler({}, ['outputs/huge.pptx'])
    expect(response.metas).toEqual({})
  })
})
