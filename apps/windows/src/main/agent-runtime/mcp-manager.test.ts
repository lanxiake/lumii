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
