import { describe, expect, it, beforeEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

/** 每个用例独立数据根，避免相互污染 */
async function store() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-tool-usage-'))
  vi.doMock('./client-data-root', () => ({ resolveWindowsClientDataRoot: () => dir }))
  vi.resetModules()
  const mod = await import('./tool-usage-store')
  mod.__resetToolUsageCacheForTest()
  return { ...mod, dir }
}

beforeEach(() => {
  vi.resetModules()
  vi.doUnmock('./client-data-root')
})

describe('tool-usage-store', () => {
  it('累加调用次数并区分失败次数', async () => {
    const { recordToolUsage, getToolUsage } = await store()
    await recordToolUsage('file_read')
    await recordToolUsage('file_read')
    await recordToolUsage('file_read', true)

    const usage = await getToolUsage()
    expect(usage['file_read']?.count).toBe(3)
    expect(usage['file_read']?.errorCount).toBe(1)
    expect(usage['file_read']?.lastUsedAt).toBeGreaterThan(0)
  })

  it('未调用过的工具不出现在统计中', async () => {
    const { recordToolUsage, getToolUsage } = await store()
    await recordToolUsage('bash')
    const usage = await getToolUsage()
    expect(usage['web_search']).toBeUndefined()
  })

  it('MCP 工具按全名独立计数', async () => {
    const { recordToolUsage, getToolUsage } = await store()
    await recordToolUsage('mcp__ynote__createNote')
    await recordToolUsage('mcp__ynote__listNotes')
    await recordToolUsage('mcp__ynote__createNote')

    const usage = await getToolUsage()
    expect(usage['mcp__ynote__createNote']?.count).toBe(2)
    expect(usage['mcp__ynote__listNotes']?.count).toBe(1)
  })

  it('flush 后落盘，重新加载能读回计数', async () => {
    const { recordToolUsage, flushToolUsage, dir } = await store()
    await recordToolUsage('grep')
    await recordToolUsage('grep')
    await flushToolUsage()

    const raw = await fs.readFile(path.join(dir, 'usage', 'tool-usage.json'), 'utf-8')
    expect(JSON.parse(raw)['grep'].count).toBe(2)
  })

  it('文件损坏时退回空统计而不抛错', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-tool-usage-bad-'))
    await fs.mkdir(path.join(dir, 'usage'), { recursive: true })
    await fs.writeFile(path.join(dir, 'usage', 'tool-usage.json'), '{ not json', 'utf-8')

    vi.doMock('./client-data-root', () => ({ resolveWindowsClientDataRoot: () => dir }))
    vi.resetModules()
    const mod = await import('./tool-usage-store')
    mod.__resetToolUsageCacheForTest()

    await expect(mod.getToolUsage()).resolves.toEqual({})
  })

  it('空工具名不计数', async () => {
    const { recordToolUsage, getToolUsage } = await store()
    await recordToolUsage('')
    expect(await getToolUsage()).toEqual({})
  })
})
