/**
 * memory_manage 的读取作用域与时间窗枚举（2026-09-15）
 *
 * 背景：汇总类 Agent（chronicler，definition.memory.scope === "user"）必须跨 Agent
 * 读到用户在主 Agent 里积累的工作记忆，否则日报永远「工作记忆为空」——2026-09-14/15
 * 两天的日报就是这么静默失败的。同时汇总任务需要按时间窗取全量，不能走 top-N 截断。
 */
import { describe, expect, it, vi } from 'vitest'
import { registerClientCommandTools } from './bridge-tool-registrar-client-cmd'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

interface RegisteredTool {
  name: string
  execute: (id: string, params: unknown) => Promise<unknown>
}

function makeMemoryManager() {
  return {
    listActive: vi.fn(() => [{ id: 'own-1', category: 'project', content: '本 Agent 的记忆' }]),
    listActiveAllAgents: vi.fn(() => [
      { id: 'other-1', category: 'project', content: '主 Agent 记的用户工作' },
    ]),
    listByWindow: vi.fn(() => ({
      entries: [
        {
          id: 'w-1',
          category: 'project',
          importance: 0.5,
          created_at: '2026-09-15T10:00:00.000Z',
          last_used: '2026-09-15T10:00:00.000Z',
          content: '今天的低重要度条目',
        },
      ],
      total: 42,
      hasMore: true,
    })),
    addMemory: vi.fn(() => ({ id: 'new-1', category: 'general' })),
  }
}

function makeHarness(opts: { readScope: 'agent' | 'user'; memoryManager: ReturnType<typeof makeMemoryManager> }) {
  const tools = new Map<string, RegisteredTool>()
  const deps = {
    toolRegistry: { register: (t: RegisteredTool) => tools.set(t.name, t) },
    toolContext: {},
    ipcChannel: { forwardIpcEvent: vi.fn() },
    getConversationRepo: () => null,
    getMemoryManager: () => opts.memoryManager,
    toolCallInstanceMap: new Map([['call-1', 'inst-1']]),
    getCurrentToolExecutorInstanceId: () => 'inst-1',
    getDefinitionIdByInstanceId: () => 'chronicler',
    getMemoryReadScopeByInstanceId: () => opts.readScope,
    instanceToConversation: new Map<string, string>(),
  } as unknown as BridgeToolRegistrarDeps
  registerClientCommandTools(deps, {} as never)
  const tool = tools.get('memory_manage')
  if (!tool) throw new Error('memory_manage not registered')
  return tool
}

async function invoke(tool: RegisteredTool, params: unknown): Promise<Record<string, unknown>> {
  const result = (await tool.execute('call-1', params)) as { content: Array<{ text: string }> }
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

describe('memory_manage list 的读取作用域', () => {
  it('scope=user：跨 Agent 读该用户的全部工作记忆（汇总类 Agent 的关键路径）', async () => {
    const mm = makeMemoryManager()
    const tool = makeHarness({ readScope: 'user', memoryManager: mm })

    const out = await invoke(tool, { action: 'list' })

    expect(mm.listActiveAllAgents).toHaveBeenCalledWith('local-user')
    expect(mm.listActive).not.toHaveBeenCalled()
    expect(out.scope).toBe('user')
    expect(out.count).toBe(1)
  })

  it('scope=agent：保持既有隔离行为', async () => {
    const mm = makeMemoryManager()
    const tool = makeHarness({ readScope: 'agent', memoryManager: mm })

    const out = await invoke(tool, { action: 'list' })

    expect(mm.listActive).toHaveBeenCalledWith('chronicler', 'local-user')
    expect(mm.listActiveAllAgents).not.toHaveBeenCalled()
    expect(out.scope).toBe('agent')
  })
})

describe('memory_manage window 时间窗枚举', () => {
  it('按 days 折算 since，透传 scope，并返回分页元信息', async () => {
    const mm = makeMemoryManager()
    const tool = makeHarness({ readScope: 'user', memoryManager: mm })

    const before = Date.now()
    const out = await invoke(tool, { action: 'window', days: 7, limit: 50, offset: 100 })

    expect(mm.listByWindow).toHaveBeenCalledTimes(1)
    const arg = mm.listByWindow.mock.calls[0]![0] as {
      userId: string
      agentId: string
      scope: string
      since: string
      limit: number
      offset: number
    }
    expect(arg.userId).toBe('local-user')
    expect(arg.agentId).toBe('chronicler')
    expect(arg.scope).toBe('user')
    expect(arg.limit).toBe(50)
    expect(arg.offset).toBe(100)
    // days=7 → since ≈ 7 天前
    const sinceMs = new Date(arg.since).getTime()
    expect(before - sinceMs).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000)
    expect(before - sinceMs).toBeLessThanOrEqual(7 * 86_400_000 + 1000)

    // 分页元信息随结果透出，供调用方翻页取全量
    expect(out.total).toBe(42)
    expect(out.count).toBe(1)
    expect(out.hasMore).toBe(true)
  })

  it('显式 since 覆盖 days（用于「自上次 daily 以来」）', async () => {
    const mm = makeMemoryManager()
    const tool = makeHarness({ readScope: 'user', memoryManager: mm })

    await invoke(tool, { action: 'window', days: 7, since: '2026-09-14T00:00:00.000Z' })

    const arg = mm.listByWindow.mock.calls[0]![0] as { since: string }
    expect(arg.since).toBe('2026-09-14T00:00:00.000Z')
  })

  it('缺省 days=1', async () => {
    const mm = makeMemoryManager()
    const tool = makeHarness({ readScope: 'agent', memoryManager: mm })

    const before = Date.now()
    await invoke(tool, { action: 'window' })

    const arg = mm.listByWindow.mock.calls[0]![0] as { since: string; scope: string }
    const sinceMs = new Date(arg.since).getTime()
    expect(before - sinceMs).toBeGreaterThanOrEqual(86_400_000 - 1000)
    expect(before - sinceMs).toBeLessThanOrEqual(86_400_000 + 1000)
    expect(arg.scope).toBe('agent')
  })
})

describe('memory_manage 写操作始终归属当前 Agent', () => {
  it('scope=user 时 add 仍按 agentId 写入（读共享，写归属）', async () => {
    const mm = makeMemoryManager()
    const tool = makeHarness({ readScope: 'user', memoryManager: mm })

    await invoke(tool, { action: 'add', content: '一条新记忆', category: 'project' })

    expect(mm.addMemory).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'chronicler', userId: 'local-user' }),
    )
  })
})
