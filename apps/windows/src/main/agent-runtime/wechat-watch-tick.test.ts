/**
 * `wechat-watch` 盯梢循环的行为规格。
 *
 * 这条循环的**唯一价值**是：没事发生时零成本、有事发生时不错过。
 * 所以测试盯死三件事：
 *   1. 没有新消息 → 不通知（否则就是噪声源）；失败 → 不推进水位、不通知（绝不乱报）；
 *   2. 报的是「别人发的、不在忽略名单里」的那些（自己发的不必提醒自己）；
 *   3. 水位一定推进且落库（重启不重复报，也不重复读同一段）。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_WECHAT_WATCH_CONFIG,
  ensureWechatWatchCronJobSeeded,
  formatWechatNotice,
  parseWechatWatchConfig,
  runWechatWatch,
  selectNewMessages,
  WECHAT_WATCH_INSTRUCTION,
  type WechatWatchDeps,
} from './wechat-watch-tick'

function fakeDb(initial: Record<string, string> = {}) {
  const kv = new Map(Object.entries(initial))
  const db = {
    prepare: vi.fn((sql: string) => ({
      get: (key: string) => (kv.has(key) ? { value: kv.get(key) } : undefined),
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT OR REPLACE INTO runtime_state')) {
          kv.set(String(args[0]), String(args[1]))
        }
        return { changes: 1 }
      },
    })),
  }
  return { db: db as never, kv }
}

function deps(over: Partial<WechatWatchDeps> = {}) {
  const { db, kv } = fakeDb()
  const callMcpTool = vi.fn(async () => JSON.stringify({ count: 0, messages: [], next_since_ts: 2000 }))
  const showNotification = vi.fn()
  const d: WechatWatchDeps = {
    getDb: () => db,
    callMcpTool,
    showNotification,
    configPath: 'NUL',
    nowMs: () => 1_800_000,
    ...over,
  }
  return { d, kv, callMcpTool, showNotification }
}

describe('parseWechatWatchConfig', () => {
  it('空/垃圾输入退回默认（盯梢不能因为配置写坏就停）', () => {
    expect(parseWechatWatchConfig(null)).toEqual(DEFAULT_WECHAT_WATCH_CONFIG)
    expect(parseWechatWatchConfig('nope')).toEqual(DEFAULT_WECHAT_WATCH_CONFIG)
    expect(parseWechatWatchConfig({ enabled: 'yes', watch: 'Loop' })).toEqual(
      DEFAULT_WECHAT_WATCH_CONFIG,
    )
  })

  it('只接受类型正确的字段，数组里过滤掉非字符串与空白', () => {
    const cfg = parseWechatWatchConfig({
      enabled: false,
      notify: false,
      watch: ['Loop', '', 42, ' TOOLAN '],
      ignore: ['filehelper', null],
    })
    expect(cfg).toEqual({ enabled: false, notify: false, watch: ['Loop', ' TOOLAN '], ignore: ['filehelper'] })
  })
})

describe('selectNewMessages', () => {
  const msgs = [
    { ts: 1, name: 'Loop', talker: 'wxid_loop', from_me: false },
    { ts: 2, name: '我', talker: 'wxid_me', from_me: true },
    { ts: 3, name: '文件传输助手', talker: 'filehelper', from_me: false },
    { ts: 4, name: '群聊', talker: '123@chatroom', from_me: false },
  ]

  it('只报别人发的，忽略名单优先', () => {
    const out = selectNewMessages(msgs, DEFAULT_WECHAT_WATCH_CONFIG)
    expect(out.map((m) => m.ts)).toEqual([1, 4])
  })

  it('watch 非空 = 白名单（只盯名单里的）', () => {
    const out = selectNewMessages(msgs, { ...DEFAULT_WECHAT_WATCH_CONFIG, watch: ['wxid_loop'] })
    expect(out.map((m) => m.ts)).toEqual([1])
  })

  it('白名单大小写不敏感（talker 与 name 都参与匹配）', () => {
    const out = selectNewMessages(msgs, { ...DEFAULT_WECHAT_WATCH_CONFIG, watch: ['loop'] })
    expect(out.map((m) => m.ts)).toEqual([1])
  })
})

describe('formatWechatNotice', () => {
  it('最多三条，其余折叠', () => {
    const body = formatWechatNotice([
      { ts: 1, name: 'A', text: '一' },
      { ts: 2, name: 'B', text: '二' },
      { ts: 3, name: 'C', text: '三' },
      { ts: 4, name: 'D', text: '四' },
    ])
    expect(body).toBe('A：一\nB：二\nC：三\n…还有 1 条')
  })
})

describe('runWechatWatch', () => {
  it('没有新消息：不通知、水位推进到 next_since_ts', async () => {
    const { d, kv, showNotification } = deps()
    const out = await runWechatWatch(d)
    expect(out).toBe('无新消息')
    expect(showNotification).not.toHaveBeenCalled()
    expect(kv.get('wechat_watch_last_ts')).toBe('2000')
  })

  it('首次运行（无水位）只从现在起看，不翻历史', async () => {
    const { d, callMcpTool } = deps()
    await runWechatWatch(d)
    expect(callMcpTool).toHaveBeenCalledWith('wechat-local', 'poll_new', { since_ts: 1800 })
  })

  it('有新消息：通知正文含名字与内容，水位照推进', async () => {
    const { d, kv, callMcpTool, showNotification } = deps()
    callMcpTool.mockResolvedValueOnce(
      JSON.stringify({
        count: 2,
        messages: [
          { ts: 1990, name: 'Loop', talker: 'wxid_loop', from_me: false, text: '在吗' },
          { ts: 1991, name: '我', talker: 'wxid_me', from_me: true, text: '这条不该报' },
        ],
        next_since_ts: 1991,
      }),
    )
    const out = await runWechatWatch(d)
    expect(showNotification).toHaveBeenCalledWith('微信新消息（1）', 'Loop：在吗')
    expect(out).toContain('新消息 1 条')
    expect(kv.get('wechat_watch_last_ts')).toBe('1991')
  })

  it('poll 失败：不推进水位、不通知（门闩失败=这拍什么都不做）', async () => {
    const { d, kv, callMcpTool, showNotification } = deps({})
    callMcpTool.mockRejectedValueOnce(new Error('MCP request timeout: tools/call'))
    const out = await runWechatWatch(d)
    expect(out).toContain('poll 失败')
    expect(showNotification).not.toHaveBeenCalled()
    expect(kv.has('wechat_watch_last_ts')).toBe(false)
  })

  it('MCP 没装/没连：安静跳过（客户端不依赖微信 MCP）', async () => {
    const { d, kv, callMcpTool, showNotification } = deps({})
    callMcpTool.mockRejectedValueOnce(new Error('MCP Server [wechat-local] 未连接'))
    const out = await runWechatWatch(d)
    expect(out).toContain('未连接')
    expect(out).not.toContain('poll 失败') // 不是"失败"，是"这台机器没这个数据源"
    expect(showNotification).not.toHaveBeenCalled()
    expect(kv.has('wechat_watch_last_ts')).toBe(false)
  })

  it('enabled=false：连 MCP 都不调', async () => {
    const { d, callMcpTool } = deps({ config: { ...DEFAULT_WECHAT_WATCH_CONFIG, enabled: false } })
    const out = await runWechatWatch(d)
    expect(out).toContain('已关闭')
    expect(callMcpTool).not.toHaveBeenCalled()
  })

  it('被过滤掉的消息：不通知，但仍推进水位（否则下一拍重复读同一段）', async () => {
    const { d, kv, callMcpTool, showNotification } = deps()
    callMcpTool.mockResolvedValueOnce(
      JSON.stringify({
        count: 1,
        messages: [
          { ts: 1995, name: '文件传输助手', talker: 'filehelper', from_me: false, text: '自用' },
        ],
        next_since_ts: 1995,
      }),
    )
    const out = await runWechatWatch(d)
    expect(showNotification).not.toHaveBeenCalled()
    expect(out).toContain('均被过滤')
    expect(kv.get('wechat_watch_last_ts')).toBe('1995')
  })
})

describe('ensureWechatWatchCronJobSeeded', () => {
  it('首次播种：agent_id 为 NULL（走确定性处理器、不叫模型）', () => {
    const runs: unknown[][] = []
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: () => undefined,
        run: (...args: unknown[]) => {
          runs.push([sql, ...args])
          return { changes: 1 }
        },
      })),
    }
    ensureWechatWatchCronJobSeeded(db as never, { mcpConfigured: true })
    const insert = runs.find((r) => String(r[0]).includes('INSERT INTO local_cron_jobs'))
    expect(insert).toBeTruthy()
    expect(String(insert![0])).toContain("'every'")
    expect(String(insert![0])).toContain('NULL')
    expect(insert).toContain(WECHAT_WATCH_INSTRUCTION)
    expect(insert).toContain(15_000)
  })

  it('未配置 wechat-local MCP：不建任务（客户端不依赖微信 MCP）', () => {
    const runs: unknown[][] = []
    const db = { prepare: vi.fn(() => ({ get: () => undefined, run: (...a: unknown[]) => { runs.push(a); return { changes: 1 } } })) }
    ensureWechatWatchCronJobSeeded(db as never, { mcpConfigured: false })
    expect(runs).toHaveLength(0)
  })

  it('未配置 MCP 但任务已存在：停掉它，避免任务页里一条永远「未连接」的循环', () => {
    const runs: unknown[][] = []
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: () => ({ id: 'wechat-watch' }),
        run: (...args: unknown[]) => { runs.push([sql, ...args]); return { changes: 1 } },
      })),
    }
    ensureWechatWatchCronJobSeeded(db as never, { mcpConfigured: false })
    expect(String(runs[0][0])).toContain('SET enabled = 0')
  })

  it('已存在：把形态改回来（interval/agent_id/schedule_type）', () => {
    const runs: unknown[][] = []
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: () => ({ id: 'wechat-watch' }),
        run: (...args: unknown[]) => {
          runs.push([sql, ...args])
          return { changes: 1 }
        },
      })),
    }
    ensureWechatWatchCronJobSeeded(db as never, { mcpConfigured: true })
    const upd = runs.find((r) => String(r[0]).includes('UPDATE local_cron_jobs'))
    expect(String(upd![0])).toContain('agent_id = NULL')
    expect(upd).toContain(15_000)
  })
})
