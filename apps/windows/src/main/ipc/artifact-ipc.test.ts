// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
}))

import { dialog, ipcMain } from 'electron'
import { registerArtifactIpcHandlers, setArtifactIpcDeps } from './artifact-ipc'
import { recordManualSave } from '../artifact-edit'
import { readFile } from 'node:fs/promises'

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

describe('artifact:export · 导出选定版（P2 T6）', () => {
  function installBridge(): void {
    setArtifactIpcDeps({
      getWorkspaceDir: () => root,
      getMainWindow: () => null,
      getAgentRuntimeBridge: () =>
        ({
          conversationRepo: {
            getConversation: () => ({ id: 'conv-1' }),
            listFileChangeTurns: () => [],
          },
          getCwd: () => root,
        }) as never,
    })
    registerArtifactIpcHandlers()
  }

  it('带 versionId 时另存为写出的是该版内容，当前文件不变', async () => {
    await write('outputs/x/doc.md', 'v4-current')
    const first = await recordManualSave({
      workspaceDir: root,
      path: 'outputs/x/doc.md',
      beforeContent: 'v2-middle',
      afterContent: 'v3-middle',
      sessionKey: 'conv-1',
      now: Date.now() - 120_000,
    })
    expect(first).toBeTruthy()
    // 再存一次，让「当前文件」与要导出的那一版不同（60s 合并窗口外）
    const second = await recordManualSave({
      workspaceDir: root,
      path: 'outputs/x/doc.md',
      beforeContent: 'v3-middle',
      afterContent: 'v4-current',
      sessionKey: 'conv-1',
      now: Date.now(),
    })
    expect(second).toBeTruthy()
    installBridge()

    const dest = path.join(root, 'out', 'saved.md')
    ;(dialog.showSaveDialog as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      filePath: dest,
    })
    const handler = handlerFor('artifact:export')
    const result = await handler(
      {},
      {
        paths: ['outputs/x/doc.md'],
        mode: 'save',
        versionId: `local:${first!.editId}`,
        sessionKey: 'conv-1',
      },
    )
    expect(result.ok).toBe(true)
    expect(await readFile(dest, 'utf8')).toBe('v3-middle')
    expect(await readFile(path.join(root, 'outputs/x/doc.md'), 'utf8')).toBe('v4-current')
  })

  it('历史版本只支持另存为（zip/copy 直接拒绝）', async () => {
    await write('outputs/x/doc.md', 'now')
    installBridge()
    const handler = handlerFor('artifact:export')
    const zipped = await handler(
      {},
      { paths: ['outputs/x/doc.md'], mode: 'zip', versionId: 'turn:m1', sessionKey: 'conv-1' },
    )
    expect(zipped).toMatchObject({ ok: false })
    expect(zipped.error).toContain('另存为')
  })

  it('没有 versionId 时行为不变（当前文件）', async () => {
    await write('outputs/x/doc.md', 'now')
    installBridge()
    const dest = path.join(root, 'out', 'now.md')
    ;(dialog.showSaveDialog as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      filePath: dest,
    })
    const handler = handlerFor('artifact:export')
    const result = await handler({}, { paths: ['outputs/x/doc.md'], mode: 'save' })
    expect(result.ok).toBe(true)
    expect(await readFile(dest, 'utf8')).toBe('now')
  })
})

describe('artifact:pins IPC', () => {
  it('列表与清空走同一个工作区', async () => {
    await write('outputs/x/doc.md', 'x')
    const pins = handlerFor('artifact:pins')
    const empty = await pins({}, {})
    expect(empty).toMatchObject({ ok: true, pins: [], totalBytes: 0 })

    const clear = handlerFor('artifact:pins:clear')
    expect(await clear({})).toMatchObject({ ok: true, removed: 0 })
  })
})
