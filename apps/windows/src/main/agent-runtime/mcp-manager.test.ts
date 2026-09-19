/**
 * `McpManager.disconnectAll` 的行为规格（应用退出路径）。
 *
 * 背景（2026-09-20 Linux 实测）：MCP Server 是独立子进程，`destroyAll()`
 * 不管它们，于是 `app.exit(0)` 之后子进程仍在跑、McpManager 仍在重连，
 * GPU watchdog 在窗口期判定失败并报 `FATAL: GPU process isn't usable`。
 * 这个方法是退出路径的一部分，契约值得锁住。
 *
 * 用桩对象而非真 McpStdioClient：这里要测的是**编排**（停哪些、失败怎么办、
 * 集合是否清空），不是 stdio 协议本身。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpManager } from './mcp-manager'

/** 最小可用的 client 桩：只需要 `stop()` */
function fakeClient() {
  return { stop: vi.fn(() => Promise.resolve()) }
}

function makeManager(clients: Map<string, unknown>) {
  const toolRegistry = { register: vi.fn(), unregister: vi.fn() }
  // 类型上 McpStdioClient 有更多成员，但这里只用到 stop()；测试关心的是编排
  const manager = new McpManager(
    toolRegistry as never,
    clients as never,
  )
  return { manager, toolRegistry }
}

describe('McpManager.disconnectAll', () => {
  let clients: Map<string, ReturnType<typeof fakeClient>>

  beforeEach(() => {
    clients = new Map()
  })

  it('停止所有已连接的 Server 并清空集合', async () => {
    const a = fakeClient()
    const b = fakeClient()
    clients.set('server-a', a)
    clients.set('server-b', b)
    const { manager } = makeManager(clients)

    await manager.disconnectAll()

    expect(a.stop).toHaveBeenCalledTimes(1)
    expect(b.stop).toHaveBeenCalledTimes(1)
    expect(clients.size).toBe(0)
  })

  it('没有连接时是空操作（不抛错）', async () => {
    const { manager } = makeManager(clients)
    await expect(manager.disconnectAll()).resolves.toBeUndefined()
  })

  it('清空 connecting 集合（退出后不应再有「连接中」状态）', async () => {
    const a = fakeClient()
    clients.set('server-a', a)
    const { manager } = makeManager(clients)

    // 模拟「该 Server 正卡在连接中」——应用退出时这必须被清掉，
    // 否则设置页仍显示「连接中」，且重连逻辑可能被再次触发
    ;(manager as unknown as { connecting: Set<string> }).connecting.add('server-a')

    await manager.disconnectAll()

    expect((manager as unknown as { connecting: Set<string> }).connecting.size).toBe(0)
  })

  it('重复调用是幂等的（退出路径可能被触发多次）', async () => {
    const a = fakeClient()
    clients.set('server-a', a)
    const { manager } = makeManager(clients)

    await manager.disconnectAll()
    await expect(manager.disconnectAll()).resolves.toBeUndefined()

    // 第二次没有 client 可停，不应再调用 stop
    expect(a.stop).toHaveBeenCalledTimes(1)
  })

  it('注销各 Server 注册的工具', async () => {
    const a = fakeClient()
    clients.set('server-a', a)
    const { manager, toolRegistry } = makeManager(clients)

    // 通过私有的 serverTools 模拟「该 Server 注册过这些工具」
    ;(manager as unknown as { serverTools: Map<string, string[]> }).serverTools.set(
      'server-a',
      ['tool_x', 'tool_y'],
    )

    await manager.disconnectAll()

    expect(toolRegistry.unregister).toHaveBeenCalledWith('tool_x')
    expect(toolRegistry.unregister).toHaveBeenCalledWith('tool_y')
  })
})

/**
 * 退出时**仍在连接中**的 Server（2026-09-20 真实冒烟查出的竞态）。
 *
 * 实测时序：`[connect] 连接 MCP Server: smoke-stub`（启动期发出）→
 * `应用即将退出` → `disconnectAll 正在停止 0 个 MCP Server` →
 * **`[connect] ... 已连接，加载 1 个工具`**——连接在清理之后才落地。
 *
 * 竞态窗口在 `connect()` 内部：client 对象要到 `await client.start()` 返回后才写进
 * `mcpClients`，而 `disconnect()` 只从 `mcpClients` 里取 client。于是卡在握手期的
 * 那个 client 谁都够不到——`disconnectAll` 数不到它，`unregisterTools` 也够不到它。
 * 它带着一个已 spawn 的子进程活过清理，与本次修复要解决的问题同类。
 */
describe('McpManager.disconnectAll（连接中竞态）', () => {
  let clients: Map<string, ReturnType<typeof fakeClient>>

  beforeEach(() => {
    clients = new Map()
  })

  it('停掉仍在连接中的 client（不能只看 mcpClients）', async () => {
    // 模拟「client 已 spawn、握手未完成」：它还没进 mcpClients，
    // 但 connect() 手上已经握着它，并登记在 connecting 里
    const inFlight = fakeClient()
    const { manager } = makeManager(clients)
    const internals = manager as unknown as {
      connecting: Set<string>
      inFlightClients: Map<string, { stop: () => Promise<void> }>
    }
    internals.connecting.add('server-a')
    internals.inFlightClients.set('server-a', inFlight)

    await manager.disconnectAll()

    expect(inFlight.stop).toHaveBeenCalledTimes(1)
    expect(internals.connecting.size).toBe(0)
    expect(internals.inFlightClients.size).toBe(0)
  })

  it('退出后不再发起新连接（load 循环与重连都必须停下）', async () => {
    const { manager } = makeManager(clients)
    // 冒烟实测：清理之后 load() 仍在往下连（`[connect] 连接 MCP Server: excel-mcp`）。
    // 真实配置有 6 个启用的 Server，等于退出后还要陆续 spawn 5 个子进程。
    await manager.disconnectAll()

    await (
      manager as unknown as { connect: (c: unknown, r?: number) => Promise<void> }
    ).connect({ name: 'late-server', command: 'node', args: [] })

    // 没有新 client 被登记——connect() 在起手就该放弃
    expect(clients.size).toBe(0)
    expect(
      (manager as unknown as { inFlightClients: Map<string, unknown> }).inFlightClients.size,
    ).toBe(0)
  })
})
