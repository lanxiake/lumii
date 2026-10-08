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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildAutoPrompt,
  buildDraftPrompt,
  cooldownSecondsFor,
  DEFAULT_WECHAT_WATCH_CONFIG,
  ensureWechatWatchConfigFile,
  ensureWechatWatchCronJobSeeded,
  formatWechatNotice,
  loadInstructions,
  parseWechatWatchConfig,
  resolveWatchMode,
  resolveWorkspacePath,
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
    expect(parseWechatWatchConfig({ enabled: 'yes', defaultMode: '随便' })).toEqual(
      DEFAULT_WECHAT_WATCH_CONFIG,
    )
  })

  it('分组：只认合法 mode、peers 为空的组直接丢掉', () => {
    const cfg = parseWechatWatchConfig({
      defaultMode: 'ignore',
      groups: [
        { name: '家人', mode: 'auto', peers: ['妈妈', ''], cooldownSeconds: 30 },
        { name: '空的', mode: 'draft', peers: [] },
        { name: '坏模式', mode: '乱写', peers: ['张三'] },
      ],
    })
    expect(cfg.defaultMode).toBe('ignore')
    expect(cfg.groups).toEqual([
      { name: '家人', mode: 'auto', peers: ['妈妈'], cooldownSeconds: 30 },
      { name: '坏模式', mode: 'notify', peers: ['张三'], cooldownSeconds: undefined },
    ])
  })

  it('v1 兼容：watch 视为一个 notify 分组 + 默认忽略；ignore 即黑名单', () => {
    const cfg = parseWechatWatchConfig({ watch: ['Loop'], ignore: ['filehelper', '某群'], enabled: true })
    expect(cfg.defaultMode).toBe('ignore')
    expect(cfg.groups).toEqual([{ name: '白名单', mode: 'notify', peers: ['Loop'], cooldownSeconds: undefined }])
    expect(cfg.blacklist).toEqual(['filehelper', '某群'])
  })
})

describe('resolveWatchMode / cooldownSecondsFor', () => {
  const cfg = parseWechatWatchConfig({
    defaultMode: 'notify',
    blacklist: ['filehelper'],
    groups: [
      { name: '家人', mode: 'auto', peers: ['妈妈'], cooldownSeconds: 10 },
      { name: '同事', mode: 'draft', peers: ['张三', 'wxid_zhangsan'] },
    ],
  })

  it('黑名单优先于分组；分组按先匹配到的生效；其余走 defaultMode', () => {
    expect(resolveWatchMode({ name: '文件传输助手', talker: 'filehelper' }, cfg).mode).toBe('ignore')
    expect(resolveWatchMode({ name: '妈妈', talker: 'wxid_mama' }, cfg)).toEqual({ mode: 'auto', group: '家人' })
    expect(resolveWatchMode({ name: '张三', talker: 'wxid_zhangsan' }, cfg).mode).toBe('draft')
    // 大小写不敏感：talker 命中
    expect(resolveWatchMode({ talker: 'WXID_ZHANGSAN' }, cfg).mode).toBe('draft')
    expect(resolveWatchMode({ name: '陌生人', talker: 'wxid_x' }, cfg)).toEqual({ mode: 'notify', group: null })
  })

  it('冷却：分组可以自定，没写用默认 60 秒', () => {
    expect(cooldownSecondsFor({ name: '妈妈' }, cfg)).toBe(10)
    expect(cooldownSecondsFor({ name: '张三' }, cfg)).toBe(60)
    expect(cooldownSecondsFor({ name: '陌生人' }, cfg)).toBe(60)
  })
})

describe('selectNewMessages', () => {
  const msgs = [
    { ts: 1, name: 'Loop', talker: 'wxid_loop', from_me: false },
    { ts: 2, name: '我', talker: 'wxid_me', from_me: true },
    { ts: 3, name: '文件传输助手', talker: 'filehelper', from_me: false },
    { ts: 4, name: '群聊', talker: '123@chatroom', from_me: false },
  ]

  it('只处理别人发的；黑名单连提醒都不给', () => {
    const out = selectNewMessages(msgs, DEFAULT_WECHAT_WATCH_CONFIG)
    expect(out.map((m) => m.ts)).toEqual([1, 4])
  })

  it('defaultMode=ignore 时：只有分组里的会话会被处理（=只盯名单）', () => {
    const cfg = parseWechatWatchConfig({
      defaultMode: 'ignore',
      groups: [{ name: '好友', mode: 'notify', peers: ['wxid_loop'] }],
    })
    expect(selectNewMessages(msgs, cfg).map((m) => m.ts)).toEqual([1])
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
    expect(showNotification).toHaveBeenCalledWith('微信新消息（1）', 'Loop：在吗', undefined)
    expect(out).toContain('提醒 1 条')
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

describe('runWechatWatch · 分组策略', () => {
  const cfgAutoLoop = parseWechatWatchConfig({
    defaultMode: 'notify',
    groups: [{ name: '好友', mode: 'auto', peers: ['Loop'], cooldownSeconds: 300 }],
  })
  const incoming = (text: string, ts = 1990) =>
    JSON.stringify({
      count: 1,
      messages: [{ ts, name: 'Loop', talker: 'wxid_loop', from_me: false, text }],
      next_since_ts: ts,
    })

  it('auto 组：回合说发了 → 还要读库确认；库里没有就写「未发」（不替它邀功）', async () => {
    const driveTurn = vi.fn(async () => '已发出：在的')
    const { d, callMcpTool, showNotification } = deps({ config: cfgAutoLoop, driveTurn })
    callMcpTool.mockResolvedValueOnce(incoming('在吗'))
    const out = await runWechatWatch(d)
    expect(driveTurn).toHaveBeenCalledTimes(1)
    const [prompt, meta] = driveTurn.mock.calls[0] as unknown as [string, { mode: string }]
    expect(prompt).toContain('direct' in {} ? '' : 'wxid_loop')
    expect(prompt).toContain('send_text')
    expect(meta.mode).toBe('auto')
    expect(out).toContain('未发') // 库里查不到我的发送 → 不写「已代回」
    const titles = showNotification.mock.calls.map((c) => String(c[0]))
    expect(titles.some((t) => t.includes('已处理'))).toBe(true)
  })

  it('auto 组：库里确实有我发的 → 写「已代回」', async () => {
    const driveTurn = vi.fn(async () => '发好了')
    const { d, callMcpTool } = deps({ config: cfgAutoLoop, driveTurn })
    callMcpTool
      .mockResolvedValueOnce(incoming('在吗'))
      .mockResolvedValueOnce(JSON.stringify({ messages: [{ ts: 1991, name: 'Loop', talker: 'wxid_loop', from_me: true, text: '我回的' }] }))
    const out = await runWechatWatch(d)
    expect(out).toContain('已代回')
  })

  it('用户自己刚回过（from_me）→ 冷却被他占住，auto 不重复代聊', async () => {
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({ config: cfgAutoLoop, driveTurn, nowMs: () => 1_800_000 })
    callMcpTool.mockResolvedValueOnce(JSON.stringify({
      messages: [
        { ts: 1990, name: '我', talker: 'wxid_loop', from_me: true, text: '我自己回了' },
        { ts: 1991, name: 'Loop', talker: 'wxid_loop', from_me: false, text: '他又说了一句' },
      ],
      next_since_ts: 1991,
    }))
    const out = await runWechatWatch(d)
    expect(driveTurn).not.toHaveBeenCalled()
    expect(out).toContain('提醒 1 条')
  })

  it('draft 组：提示词明确「只起草不许发」；回合后若真发了消息，如实加警告', async () => {
    const cfgDraft = parseWechatWatchConfig({
      groups: [{ name: '同事', mode: 'draft', peers: ['Loop'] }],
    })
    const driveTurn = vi.fn(async () => '草稿：在的，稍等')
    const { d, callMcpTool } = deps({ config: cfgDraft, driveTurn })
    // 第一次 poll 给「新消息」，第二次（回合后的自证）给一条 from_me
    callMcpTool
      .mockResolvedValueOnce(incoming('在吗'))
      .mockResolvedValueOnce(
        JSON.stringify({ messages: [{ ts: 1999, name: 'Loop', talker: 'wxid_loop', from_me: true, text: '我发的' }] }),
      )
    const out = await runWechatWatch(d)
    const [prompt] = driveTurn.mock.calls[0] as unknown as [string]
    expect(prompt).toContain('不要发送')
    expect(out).toContain('⚠️')
  })

  it('没有 driveTurn（未接线）：draft/auto 降级为提醒，不出错', async () => {
    const { d, callMcpTool, showNotification } = deps({ config: cfgAutoLoop })
    callMcpTool.mockResolvedValue(incoming('在吗'))
    const out = await runWechatWatch(d)
    expect(out).toContain('提醒 1 条')
    expect(showNotification).toHaveBeenCalled()
  })

  it('冷却期内不重复驱动：第二次只提醒', async () => {
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({ config: cfgAutoLoop, driveTurn, nowMs: () => 1_800_000 })
    callMcpTool.mockResolvedValue(incoming('第一条', 1990))
    await runWechatWatch(d)
    expect(driveTurn).toHaveBeenCalledTimes(1)
    // 同一会话、下一拍（水位推进后）又来一条 → 冷却 300s 未过 → 不再驱动
    callMcpTool.mockResolvedValue(incoming('第二条', 1995))
    const out2 = await runWechatWatch(d)
    expect(driveTurn).toHaveBeenCalledTimes(1)
    expect(out2).toContain('提醒 1 条')
  })
})

describe('手册注入（RUNBOOK）', () => {
  const msg = { ts: 100, name: 'Loop', talker: 'wxid_loop', text: '在吗' }

  it('提示词把手册放在最前（硬约束，不靠模型"记得去读"），触发信息在后', () => {
    const p = buildAutoPrompt(msg, '好友', '【护栏】涉钱不发', 'temp/wx-loop/RUNBOOK.md')
    expect(p.indexOf('【护栏】涉钱不发')).toBeGreaterThanOrEqual(0)
    expect(p.indexOf('【护栏】涉钱不发')).toBeLessThan(p.indexOf('【本次触发】'))
    expect(p).toContain('不要再轮询')
    expect(p).toContain('转人工')
    const d = buildDraftPrompt(msg, '好友', '【护栏】涉钱不发', 'temp/wx-loop/RUNBOOK.md')
    expect(d.indexOf('【护栏】涉钱不发')).toBeLessThan(d.indexOf('【本次触发】'))
    expect(d).toContain('只起草、不要发送')
  })

  it('配置解析认 instructionsFile；没配/手册读不到时提示词照常生成', () => {
    const cfg = parseWechatWatchConfig({
      groups: [{ name: '好友', mode: 'auto', peers: ['Loop'] }],
      instructionsFile: 'temp/wx-loop/RUNBOOK.md',
    })
    expect(cfg.instructionsFile).toBe('temp/wx-loop/RUNBOOK.md')
    expect(buildAutoPrompt(msg, null)).not.toContain('【必须遵守的手册')
    expect(loadInstructions(undefined)).toBe('')
    expect(loadInstructions('不存在的-abc-123.md')).toBe('')
  })

  it('workspace 相对路径按 ~/.lumii/workspace 解析；绝对路径原样', () => {
    expect(resolveWorkspacePath('temp/x.md')).toContain('workspace')
    expect(resolveWorkspacePath('C:/tmp/x.md')).toBe('C:/tmp/x.md')
  })
})

describe('ensureWechatWatchConfigFile', () => {
  it('首次写出默认配置；已存在则不动（用户改过的不许被覆盖）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxwatch-'))
    const p = path.join(dir, 'wechat-watch.json')
    ensureWechatWatchConfigFile(p)
    const first = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(first.enabled).toBe(true)
    expect(first.blacklist).toEqual(['filehelper'])
    expect(typeof first._hint).toBe('string')
    fs.writeFileSync(p, JSON.stringify({ enabled: false, defaultMode: 'ignore' }), 'utf-8')
    ensureWechatWatchConfigFile(p)
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ enabled: false, defaultMode: 'ignore' })
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
