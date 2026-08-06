/**
 * useWorkspaceVcs Hook 测试
 *
 * 验证提交差异列表与单文件 hunks 的懒加载接口。
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface VcsMock {
  ensureInit: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  statusDiff: ReturnType<typeof vi.fn>
  diff: ReturnType<typeof vi.fn>
  diffFile: ReturnType<typeof vi.fn>
  readFileAt: ReturnType<typeof vi.fn>
  rollback: ReturnType<typeof vi.fn>
  revertFile: ReturnType<typeof vi.fn>
  findCommitByConversation: ReturnType<typeof vi.fn>
}

/**
 * 创建满足 Hook 初始化与差异查询需求的 VCS mock。
 */
function createVcsMock(): VcsMock {
  return {
    ensureInit: vi.fn().mockResolvedValue({ ok: true }),
    commit: vi.fn(),
    log: vi.fn().mockResolvedValue({ success: true, data: [] }),
    statusDiff: vi.fn().mockResolvedValue({ success: true, data: [] }),
    diff: vi.fn(),
    diffFile: vi.fn(),
    readFileAt: vi.fn(),
    rollback: vi.fn(),
    revertFile: vi.fn(),
    findCommitByConversation: vi.fn(),
  }
}

/**
 * 在模块加载前注入 VCS API，确保 Hook 捕获当前测试的 mock。
 */
async function renderWorkspaceVcsHook(vcs: VcsMock) {
  vi.resetModules()
  ;(window as any).electronAPI = { ...(window as any).electronAPI, vcs }
  const { useWorkspaceVcs } = await import('../../renderer/hooks/business/useWorkspaceVcs/useWorkspaceVcs')
  return renderHook(() => useWorkspaceVcs())
}

describe('useWorkspaceVcs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('diffList 仅请求不含 hunks 的差异列表', async () => {
    const vcs = createVcsMock()
    const items = [{ filepath: 'src/a.ts', status: 'modified', insertions: 1, deletions: 0 }]
    vcs.diff.mockResolvedValue({ success: true, data: items })
    const { result } = await renderWorkspaceVcsHook(vcs)

    let received: unknown
    await act(async () => {
      received = await result.current.diffList('from', 'to')
    })

    expect(vcs.diff).toHaveBeenCalledWith({ fromOid: 'from', toOid: 'to', withHunks: false })
    expect(received).toEqual(items)
  })

  it('diffFile 通过单文件接口加载 hunks', async () => {
    const vcs = createVcsMock()
    const item = { filepath: 'src/a.ts', status: 'modified', insertions: 1, deletions: 0, hunks: [] }
    vcs.diffFile.mockResolvedValue({ success: true, data: item })
    const { result } = await renderWorkspaceVcsHook(vcs)

    let received: unknown
    await act(async () => {
      received = await result.current.diffFile('from', 'to', 'src/a.ts')
    })

    expect(vcs.diffFile).toHaveBeenCalledWith({ fromOid: 'from', toOid: 'to', filepath: 'src/a.ts' })
    expect(received).toEqual(item)
  })

  it('diffWithHunks 先取列表再逐文件加载 hunks', async () => {
    const vcs = createVcsMock()
    const items = [
      { filepath: 'src/a.ts', status: 'modified', insertions: 1, deletions: 0 },
      { filepath: 'src/b.ts', status: 'added', insertions: 2, deletions: 0 },
    ]
    const detailedItems = items.map((item) => ({ ...item, hunks: [] }))
    vcs.diff.mockResolvedValue({ success: true, data: items })
    vcs.diffFile
      .mockResolvedValueOnce({ success: true, data: detailedItems[0] })
      .mockResolvedValueOnce({ success: true, data: detailedItems[1] })
    const { result } = await renderWorkspaceVcsHook(vcs)

    let received: unknown
    await act(async () => {
      received = await result.current.diffWithHunks('from', 'to')
    })

    expect(vcs.diff).toHaveBeenCalledWith({ fromOid: 'from', toOid: 'to', withHunks: false })
    expect(vcs.diffFile).toHaveBeenNthCalledWith(1, { fromOid: 'from', toOid: 'to', filepath: 'src/a.ts' })
    expect(vcs.diffFile).toHaveBeenNthCalledWith(2, { fromOid: 'from', toOid: 'to', filepath: 'src/b.ts' })
    expect(received).toEqual(detailedItems)
  })
})
