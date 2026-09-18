/**
 * memory_search 的三通道分段返回（2026-09-17，评审 P0-1）
 *
 * 背景：`memory_search` 此前**从不查 `agent_memories`**——只有 MemPalace（未安装时跳过）
 * 与两个 Markdown 文件的降级匹配。结果是 Agent 每轮只能看见注入的 6 条热记忆，
 * 其余 200+ 条毫无通道（实测 229 条可达记忆，palace 覆盖率 2%）。
 *
 * 本测试锁三件事：
 * 1. 工作记忆通道被调用，且带上正确的 agentId / userId / scope
 * 2. 结果带 `provider` 与 `id`，供模型区分来源并回接 memory_manage
 * 3. 通道按 limit 配额分段返回——工作记忆占满后不再走后续通道
 */
import { describe, expect, it, vi } from 'vitest'
import { registerIntegrationTools } from './bridge-tool-registrar-integration'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

vi.mock('./scene-memory-store', () => ({
  listScenes: vi.fn(async () => []),
  readSceneMemory: vi.fn(async () => undefined),
  resolveSceneFilePath: vi.fn(() => ''),
  findProject: vi.fn(() => undefined),
  loadRegistry: vi.fn(async () => ({ projects: [] })),
  registerProject: vi.fn(),
  writeSceneMemory: vi.fn(),
}))
vi.mock('../client-data-root', () => ({
  resolveWindowsClientDataRoot: () => 'C:/tmp/lumii-test-root',
}))

interface RegisteredTool {
  name: string
  execute: (id: string, params: unknown) => Promise<unknown>
}

function makeMemoryManager(results: Array<{ id: string; content: string; category: string }>) {
  return {
    searchMemories: vi.fn(() => results),
  }
}

function makeHarness(opts: {
  readScope?: 'agent' | 'user'
  memoryManager: ReturnType<typeof makeMemoryManager> | null
  searchPalace?: (query: string, limit?: number, scope?: unknown) => Promise<unknown>
  userMemory?: string
  /** 注入指针：memory_search 会把它们钉进检索、并给命中的打 already_injected */
  pinnedDrawerIds?: readonly string[]
  injectedMemories?: Array<{ id: string }>
  /** 宫殿读入口；不传时视为「后端不可用」，与线上 config 缺省一致 */
  readPalaceDrawer?: (id: string) => Promise<unknown>
}) {
  const tools = makeTools(opts)
  const tool = tools.get('memory_search')
  if (!tool) throw new Error('memory_search not registered')
  return tool
}

/** 与 `makeHarness` 同源，但返回**全部**已注册工具（用于对照两个入口是否同实现） */
function toolsIn(opts: Parameters<typeof makeHarness>[0]): Map<string, RegisteredTool> {
  return makeTools(opts)
}

function makeTools(opts: Parameters<typeof makeHarness>[0]): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>()
  const deps = {
    toolRegistry: { register: (t: RegisteredTool) => tools.set(t.name, t) },
    toolContext: {},
    config: {
      searchPalace: opts.searchPalace,
      readPalaceDrawer: opts.readPalaceDrawer,
      getUserMemory: async () => ({ content: opts.userMemory ?? '', updatedAt: '2026-09-17T00:00:00.000Z' }),
    },
    localDb: { db: { prepare: () => ({ all: () => [] }) } },
    ipcChannel: { forwardIpcEvent: vi.fn() },
    getChannelRouter: () => null,
    getMemoryManager: () => opts.memoryManager,
    getConversationRepo: () => null,
    toolCallInstanceMap: new Map([['call-1', 'inst-1']]),
    getCurrentToolExecutorInstanceId: () => 'inst-1',
    getDefinitionIdByInstanceId: () => 'assistant',
    getMemoryReadScopeByInstanceId: () => opts.readScope ?? 'agent',
    getPinnedDrawerIdsByInstanceId: () => opts.pinnedDrawerIds ?? [],
    agentRegistry: {
      get: () => ({ injectedMemories: opts.injectedMemories ?? [] }),
    },
    instanceToConversation: new Map<string, string>(),
    instanceStates: { get: () => undefined },
  } as unknown as BridgeToolRegistrarDeps
  registerIntegrationTools(deps)
  return tools
}

async function invoke(tool: RegisteredTool, params: unknown): Promise<Record<string, unknown>> {
  const result = (await tool.execute('call-1', params)) as { content: Array<{ text: string }> }
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

describe('memory_search · 工作记忆通道', () => {
  it('查询工作记忆并带 provider/id（此前从不查该表）', async () => {
    const mm = makeMemoryManager([
      { id: 'm-1', content: '某条只存在于 agent_memories 的事实', category: 'reference' },
    ])
    const tool = makeHarness({ memoryManager: mm })

    const out = await invoke(tool, { query: '那条事实' })

    expect(mm.searchMemories).toHaveBeenCalledWith('assistant', 'local-user', '那条事实', 10, 'agent')
    const results = out.results as Array<Record<string, unknown>>
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      provider: 'work-memory',
      id: 'm-1',
      category: 'reference',
    })
    expect(out.providers).toMatchObject({ workMemory: 1 })
  })

  it('MemPalace 未配置时工作记忆通道照常工作（不再整体降级为文件 grep）', async () => {
    const mm = makeMemoryManager([{ id: 'm-2', content: '工作记忆命中', category: 'general' }])
    const tool = makeHarness({ memoryManager: mm })

    const out = await invoke(tool, { query: '命中' })

    const results = out.results as Array<Record<string, unknown>>
    expect(results.map((r) => r.provider)).toEqual(['work-memory'])
  })

  it('透传读作用域（汇总型 Agent 跨 Agent 检索）', async () => {
    const mm = makeMemoryManager([])
    const tool = makeHarness({ memoryManager: mm, readScope: 'user' })

    await invoke(tool, { query: '任意' })

    expect(mm.searchMemories).toHaveBeenCalledWith('assistant', 'local-user', '任意', 10, 'user')
  })

  it('工作记忆占满 limit 时，后续通道不再追加（通道配额分段返回）', async () => {
    const mm = makeMemoryManager(
      Array.from({ length: 3 }, (_, i) => ({ id: `m-${i}`, content: `工作记忆 ${i}`, category: 'general' })),
    )
    const searchPalace = vi.fn(async () => [
      { text: '宫殿命中', wing: 'w', room: 'r', score: -1.5, drawer_id: 'a'.repeat(16) },
    ])
    const tool = makeHarness({ memoryManager: mm, searchPalace, userMemory: '工作记忆 0 的行' })

    const out = await invoke(tool, { query: '工作记忆', maxResults: 3 })

    expect(searchPalace).not.toHaveBeenCalled()
    const results = out.results as Array<Record<string, unknown>>
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.provider === 'work-memory')).toBe(true)
  })

  it('memoryManager 缺失时不报错，其他通道仍可用', async () => {
    const searchPalace = vi.fn(async () => [
      { text: '宫殿命中', wing: 'w', room: 'r', score: -1.5, drawer_id: 'b'.repeat(16) },
    ])
    const tool = makeHarness({ memoryManager: null, searchPalace })

    const out = await invoke(tool, { query: '命中' })

    const results = out.results as Array<Record<string, unknown>>
    expect(results[0]).toMatchObject({ provider: 'palace', drawer_id: 'b'.repeat(16) })
  })

  it('三通道都无命中时返回 provider=none 与空数组', async () => {
    const tool = makeHarness({ memoryManager: makeMemoryManager([]), userMemory: '' })

    const out = await invoke(tool, { query: 'zzz-无命中-zzz' })

    expect(out.results).toEqual([])
    expect(out.provider).toBe('none')
  })
})

describe('memory_search · 宫殿通道（自建 SQLite）', () => {
  it('带作用域调用，命中标 provider=palace 并透出摘录标记', async () => {
    const searchPalace = vi.fn(async () => [
      {
        text: '…这段在讲工单同步卡点…',
        wing: 'assistant:local-user',
        room: '2026-09-17',
        score: 3.2,
        drawer_id: 'c'.repeat(16),
        char_count: 94473,
        truncated: true,
      },
    ])
    const tool = makeHarness({ memoryManager: makeMemoryManager([]), searchPalace })

    const out = await invoke(tool, { query: '工单同步' })

    expect(searchPalace).toHaveBeenCalledWith('工单同步', 10, {
      userId: 'local-user',
      agentId: 'assistant',
    })
    const results = out.results as Array<Record<string, unknown>>
    expect(results[0]).toMatchObject({
      provider: 'palace',
      drawer_id: 'c'.repeat(16),
      score: 3.2,
      char_count: 94473,
      truncated: true,
    })
    expect((out.providers as Record<string, number>).palace).toBe(1)
  })

  it('user 读作用域下不收窄 agent（与工作记忆通道同规则）', async () => {
    const searchPalace = vi.fn(async () => [])
    const tool = makeHarness({
      memoryManager: makeMemoryManager([]),
      searchPalace,
      readScope: 'user',
    })

    await invoke(tool, { query: '任意' })

    expect(searchPalace).toHaveBeenCalledWith('任意', 10, { userId: 'local-user' })
  })

  it('后端不可用（返回 null）时静默跳过，不影响其他通道', async () => {
    const searchPalace = vi.fn(async () => null)
    const mm = makeMemoryManager([{ id: 'm-1', content: '工作记忆命中', category: 'general' }])
    const tool = makeHarness({ memoryManager: mm, searchPalace })

    const out = await invoke(tool, { query: '命中' })

    const results = out.results as Array<Record<string, unknown>>
    expect(results.map((r) => r.provider)).toEqual(['work-memory'])
  })

  it('宫殿通道抛异常时被兜住，工作记忆结果照常返回', async () => {
    const searchPalace = vi.fn(async () => {
      throw new Error('database is locked')
    })
    const mm = makeMemoryManager([{ id: 'm-1', content: '工作记忆命中', category: 'general' }])
    const tool = makeHarness({ memoryManager: mm, searchPalace })

    const out = await invoke(tool, { query: '命中' })

    expect((out.results as unknown[]).length).toBe(1)
  })
})

/**
 * 注入指针的钉入（2026-09-18）。
 *
 * 实测：`tocc-sync` 那条原文在 bigram 检索里排 52/608，而候选池只取 30 条——
 * 它**从没进过结果**。模型搜完找不到它，就读了别的抽屉并拿它作答（3/3 全错）。
 * 这组用例锁住两件事：指针确实传给了检索层，且**已注入的排在末尾并打标**。
 */
describe('memory_search · 注入指针钉入', () => {
  it('把本轮注入的指针透传给宫殿检索（钉入才有得钉）', async () => {
    const searchPalace = vi.fn(async () => [])
    const tool = makeHarness({
      memoryManager: makeMemoryManager([]),
      searchPalace,
      pinnedDrawerIds: ['a'.repeat(16), 'b'.repeat(16)],
    })

    await invoke(tool, { query: '工单同步' })

    expect(searchPalace).toHaveBeenCalledWith('工单同步', 10, {
      userId: 'local-user',
      agentId: 'assistant',
      pinnedIds: ['a'.repeat(16), 'b'.repeat(16)],
    })
  })

  it('无注入指针时不传 pinnedIds（不给检索层添无意义的参数）', async () => {
    const searchPalace = vi.fn(async () => [])
    const tool = makeHarness({ memoryManager: makeMemoryManager([]), searchPalace })

    await invoke(tool, { query: '任意' })

    expect(searchPalace).toHaveBeenCalledWith('任意', 10, {
      userId: 'local-user',
      agentId: 'assistant',
    })
  })

  it('已注入的宫殿命中排到末尾并打 already_injected（不挤掉新命中）', async () => {
    const injected = 'a'.repeat(16)
    const searchPalace = vi.fn(async () => [
      { text: '注入那条的摘录', wing: 'w', room: 'r', score: 9.9, drawer_id: injected },
      { text: '别的新命中', wing: 'w', room: 'r', score: 1.2, drawer_id: 'b'.repeat(16) },
    ])
    const tool = makeHarness({
      memoryManager: makeMemoryManager([]),
      searchPalace,
      pinnedDrawerIds: [injected],
    })

    const out = await invoke(tool, { query: '任意' })
    const results = out.results as Array<Record<string, unknown>>

    // 分数更高（9.9）但已注入 → 仍然排在后
    expect(results.map((r) => r.drawer_id)).toEqual(['b'.repeat(16), injected])
    expect(results[0]!.already_injected).toBeUndefined()
    expect(results[1]!.already_injected).toBe(true)
  })

  it('已注入的工作记忆条目不再回一份（注入层已在眼前，重复只占席位）', async () => {
    const mm = makeMemoryManager([
      { id: 'm-injected', content: '已经在提示词里的那条', category: 'project' },
      { id: 'm-fresh', content: '没注入过的新条目', category: 'project' },
    ])
    const tool = makeHarness({ memoryManager: mm, injectedMemories: [{ id: 'm-injected' }] })

    const out = await invoke(tool, { query: '条目' })
    const results = out.results as Array<Record<string, unknown>>

    expect(results.map((r) => r.id)).toEqual(['m-fresh'])
  })
})

/**
 * 工具入口合并（2026-09-18）：`memory_search(drawerId=…)` 与 `memory_read` 是同一个实现。
 *
 * 合并的动机不是"少一个工具"，是消除一条实测确认的失败路径：两个工具并存时，
 * 模型手里明明有 `[d:xxxx]` 指针，也常去搜一遍、搜到"差不多"的条目就不再回来读
 * 那条原文（3/3 全错）。合并后 `drawerId` 一给就是直读全文，没有"先搜再读"这个
 * 多余动作可做。
 *
 * 两个名字共用 `readDrawerResult`，所以**容错与错误措辞必须一致**——各写一份会漂移，
 * 而格式容错正是模型最容易踩的地方（实测传过 `d:xxxx`、`[d:xxx` 缺右括号）。
 */
describe('memory_search · drawerId 直读（与 memory_read 同一实现）', () => {
  const drawer = {
    drawer_id: 'a'.repeat(16),
    wing: 'conversations',
    room: 'conv-1',
    content: '归档原文',
    metadata: {},
  }

  it('传 drawerId 时直读全文，不触发检索', async () => {
    const searchPalace = vi.fn(async () => [])
    const readPalaceDrawer = vi.fn(async () => drawer)
    const tool = makeHarness({
      memoryManager: makeMemoryManager([]),
      searchPalace,
      readPalaceDrawer,
    })

    const out = await invoke(tool, { drawerId: 'a'.repeat(16) })

    expect(out).toMatchObject({ ok: true, drawerId: 'a'.repeat(16), provider: 'palace' })
    expect(searchPalace).not.toHaveBeenCalled()
  })

  it('不带 drawerId 时照常检索（两种用法共用一个入口）', async () => {
    const searchPalace = vi.fn(async () => [])
    const readPalaceDrawer = vi.fn(async () => drawer)
    const tool = makeHarness({
      memoryManager: makeMemoryManager([{ id: 'm-1', content: '命中', category: 'general' }]),
      searchPalace,
      readPalaceDrawer,
    })

    const out = await invoke(tool, { query: '命中' })

    expect((out.results as unknown[]).length).toBe(1)
    expect(readPalaceDrawer).not.toHaveBeenCalled()
  })

  it('两个参数都缺时报错并说明原因', async () => {
    const tool = makeHarness({ memoryManager: makeMemoryManager([]) })

    const out = await invoke(tool, {})

    expect(out.status).toBe('error')
    expect(String(out.message)).toContain('drawerId')
  })

  it('drawerId 容错与 memory_read 一致（传 `d:xxx` 也能读到）', async () => {
    const readPalaceDrawer = vi.fn(async (id: string) => (id === 'b'.repeat(16) ? drawer : null))
    const tool = makeHarness({ memoryManager: makeMemoryManager([]), readPalaceDrawer })

    const out = await invoke(tool, { drawerId: `d:${'b'.repeat(16)}` })

    expect(out.ok).toBe(true)
    expect(readPalaceDrawer).toHaveBeenCalledWith('b'.repeat(16))
  })

  it('两个入口的错误措辞一致（不同的模型写法都得到同一套自我纠正提示）', async () => {
    const opts = { memoryManager: makeMemoryManager([]), readPalaceDrawer: async () => null }
    const viaSearch = await invoke(makeHarness(opts), { drawerId: 'f'.repeat(16) })
    const readTool = toolsIn(opts).get('memory_read')
    if (!readTool) throw new Error('memory_read not registered')

    const viaLegacy = await invoke(readTool, { drawerId: 'f'.repeat(16) })

    expect(viaSearch.ok).toBe(false)
    expect(viaSearch.message).toEqual(viaLegacy.message)
    expect(String(viaSearch.message)).toContain('裸 id')
  })
})

/**
 * memory_read · drawerId 容错（2026-09-18）。
 *
 * 实测：模型把注入的指针 `[d:060cdafe2bdab28a]` 传成 `d:060cdafe2bdab28a`（少了方括号），
 * 直接报 `ok:false 未找到该 drawer`，整条回溯链路断在一次格式笔误上。
 * 指针是**我们自己注入给模型的**，它写得不对不该让回溯失败——剥一次就是了。
 */
describe('memory_read · drawerId 容错', () => {
  function makeReadHarness(known: string[]) {
    const tools = new Map<string, RegisteredTool>()
    const readPalaceDrawer = vi.fn(async (id: string) =>
      known.includes(id)
        ? { drawer_id: id, content: `原文-${id}`, wing: 'w', room: 'r', metadata: {} }
        : null,
    )
    const deps = {
      toolRegistry: { register: (t: RegisteredTool) => tools.set(t.name, t) },
      toolContext: {},
      config: { readPalaceDrawer },
      localDb: { db: { prepare: () => ({ all: () => [] }) } },
      ipcChannel: { forwardIpcEvent: vi.fn() },
      getChannelRouter: () => null,
      getMemoryManager: () => null,
      getConversationRepo: () => null,
      toolCallInstanceMap: new Map(),
      getCurrentToolExecutorInstanceId: () => undefined,
      instanceToConversation: new Map<string, string>(),
      instanceStates: { get: () => undefined },
    } as unknown as BridgeToolRegistrarDeps
    registerIntegrationTools(deps)
    const tool = tools.get('memory_read')
    if (!tool) throw new Error('memory_read not registered')
    return { tool, readPalaceDrawer }
  }

  const ID = '060cdafe2bdab28a'

  it('裸 id 正常读', async () => {
    const { tool } = makeReadHarness([ID])
    const out = await invoke(tool, { drawerId: ID })
    expect(out.ok).toBe(true)
    expect(out.drawerId).toBe(ID)
  })

  it('传成 `d:xxx`（实测的写法）也能读到', async () => {
    const { tool } = makeReadHarness([ID])
    const out = await invoke(tool, { drawerId: `d:${ID}` })
    expect(out.ok).toBe(true)
    expect(out.drawerId).toBe(ID)
  })

  it('传成完整指针 `[d:xxx]` 也能读到', async () => {
    const { tool } = makeReadHarness([ID])
    const out = await invoke(tool, { drawerId: `[d:${ID}]` })
    expect(out.ok).toBe(true)
    expect(out.drawerId).toBe(ID)
  })

  it('容错只剥格式，不改写 id 本身——不存在的 id 仍然如实报错', async () => {
    const { tool } = makeReadHarness([ID])
    const out = await invoke(tool, { drawerId: 'd:deadbeefdeadbeef' })
    expect(out.ok).toBe(false)
    expect(String(out.message)).toContain('只传裸 id')
  })

  it('第一次失败后才重试（正常 id 不会触发二次查询）', async () => {
    const { tool, readPalaceDrawer } = makeReadHarness([ID])
    await invoke(tool, { drawerId: ID })
    expect(readPalaceDrawer).toHaveBeenCalledTimes(1)
  })
})
