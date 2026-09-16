/**
 * 回归：MemPalace MCP 子进程崩溃，不能把整个客户端带走。
 *
 * 线上故障（docs/temp/错误日志.log）：Python 子进程 access violation 挂掉后，
 * 主进程那笔写到它 stdin 的请求拿到 "write EOF"；stdin 上没有 'error' 监听，
 * 事件抛成 uncaughtException，被主进程全局兜底判定为致命并 process.exit(1)。
 *
 * 注意不能用 `vi.mock('child_process')` 注入：被 vite externalize 的 builtin
 * 只在测试文件自身的 import 上被 mock，SUT 模块内部的 import 走的是真 spawn。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { MemPalaceMcpBridge, toPalaceName } from '../../main/mempalace-mcp-client'
import { bigPayload, rejectionOf, settle, spawnFakeChild, trackUncaughtExceptions } from './fake-child-process'

/** 借私有成员注入假子进程（attachChildHandlers 就是生产用的那处挂载） */
interface BridgeInternals {
  proc: ChildProcess | null
  pendingCalls: Map<number, unknown>
  attachChildHandlers: (proc: ChildProcess) => void
}

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children) child.kill()
  children.length = 0
})

describe('MemPalaceMcpBridge 子进程崩溃', () => {
  it('写入挂在管道上时子进程死亡：调用被拒绝、无未捕获错误、调度重启', async () => {
    const uncaught = trackUncaughtExceptions()
    const warned: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '))
    })
    try {
      const bridge = new MemPalaceMcpBridge('C:/fake/python.exe', 'C:/fake/palace')
      const internals = bridge as unknown as BridgeInternals
      const child = spawnFakeChild(spawn, 'stall')
      children.push(child)
      internals.proc = child
      internals.attachChildHandlers(child) // 生产同款挂载

      // #1：让子进程停读 stdin；#2：远超管道缓冲（64KB），写入只能挂着
      const first = bridge.callTool('mempalace_add_drawer', { content: 'small', wing: 'w', room: 'r' })
      const second = bridge.callTool('mempalace_add_drawer', {
        content: bigPayload(),
        wing: 'w',
        room: 'r',
      })
      await settle(150) // 等子进程读到 #1 并 stall
      child.kill() // 模拟崩溃

      const reasons = await Promise.all([rejectionOf(first), rejectionOf(second)])
      await settle()

      // 关键：这次挂起的写入确实走到了 EOF 那条路径（而不是被管道缓冲吞掉）
      expect(reasons.some((r) => r.includes('write EOF'))).toBe(true)
      // 两个调用都被干净拒绝，而不是悬挂到 30s 超时
      expect(reasons.every((r) => /write EOF|MCP 进程已退出/.test(r))).toBe(true)
      // 回归本体：没有未捕获错误（线上就是它触发 process.exit(1)）
      expect(uncaught.errors).toEqual([])
      // 状态复位 + 已调度重启（重启逻辑即自愈路径）
      expect(internals.proc).toBeNull()
      expect(internals.pendingCalls.size).toBe(0)
      expect(warned.some((w) => w.includes('进程退出'))).toBe(true)
      expect(warned.some((w) => w.includes('后重启'))).toBe(true)
      expect(uncaught.errors).toEqual([])
    } finally {
      warnSpy.mockRestore()
      uncaught.stop()
    }
  }, 30_000)
})

describe('MemPalaceMcpBridge.addDrawer 返回值校验', () => {
  /**
   * mempalace 的写工具用返回值报错，而不是抛异常：写入失败是 `{success:false,error}`，
   * collection 打不开时是裸 `{error}`——两者在 JSON-RPC 层都是成功响应。
   * 调用方不校验 success 就会把失败记成「记忆已写入」：2026-09-15 排查中，
   * 子进程整天在 chroma upsert 上崩溃的同期，日志仍报出 100 次写入成功，
   * 而宫殿里 0 条新数据，故障因此被掩盖。
   *
   * 这里只桩掉传输层：被测对象是「返回值 → 成败」这段判定，
   * 真实子进程的请求/响应链路由上面的崩溃回归覆盖。
   */
  const params = { wing: 'conversations', room: 'conv-1', content: '正文', addedBy: 'mtbot-windows' }

  function bridgeReturning(result: unknown): MemPalaceMcpBridge {
    const bridge = new MemPalaceMcpBridge('C:/fake/python.exe', 'C:/fake/palace')
    vi.spyOn(bridge, 'callTool').mockResolvedValue(result)
    return bridge
  }

  it('success:false 时抛错（Python 侧写入失败的形态）', async () => {
    const bridge = bridgeReturning({
      success: false,
      error: 'Idempotency check failed before write: boom',
    })
    await expect(bridge.addDrawer(params)).rejects.toThrow(/Idempotency check failed/)
  })

  it('裸 error 字典抛错（collection 打不开的形态）', async () => {
    const bridge = bridgeReturning({ error: 'No palace found', hint: 'Run: mempalace init <dir>' })
    await expect(bridge.addDrawer(params)).rejects.toThrow(/No palace found/)
  })

  it('缺少 success 标记时抛错，不当作成功', async () => {
    const bridge = bridgeReturning({ drawer_id: 'drawer_x' })
    await expect(bridge.addDrawer(params)).rejects.toThrow(/未返回 success 标记/)
  })

  it('callTool 没有返回内容时抛错', async () => {
    const bridge = bridgeReturning(null)
    await expect(bridge.addDrawer(params)).rejects.toThrow(/未返回结果/)
  })

  it('success:true 时返回 drawer_id', async () => {
    const bridge = bridgeReturning({
      success: true, drawer_id: 'drawer_ok', wing: 'conversations', room: 'conv-1', chunks: 1,
    })
    await expect(bridge.addDrawer(params)).resolves.toMatchObject({ drawer_id: 'drawer_ok' })
  })

  it('内容已存在（already_exists）同样算成功', async () => {
    const bridge = bridgeReturning({ success: true, reason: 'already_exists', drawer_id: 'drawer_dup' })
    await expect(bridge.addDrawer(params)).resolves.toMatchObject({ drawer_id: 'drawer_dup' })
  })

  /**
   * 应用里的标识带 `:`（会话 id 是渠道前缀制、段归档的 wing 是 `agent:user`），
   * 而 mempalace 拒收——必须归一后再发出去。见 toPalaceName 的说明。
   */
  it('wing/room 归一后再发给 mempalace_add_drawer', async () => {
    const bridge = new MemPalaceMcpBridge('C:/fake/python.exe', 'C:/fake/palace')
    const callTool = vi
      .spyOn(bridge, 'callTool')
      .mockResolvedValue({ success: true, drawer_id: 'drawer_ok' })

    await bridge.addDrawer({
      wing: 'assistant:local-user',
      room: 'cron:news-pipeline',
      content: '正文',
      addedBy: 'mtbot-windows',
      sourceFile: 'segment:seg-1',
    })

    expect(callTool).toHaveBeenCalledWith('mempalace_add_drawer', {
      wing: 'assistant_local-user',
      room: 'cron_news-pipeline',
      content: '正文',
      added_by: 'mtbot-windows',
      source_file: 'segment:seg-1',
    })
  })

  /**
   * 正文也有两条硬规矩（mempalace.config.sanitize_content）：含 NUL 字节拒收，
   * 超过 10 万字符拒收——同样是返回值报错，不处理就整条内容进不了宫殿。
   * 会话原文里带 NUL 很正常（工具输出 / 文件内容 / 命令 stdout 都可能夹带）。
   */
  describe('正文归一后才发出', () => {
    /** 桩掉传输层，取出发给 mempalace_add_drawer 的实参 */
    async function sentArgs(content: string): Promise<Record<string, unknown>> {
      const bridge = new MemPalaceMcpBridge('C:/fake/python.exe', 'C:/fake/palace')
      const callTool = vi
        .spyOn(bridge, 'callTool')
        .mockResolvedValue({ success: true, drawer_id: 'drawer_ok' })
      await bridge.addDrawer({
        wing: 'conversations',
        room: 'conv-1',
        content,
        addedBy: 'mtbot-windows',
      })
      return callTool.mock.calls[0][1] as Record<string, unknown>
    }

    it('NUL 字节换成 U+FFFD（NUL 会损坏后端 FTS5 索引，殃及整个 collection）', async () => {
      const sent = await sentArgs('前\u0000后')
      expect(sent.content).toBe('前\uFFFD后')
      expect(String(sent.content)).not.toContain('\u0000')
    })

    it('超长正文截断到上限并留说明', async () => {
      const sent = await sentArgs('x'.repeat(120_000))
      expect(String(sent.content)).toHaveLength(100_000)
      expect(String(sent.content).endsWith('[原文过长，此处截断；完整原文在本机会话库]')).toBe(true)
    })

    it('正好 10 万字符不动它（界限内不截断）', async () => {
      const body = 'y'.repeat(100_000)
      const sent = await sentArgs(body)
      expect(sent.content).toBe(body)
    })
  })
})

/**
 * wing/room 必须落在 mempalace 收得下的名字集内，否则 Python 侧 sanitize_name
 * 直接 ValueError（写工具把它当返回值报错），内容一条都进不了宫殿。
 *
 * 线上形态（docs/temp/错误日志.log，2026-09-16）：
 *   [MemPalace] 段归档失败: wing contains invalid characters   ← wing = `${agentId}:${userId}`
 *   [MemPalace] 记忆写入失败: room contains invalid characters ← room = 会话 id
 * 而会话 id 是渠道前缀制：cron:news-pipeline / feishu:ou_… / weixin:…@im.wechat。
 */
describe('toPalaceName 名字归一', () => {
  /** 镜像 Python 侧 mempalace.config._SAFE_NAME_RE：首尾字母数字，中间 `\w .'-` 与空格，≤128 */
  const PY_OK = /^(?:[\p{L}\p{N}]|[\p{L}\p{N}][\p{L}\p{N}_ .'-]{0,126}[\p{L}\p{N}])$/u

  it('渠道前缀会话 id → 合法 room', () => {
    expect(toPalaceName('cron:news-pipeline')).toBe('cron_news-pipeline')
    expect(toPalaceName('feishu:ou_ba9a79349951e82ceac99a505f3e2739')).toBe(
      'feishu_ou_ba9a79349951e82ceac99a505f3e2739',
    )
    expect(toPalaceName('weixin:o9cq8050P6l3M34pqbOwVCesbKag@im.wechat')).toBe(
      'weixin_o9cq8050P6l3M34pqbOwVCesbKag_im_wechat',
    )
  })

  it('段归档的默认 wing（agent:user）→ 合法 wing', () => {
    expect(toPalaceName('assistant:local-user')).toBe('assistant_local-user')
  })

  it('本就合法的名字原样返回（宫殿里别的客户端写的名字不能被改写）', () => {
    const legal = [
      'conversations',
      '2026-09-16',
      '19b3e7cb70a31232aa76cc3082a29a60',
      'my.project',
      "o'brien notes",
      '工作日志',
      ' assistant ', // Python 侧先 strip 再校验，归一也跟着 strip
    ]
    for (const name of legal) {
      expect(PY_OK.test(name.trim())).toBe(true)
      expect(toPalaceName(name)).toBe(name.trim())
    }
  })

  it('归一结果恒满足 mempalace 的名字规则', () => {
    const inputs = [
      'cron:news-pipeline',
      'weixin:o9cq8050P6l3M34pqbOwVCesbKag@im.wechat',
      'a/b\\c',
      '..',
      '-_-',
      ':::',
      ' ',
      '',
      'x'.repeat(200),
      'wing:' + 'a'.repeat(200),
    ]
    for (const input of inputs) {
      const out = toPalaceName(input)
      expect(out.length).toBeGreaterThan(0)
      expect(out.length).toBeLessThanOrEqual(128)
      expect(PY_OK.test(out), `${JSON.stringify(input)} → ${out}`).toBe(true)
    }
  })

  it('超长名截断并接哈希：不同长名不会撞成同一个', () => {
    const a = toPalaceName(`wing:${'a'.repeat(200)}`)
    const b = toPalaceName(`wing:${'a'.repeat(199)}b`)
    expect(a.length).toBe(128)
    expect(a).not.toBe(b)
  })

  it('归一幂等：归一过的名字再归一次不变', () => {
    for (const input of ['weixin:o9cq8050P6l3M34pqbOwVCesbKag@im.wechat', 'cron:news-pipeline', '..']) {
      const once = toPalaceName(input)
      expect(toPalaceName(once)).toBe(once)
    }
  })

  it('只剩符号时退回 fallback', () => {
    expect(toPalaceName(':::', 'unknown')).toBe('unknown')
    expect(toPalaceName('')).toBe('unnamed')
  })
})
