/**
 * registerSyncConflictTool — cloud_sync_git 工具测试
 * 覆盖：工具注册 / action 路由（status/log/remote）/ 非法 action 错误 / manager 未就绪
 */

import { describe, it, expect, vi } from 'vitest'
import { registerSyncConflictTool } from './bridge-tool-registrar-sync'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

vi.mock('../cloud-sync/sync-accessor', () => ({
  getCloudSyncManager: vi.fn(),
}))

import { getCloudSyncManager } from '../cloud-sync/sync-accessor'

interface RegisteredTool {
  name: string
  execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>
}

function makeDeps() {
  const registered = new Map<string, RegisteredTool>()
  const deps = {
    toolContext: {},
    toolRegistry: {
      register: (tool: RegisteredTool) => {
        registered.set(tool.name, tool)
      },
    },
  } as unknown as BridgeToolRegistrarDeps
  return { deps, registered }
}

function parseText(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

describe('registerSyncConflictTool — cloud_sync_git', () => {
  it('注册 cloud_sync_git 工具', () => {
    const { deps, registered } = makeDeps()
    registerSyncConflictTool(deps)
    expect(registered.has('cloud_sync_git')).toBe(true)
  })

  it('manager 未就绪 → error', async () => {
    const { deps, registered } = makeDeps()
    vi.mocked(getCloudSyncManager).mockReturnValue(null as never)
    registerSyncConflictTool(deps)
    const tool = registered.get('cloud_sync_git')!
    const payload = parseText(await tool.execute('call-1', { action: 'status' }))
    expect(payload.status).toBe('error')
  })

  it('action=status → 路由到 gitStatus', async () => {
    const { deps, registered } = makeDeps()
    vi.mocked(getCloudSyncManager).mockReturnValue({
      gitStatus: async () => ({ initialized: true, state: 'idle', conflictFiles: [] }),
    } as never)
    registerSyncConflictTool(deps)
    const tool = registered.get('cloud_sync_git')!
    const payload = parseText(await tool.execute('call-1', { action: 'status' }))
    expect(payload.status).toBe('ok')
    expect(payload.initialized).toBe(true)
    expect(payload.state).toBe('idle')
  })

  it('action=log → 路由到 gitLog（带 limit）', async () => {
    const { deps, registered } = makeDeps()
    const gitLog = vi.fn(async () => ({ initialized: true, commits: [] }))
    vi.mocked(getCloudSyncManager).mockReturnValue({ gitLog } as never)
    registerSyncConflictTool(deps)
    const tool = registered.get('cloud_sync_git')!
    const payload = parseText(await tool.execute('call-1', { action: 'log', limit: 5 }))
    expect(gitLog).toHaveBeenCalledWith(5)
    expect(payload.status).toBe('ok')
  })

  it('action=remote → 路由到 gitRemote', async () => {
    const { deps, registered } = makeDeps()
    vi.mocked(getCloudSyncManager).mockReturnValue({
      gitRemote: async () => ({ reachable: true, headOid: 'abc123' }),
    } as never)
    registerSyncConflictTool(deps)
    const tool = registered.get('cloud_sync_git')!
    const payload = parseText(await tool.execute('call-1', { action: 'remote' }))
    expect(payload.status).toBe('ok')
    expect(payload.reachable).toBe(true)
  })
})

/**
 * 异步化：工具秒回，不等待落决完成。
 *
 * 此前同步等待会把 Agent 卡在工具调用里（300s 后拿到超时，而任务其实还在跑）
 * —— 2026-09-17 死循环的一环。
 */
describe('resolve_sync_conflict — 异步化（秒回）', () => {
  it('秒回 started —— 落决永不完成也不会卡住工具', async () => {
    const { deps, registered } = makeDeps()
    registerSyncConflictTool(deps)

    // 落决 promise 永不 settle：若工具 await 它，本测试会超时失败
    const resolveConflict = vi.fn(() => new Promise<{ success: boolean }>(() => {}))
    vi.mocked(getCloudSyncManager).mockReturnValue({
      isResolveInFlight: () => false,
      resolveConflict,
    } as never)

    const tool = registered.get('resolve_sync_conflict')!
    const payload = parseText(await tool.execute('call-1', { strategy: 'keep-local' }))

    expect(payload.status).toBe('started')
    expect(resolveConflict).toHaveBeenCalledWith('keep-local', undefined)
  })

  it('落决飞行中 → 秒回 running，不排队也不标错误', async () => {
    const { deps, registered } = makeDeps()
    registerSyncConflictTool(deps)

    const resolveConflict = vi.fn()
    vi.mocked(getCloudSyncManager).mockReturnValue({
      isResolveInFlight: () => true,
      resolveConflict,
    } as never)

    const tool = registered.get('resolve_sync_conflict')!
    const payload = parseText(await tool.execute('call-1', { strategy: 'keep-local' }))

    expect(payload.status).toBe('running')
    expect(resolveConflict).not.toHaveBeenCalled()
  })

  it('per-file 缺 choices → 参数校验报错', async () => {
    const { deps, registered } = makeDeps()
    registerSyncConflictTool(deps)
    vi.mocked(getCloudSyncManager).mockReturnValue({} as never)

    const tool = registered.get('resolve_sync_conflict')!
    const payload = parseText(await tool.execute('call-1', { strategy: 'per-file' }))

    expect(payload.status).toBe('error')
  })
})
